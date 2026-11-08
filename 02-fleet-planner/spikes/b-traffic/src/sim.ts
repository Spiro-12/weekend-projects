// Spike b sim loop: robots (PIBT, one brain or many brains), people as cell agents, simplified work loops, battery,
// deadlock and jam detection, invariant checks and an FNV-1a state hash. Integers only, deterministic.
import type { LayoutFile, PassClass } from '../../../src/contracts/types.ts';
import { buildWorld, Cell, DistanceCache, UNREACHABLE, type World } from '../../../src/sim/world.ts';
import { hash32, scale, stream, type Rng } from '../../../src/sim/rng.ts';
import {
  Agent, LEG_A, LEG_B, LEG_CHARGE, LEG_NONE, PH_CHARGE, PH_DWELL, PH_TRAVEL, S_BLOCKED, S_CHARGE, S_IDLE, S_TRAVEL,
  S_WORK,
} from './agent.ts';
import { CELL_MM, SPECS, TICKS_PER_HOUR, TYPE_IDS, splitByWeights, type RunOpts } from './config.ts';
import { DeadlockTracker, JamTracker } from './detect.ts';
import { CentralController, SiloedController, type TrafficController, type TrafficHost } from './traffic.ts';

const CLASS_IDX: Record<PassClass, number> = { small: 0, forklift: 1, human: 2 };
const CLASS_NAMES: PassClass[] = ['small', 'forklift', 'human'];

interface Pool {
  name: string;
  key: number;
  kind: 'pick' | 'pallet';
  cls: PassClass;
  size: number;
  k: number;
  t1: Int32Array;
  t2: Int32Array;
  d1: Uint16Array[];
}

interface ChargerPool {
  cells: number[];
  /** Index into sim.chargerBusy for each cell. */
  slots: number[];
}

export interface Violations {
  /** Two agents holding the same cell (checked every tick when opts.checks). */
  overlap: number;
  /** occ[] disagreeing with the agents' own cells. */
  occMismatch: number;
  /** A robot starting a move into a cell a person holds. */
  robotIntoPerson: number;
  /** A person starting a move into a cell a robot holds. */
  personIntoRobot: number;
  /** Any move into a held cell (would mean a planner or physical-layer bug). */
  moveIntoHeld: number;
}

export interface RunResult {
  mode: string;
  ticks: number;
  measureHours: number;
  fleet: Record<string, number>;
  tasksPerHour: { robots: number; pickRobots: number; forklifts: number; people: number; all: number; byType: Record<string, number> };
  /** Robot time shares in the measure window, percent. */
  robotStates: Record<string, number>;
  byType: Record<string, Record<string, number>>;
  deadlocks: { count: number; perHour: number; maxTicks: number; meanTicks: number; over2min: number; maxSize: number; activeAtEndTicks: number };
  jams: { starts: number; perHour: number; maxAgents: number };
  resets: number;
  resetsPerHour: number;
  retasksPerHour: number;
  ladder: { detours: number; detourFails: number; randomSteps: number; safetyStops: number; conflictTicks: number; yields: number };
  people: { stepAsides: number; stepAsidesPerHour: number; swaps: number };
  chargeWaits: number;
  charges: number;
  violations: Violations;
  hash: string;
}

export class TrafficSim implements TrafficHost {
  tick = 0;
  readonly world: World;
  readonly cache: DistanceCache;
  readonly agents: Agent[] = [];
  readonly occ: Int32Array;
  readonly ready: Int32Array;
  private order: number[] = [];
  private reached: number[] = [];
  private yields: number[] = [];
  private readonly controller: TrafficController;
  readonly vendors: string[];
  private pools: Pool[] = [];
  private chargerPools: ChargerPool[] = [];
  private chargerBusy: Int32Array;
  private readonly faceCells: number[];
  private readonly faceA: number;
  private readonly forkFaces: number[];
  private readonly forkFaceA: number;
  private readonly packCells: number[];
  private readonly dockCells: number[];
  /** Station index for a pack service cell, else -1. */
  private readonly stationOf: Int32Array;
  private readonly stationLoad: Int32Array;
  private readonly allowedStations: number[][] = [];
  private readonly rngHumans: Rng;
  private readonly rngTie: Rng[];
  private readonly rngLadder: Rng[];
  private readonly rngPhysical: Rng;
  private readonly edge: Int32Array;
  private readonly deadlocks: DeadlockTracker;
  private readonly jams: JamTracker;
  private readonly holdStamp: Int32Array;
  private readonly claim: Int32Array;
  private readonly stateTicks: Float64Array; // integer counts; Float64Array only to avoid 2^31 overflow
  private readonly tasksByType = [0, 0, 0, 0, 0];
  private stepAsides = 0;
  private swaps = 0;
  private retasks = 0;
  private resets = 0;
  private chargeWaits = 0;
  private charges = 0;
  readonly violations: Violations = { overlap: 0, occMismatch: 0, robotIntoPerson: 0, personIntoRobot: 0, moveIntoHeld: 0 };

  constructor(readonly opts: RunOpts, layout: LayoutFile) {
    const w = (this.world = buildWorld(layout));
    this.cache = new DistanceCache(w);
    this.occ = new Int32Array(w.n).fill(-1);
    this.holdStamp = new Int32Array(w.n).fill(-1);
    this.claim = new Int32Array(w.n).fill(-1);
    const seed = opts.seed >>> 0;

    // vendors (robots only), sorted ids
    const vset: string[] = [];
    for (const t of ['amr', 'forklift', 'humanoid'] as const) for (const v of opts.vendors[t] ?? []) if (!vset.includes(v.id)) vset.push(v.id);
    vset.sort();
    this.vendors = vset;
    this.rngTie = vset.map((v) => stream(seed, `tiebreak:${v}`));
    this.rngLadder = vset.map((v) => stream(seed, `ladder:${v}`));
    this.rngHumans = stream(seed, 'humans');
    this.rngPhysical = stream(seed, 'physical');
    const spawn = stream(seed, 'spawn');
    const battery = stream(seed, 'battery');

    // targets
    this.faceCells = w.faces.map((f) => f.cell); // rank order (closest to packing first)
    this.faceA = Math.max(1, Math.floor((this.faceCells.length * 20 + 99) / 100));
    const forkPass = w.passable[CLASS_IDX.forklift];
    this.forkFaces = this.faceCells.filter((c) => forkPass[c]);
    this.forkFaceA = Math.max(1, Math.floor((this.forkFaces.length * 20 + 99) / 100));
    this.packCells = w.packStations.map((s) => s.service);
    this.dockCells = w.docks.map((s) => s.service);
    this.stationOf = new Int32Array(w.n).fill(-1);
    this.packCells.forEach((c, i) => (this.stationOf[c] = i));
    this.stationLoad = new Int32Array(this.packCells.length);

    // agents
    const siloed = opts.mode === 'siloed';
    const counts = opts.fleet;
    const robotVendors: { type: number; vendor: number }[] = [];
    for (let t = 0; t < 3; t++) {
      const typeId = TYPE_IDS[t] as 'amr' | 'forklift' | 'humanoid';
      const shares = opts.vendors[typeId] ?? [];
      const split = splitByWeights(counts[typeId], shares.map((s) => s.pct));
      shares.forEach((s, i) => {
        for (let k = 0; k < split[i]; k++) robotVendors.push({ type: t, vendor: vset.indexOf(s.id) });
      });
    }
    const make = (type: number, vendor: number) => {
      const spec = SPECS[type];
      const cls = CLASS_IDX[spec.cls];
      const pass = w.passable[cls];
      let cell = -1;
      for (let tries = 0; tries < 1_000_000 && cell < 0; tries++) {
        const c = spawn.int(w.n);
        if (pass[c] && !w.isPocket[c] && this.occ[c] < 0) cell = c;
      }
      if (cell < 0) throw new Error('no spawn cell');
      const a = new Agent(this.agents.length, type, spec.robot, vendor, cls, pass, spec.mmPerTick, spec.turnTicks, spec.safetyCells, cell);
      this.occ[cell] = a.id;
      if (spec.robot) {
        a.batteryMax = spec.batteryTicks;
        a.chargePerTick = spec.chargePerTick;
        const pct = opts.work.minStartPct + battery.int(101 - opts.work.minStartPct);
        a.battery = Math.floor((spec.batteryTicks * pct) / 100);
        a.tb = this.rngTie[vendor].u32() >>> 11;
      }
      this.agents.push(a);
      return a;
    };
    for (const rv of robotVendors) make(rv.type, rv.vendor);
    for (let k = 0; k < counts.picker; k++) make(3, -1);
    for (let k = 0; k < counts.driver; k++) make(4, -1);
    this.ready = new Int32Array(this.agents.length).fill(-1);
    this.edge = new Int32Array(this.agents.length).fill(-1);
    this.stateTicks = new Float64Array(5 * 5);

    // pack stations each agent may use (vendor-dedicated blocks in many brains when vendorStations is on)
    const allStations = this.packCells.map((_, i) => i);
    const pickVendors = [...new Set(this.agents.filter((a) => a.robot && SPECS[a.type].work === 'pick').map((a) => a.vendor))].sort((x, y) => x - y);
    const vendorBlock = new Map<number, number[]>();
    if (siloed && opts.work.vendorStations && pickVendors.length > 1) {
      const weights = pickVendors.map((v) => this.agents.filter((a) => a.robot && a.vendor === v).length);
      const split = splitByWeights(allStations.length, weights, 1);
      let off = 0;
      pickVendors.forEach((v, k) => {
        vendorBlock.set(v, allStations.slice(off, off + split[k]));
        off += split[k];
      });
    }
    for (const a of this.agents) this.allowedStations.push((a.robot && vendorBlock.get(a.vendor)) || allStations);

    // job pools: one brain shares one pick pool across vendors; many brains has one per vendor
    const poolIndex = new Map<string, number>();
    const poolFor = (name: string, kind: 'pick' | 'pallet', cls: PassClass) => {
      let i = poolIndex.get(name);
      if (i === undefined) {
        i = this.pools.length;
        poolIndex.set(name, i);
        this.pools.push({ name, key: hashName(name), kind, cls, size: 0, k: 0, t1: new Int32Array(0), t2: new Int32Array(0), d1: [] });
      }
      return i;
    };
    for (const a of this.agents) {
      const spec = SPECS[a.type];
      let name: string;
      if (!a.robot) name = spec.work === 'pick' ? 'people-pick' : 'people-pallet';
      else if (siloed && opts.silo.vendorQueues) name = `${spec.work}:${vset[a.vendor]}`;
      else name = spec.work;
      a.pool = poolFor(name, spec.work, spec.cls);
      this.pools[a.pool].size++;
    }
    for (const p of this.pools) {
      p.size = Math.max(4, p.size * opts.work.poolFactor);
      p.t1 = new Int32Array(p.size);
      p.t2 = new Int32Array(p.size);
      p.d1 = new Array(p.size);
      for (let s = 0; s < p.size; s++) this.genTask(p, s);
    }

    // chargers: shared per class in one brain; split per vendor (by charge demand) in many brains
    this.chargerBusy = new Int32Array(w.chargers.length).fill(-1);
    const byClass = (cls: PassClass) => w.chargers.map((c, i) => ({ c, i })).filter((x) => x.c.forClass === cls);
    const chargerPoolIndex = new Map<string, number>();
    for (const cls of ['small', 'forklift'] as const) {
      const list = byClass(cls);
      const members = this.agents.filter((a) => a.robot && SPECS[a.type].cls === cls);
      if (siloed && opts.silo.vendorChargers) {
        const vs = [...new Set(members.map((a) => a.vendor))].sort((x, y) => x - y);
        const weights = vs.map((v) =>
          members.filter((a) => a.vendor === v).reduce((s, a) => {
            const sp = SPECS[a.type];
            const runH = sp.batteryTicks / TICKS_PER_HOUR;
            const chargeH = Math.floor(sp.batteryTicks / sp.chargePerTick) / TICKS_PER_HOUR;
            return s + Math.floor((1000 * chargeH) / (runH + chargeH));
          }, 0));
        const split = vs.length > 0 ? splitByWeights(list.length, weights, vs.length <= list.length ? 1 : 0) : [];
        let off = 0;
        vs.forEach((v, k) => {
          const slice = list.slice(off, off + split[k]);
          off += split[k];
          chargerPoolIndex.set(`${cls}:${v}`, this.chargerPools.length);
          this.chargerPools.push({ cells: slice.map((x) => x.c.cell), slots: slice.map((x) => x.i) });
        });
      } else {
        chargerPoolIndex.set(cls, this.chargerPools.length);
        this.chargerPools.push({ cells: list.map((x) => x.c.cell), slots: list.map((x) => x.i) });
      }
    }
    for (const a of this.agents) {
      if (!a.robot) continue;
      const cls = SPECS[a.type].cls;
      a.chargerPool = chargerPoolIndex.get(siloed && opts.silo.vendorChargers ? `${cls}:${a.vendor}` : cls) ?? -1;
    }

    // controller
    this.controller = siloed
      ? new SiloedController(this, opts.silo, vset.length, this.rngLadder, this.rngPhysical)
      : new CentralController(this, opts.silo, this.rngLadder);
    this.controller.goalHold = opts.work.goalHold;
    this.deadlocks = new DeadlockTracker(this.agents.length);
    this.jams = new JamTracker(this.agents.length, w);

    // priority order: all robots, tb desc then id
    this.order = this.agents.filter((a) => a.robot).map((a) => a.id);
    this.order.sort((x, y) => this.agents[y].tb - this.agents[x].tb || x - y);

    for (const a of this.agents) this.needTask(a);
  }

  // ───────────── tasks ─────────────
  private skewed(cells: number[], nA: number, u1: number, u2: number): number {
    if (scale(u1, 100) < 80) return cells[scale(u2, nA)];
    return cells[nA + scale(u2, cells.length - nA)];
  }

  private genTask(p: Pool, slot: number): void {
    const seed = this.opts.seed >>> 0;
    const k = p.k++;
    const u1 = hash32(seed, p.key, k, 1);
    const u2 = hash32(seed, p.key, k, 2);
    const u3 = hash32(seed, p.key, k, 3);
    if (p.kind === 'pick') {
      p.t1[slot] = this.skewed(this.faceCells, this.faceA, u1, u2);
      p.t2[slot] = this.packCells[scale(u3, this.packCells.length)];
    } else {
      p.t1[slot] = this.dockCells[scale(u3, this.dockCells.length)];
      p.t2[slot] = this.skewed(this.forkFaces, this.forkFaceA, u1, u2);
    }
    p.d1[slot] = this.cache.to(p.cls, p.t1[slot]);
  }

  private needTask(a: Agent): void {
    a.leg = LEG_NONE;
    a.phase = PH_TRAVEL;
    if (a.robot && a.battery * 100 < this.opts.work.chargeAtPct * a.batteryMax) {
      const cp = this.chargerPools[a.chargerPool];
      let best = -1;
      let bestD = UNREACHABLE;
      if (cp)
        for (let i = 0; i < cp.cells.length; i++) {
          if (this.chargerBusy[cp.slots[i]] >= 0) continue;
          const d = this.cache.to(CLASS_NAMES[a.cls], cp.cells[i])[a.cell];
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      if (best >= 0) {
        a.charger = cp.slots[best];
        this.chargerBusy[a.charger] = a.id;
        a.leg = LEG_CHARGE;
        this.setGoal(a, cp.cells[best]);
        return;
      }
      if (this.tick > this.opts.warmupTicks) this.chargeWaits++;
    }
    const p = this.pools[a.pool];
    let best = 0;
    let bestD = 0x7fffffff;
    for (let s = 0; s < p.size; s++) {
      const d = p.d1[s][a.cell];
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    const g = p.t1[best];
    a.t2 = p.t2[best];
    this.genTask(p, best);
    a.leg = LEG_A;
    this.setGoal(a, g);
  }

  private setGoal(a: Agent, g: number): void {
    a.goal = g;
    a.dist = this.cache.to(CLASS_NAMES[a.cls], g);
    a.bestDist = a.dist[a.cell];
    a.sinceProgress = 0;
    a.blockedSinceProgress = 0;
    a.mark1 = -1;
    a.detourLen = 0;
    if (a.cell === g && a.to < 0) this.reachGoal(a);
  }

  private reachGoal(a: Agent): void {
    a.prog = 0;
    a.goalTick = this.tick;
    a.detourLen = 0;
    a.backoff = 0;
    a.backoffNext = 0;
    a.sinceProgress = 0;
    a.stuckTicks = 0;
    a.blockedSinceProgress = 0;
    a.mark1 = -1;
    if (a.robot) {
      a.tb = this.rngTie[a.vendor].u32() >>> 11;
      if (!this.reached.includes(a.id)) this.reached.push(a.id);
    }
    const w = this.opts.work;
    const pick = SPECS[a.type].work === 'pick';
    if (a.leg === LEG_A) {
      a.phase = PH_DWELL;
      a.dwellLeft = pick ? w.faceDwell : w.dockDwell;
    } else if (a.leg === LEG_B) {
      a.phase = PH_DWELL;
      a.dwellLeft = pick ? w.packDwell : w.putDwell;
    } else if (a.leg === LEG_CHARGE) {
      a.phase = PH_CHARGE;
      if (this.tick > this.opts.warmupTicks) this.charges++;
    }
  }

  /** Pack station for a tote: the task's random station, mapped into the agent's allowed set, or least loaded. */
  private chooseStation(a: Agent, randomCell: number): number {
    const allowed = this.allowedStations[a.id];
    const r = this.stationOf[randomCell];
    let start = 0;
    for (let i = 0; i < allowed.length; i++) if (allowed[i] === r) start = i;
    if (!this.opts.work.balanceStations) {
      return allowed.includes(r) ? r : allowed[r % allowed.length];
    }
    let best = allowed[start];
    for (let k = 1; k < allowed.length; k++) {
      const s = allowed[(start + k) % allowed.length];
      if (this.stationLoad[s] < this.stationLoad[best]) best = s;
    }
    return best;
  }

  private endDwell(a: Agent): void {
    a.phase = PH_TRAVEL;
    if (a.leg === LEG_A && !a.robot && SPECS[a.type].work === 'pick' && !this.opts.work.peoplePack) {
      // pickers who stay in the pick zone: the task ends at the face
      a.tasksDone++;
      if (this.tick > this.opts.warmupTicks) this.tasksByType[a.type]++;
      this.needTask(a);
    } else if (a.leg === LEG_A) {
      a.leg = LEG_B;
      if (SPECS[a.type].work === 'pick') {
        const s = this.chooseStation(a, a.t2);
        this.stationLoad[s]++;
        a.t2 = this.packCells[s];
      }
      this.setGoal(a, a.t2);
    } else {
      if (SPECS[a.type].work === 'pick') this.stationLoad[this.stationOf[a.t2]]--;
      a.tasksDone++;
      if (this.tick > this.opts.warmupTicks) this.tasksByType[a.type]++;
      this.needTask(a);
    }
  }

  private endCharge(a: Agent): void {
    this.chargerBusy[a.charger] = -1;
    a.charger = -1;
    this.needTask(a);
  }

  // ───────────── motion ─────────────
  private arrive(a: Agent): void {
    const occ = this.occ;
    occ[a.cell] = -1;
    if (a.safety >= 0) {
      occ[a.safety] = -1;
      a.safety = -1;
    }
    a.cell = a.to;
    a.to = -1;
    a.prog -= CELL_MM;
    if (a.backoffNext > 0) {
      a.backoff = a.backoffNext;
      a.backoffNext = 0;
    }
    if (a.detourLen > 0 && a.detour[a.detourPos] === a.cell) {
      a.detourPos++;
      if (a.detourPos >= a.detourLen) a.detourLen = 0;
    }
    if (a.goal >= 0 && a.phase === PH_TRAVEL) {
      const d = a.dist![a.cell];
      if (d < a.bestDist) {
        a.bestDist = d;
        a.sinceProgress = 0;
        a.stuckTicks = 0;
        a.blockedSinceProgress = 0;
        a.mark1 = -1;
      }
      if (a.cell === a.goal) this.reachGoal(a);
    }
  }

  private startMove(a: Agent, c: number, s: number, d: number): void {
    const occ = this.occ;
    if (occ[c] >= 0 || (s >= 0 && occ[s] >= 0)) {
      this.violations.moveIntoHeld++;
      const h = occ[c] >= 0 ? occ[c] : occ[s];
      if (a.robot && !this.agents[h].robot) this.violations.robotIntoPerson++;
      if (!a.robot && this.agents[h].robot) this.violations.personIntoRobot++;
      return;
    }
    occ[c] = a.id;
    if (s >= 0) occ[s] = a.id;
    a.to = c;
    a.safety = s;
    const diff = (d - a.heading + 4) & 3;
    const steps = diff === 0 ? 0 : diff === 2 ? 2 : 1;
    a.heading = d;
    if (steps > 0 && a.turnTicks > 0) {
      a.turnLeft = steps * a.turnTicks;
      a.prog = 0;
    }
    a.movedTick = this.tick;
  }

  /** Manual reset (TrafficHost): a person moves the stuck robot to a free cell. */
  teleport(a: Agent, cell: number): void {
    this.occ[a.cell] = -1;
    a.cell = cell;
    this.occ[cell] = a.id;
    a.prog = 0;
    a.turnLeft = 0;
    a.detourLen = 0;
    a.backoff = 0;
    a.backoffNext = 0;
    a.bestDist = a.dist![cell];
    a.sinceProgress = 0;
    a.stuckTicks = 0;
    a.blockedSinceProgress = 0;
    a.mark1 = -1;
    if (this.tick > this.opts.warmupTicks) this.resets++;
    if (cell === a.goal) this.reachGoal(a);
  }

  /** Test hook: put an idle-at-boundary agent on `cell` with a one-leg goal (it dwells there on arrival). */
  placeForTest(a: Agent, cell: number, goal: number): void {
    if (a.to >= 0 || this.occ[cell] >= 0 && this.occ[cell] !== a.id) throw new Error('placeForTest: cell busy');
    this.occ[a.cell] = -1;
    a.cell = cell;
    this.occ[cell] = a.id;
    a.phase = PH_TRAVEL;
    a.dwellLeft = 0;
    if (a.charger >= 0) {
      this.chargerBusy[a.charger] = -1;
      a.charger = -1;
    }
    a.leg = LEG_A;
    a.t2 = goal;
    this.setGoal(a, goal);
  }

  /** Fleet-manager job timeout (TrafficHost): send a robot that made no progress for a while to another target. */
  retask(a: Agent): void {
    let g = -1;
    if (a.leg === LEG_B && SPECS[a.type].work === 'pick') {
      const cur = this.stationOf[a.goal];
      const allowed = this.allowedStations[a.id];
      let best = -1;
      for (const s of allowed) if (s !== cur && (best < 0 || this.stationLoad[s] < this.stationLoad[best])) best = s;
      if (best >= 0) {
        this.stationLoad[cur]--;
        this.stationLoad[best]++;
        a.t2 = this.packCells[best];
        g = a.t2;
      }
    } else if (a.leg === LEG_A) {
      // swap jobs with the nearest other open job in the pool (the old job stays open for someone else)
      const p = this.pools[a.pool];
      let best = -1;
      let bestD = 0x7fffffff;
      for (let s = 0; s < p.size; s++) {
        if (p.t1[s] === a.goal) continue;
        const d = p.d1[s][a.cell];
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best >= 0) {
        const t1 = p.t1[best];
        const t2 = p.t2[best];
        p.t1[best] = a.goal;
        p.t2[best] = a.t2;
        p.d1[best] = this.cache.to(p.cls, a.goal);
        a.t2 = t2;
        g = t1;
      }
    } else if (a.leg === LEG_CHARGE) {
      const cp = this.chargerPools[a.chargerPool];
      for (let i = 0; i < cp.cells.length && g < 0; i++) {
        const slot = cp.slots[i];
        if (this.chargerBusy[slot] >= 0) continue;
        this.chargerBusy[a.charger] = -1;
        this.chargerBusy[slot] = a.id;
        a.charger = slot;
        g = cp.cells[i];
      }
    }
    if (g < 0) return;
    if (this.tick > this.opts.warmupTicks) this.retasks++;
    this.setGoal(a, g);
  }

  private planPeople(): void {
    const w = this.world;
    const occ = this.occ;
    for (const a of this.agents) {
      if (a.robot) continue;
      a.want = -1;
      if (a.to >= 0 || a.phase !== PH_TRAVEL || a.goal < 0 || a.cell === a.goal || a.movedTick === this.tick) continue;
      const D = a.dist!;
      const v = a.cell;
      const dv = D[v];
      // improving neighbours: out of the 1-wide pack lane unless it is the goal, the route heading, then E, S, W, N
      let first = -1;
      let firstKey = 99;
      let free = -1;
      let freeDir = 0;
      let freeKey = 99;
      const hold = this.opts.work.peopleGoalHold && dv >= 2 && occ[a.goal] >= 0;
      const claim = this.claim;
      const now = this.tick;
      for (let d = 0; d < 4; d++) {
        const j = w.nbr[v * 4 + d];
        if (j < 0 || !a.pass[j] || D[j] >= dv || (hold && D[j] === 1)) continue;
        const key = (w.code[j] === Cell.Narrow && j !== a.goal ? 8 : 0) + (d === a.prefHeading ? 0 : 4) + d;
        if (key < firstKey) {
          first = j;
          firstKey = key;
        }
        if (occ[j] < 0 && claim[j] !== now && key < freeKey) {
          free = j;
          freeDir = d;
          freeKey = key;
        }
      }
      a.want = first;
      if (free >= 0) {
        this.startMove(a, free, -1, freeDir);
        a.prefHeading = freeDir;
        a.pBlocked = 0;
        continue;
      }
      // two people head-on squeeze past each other (people can share a 1.5 m cell for a moment; robots can't)
      const h = first >= 0 ? occ[first] : -1;
      if (h >= 0) {
        const q = this.agents[h];
        if (!q.robot && q.to < 0 && q.phase === PH_TRAVEL && q.goal >= 0 && q.cell !== q.goal && q.dist![v] < q.dist![first]) {
          occ[v] = q.id;
          occ[first] = a.id;
          a.cell = first;
          q.cell = v;
          a.prog = 0;
          q.prog = 0;
          a.pBlocked = 0;
          q.pBlocked = 0;
          q.want = -1;
          q.movedTick = this.tick;
          if (this.tick > this.opts.warmupTicks) this.swaps++;
          if (a.cell === a.goal) this.reachGoal(a);
          if (q.cell === q.goal) this.reachGoal(q);
          continue;
        }
      }
      // the agent in the way is already moving out of that cell: wait for it, don't dodge (avoids the sidewalk dance)
      if (h >= 0 && this.agents[h].to >= 0 && this.agents[h].cell === first) continue;
      if (++a.pBlocked < 4) continue;
      // blocked 4 ticks: step aside to a free neighbour. People step to the side of their route first (not back),
      // then closest to the goal, seeded tie-break.
      let n = 0;
      let bestD = 0x7fffffff;
      let pick = -1;
      let pickDir = 0;
      for (let d = 0; d < 4; d++) {
        const j = w.nbr[v * 4 + d];
        if (j < 0 || !a.pass[j] || occ[j] >= 0 || claim[j] === now || D[j] === UNREACHABLE) continue;
        const side = ((d - a.prefHeading + 4) & 1) === 1 ? 0 : 0x10000;
        const key = side + D[j];
        if (key < bestD) {
          bestD = key;
          pick = j;
          pickDir = d;
          n = 1;
        } else if (key === bestD) {
          n++;
          if (this.rngHumans.int(n) === 0) {
            pick = j;
            pickDir = d;
          }
        }
      }
      if (pick >= 0) {
        this.startMove(a, pick, -1, pickDir);
        a.pBlocked = 0;
        if (this.tick > this.opts.warmupTicks) this.stepAsides++;
      }
    }
  }

  // ───────────── tick ─────────────
  step(): void {
    const t = ++this.tick;
    const measuring = t > this.opts.warmupTicks;
    const agents = this.agents;

    // 1. advance moves, dwells, charging, battery
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.to >= 0) {
        if (a.turnLeft > 0) a.turnLeft--;
        else {
          a.prog += a.speed;
          if (a.prog >= CELL_MM) this.arrive(a);
        }
      } else if (a.phase === PH_DWELL) {
        if (--a.dwellLeft <= 0) this.endDwell(a);
      } else if (a.phase === PH_CHARGE) {
        a.battery += a.chargePerTick;
        if (a.battery >= a.batteryMax) {
          a.battery = a.batteryMax;
          this.endCharge(a);
        }
      }
      if (a.robot && a.phase !== PH_CHARGE && a.battery > 0) a.battery--;
    }

    // 2. priority order: robots that reached a goal this tick become the lowest priority
    if (this.reached.length > 0) {
      const r = this.reached;
      const isR = this.edge; // scratch: mark reached
      for (const id of r) isR[id] = -2;
      let k = 0;
      for (let i = 0; i < this.order.length; i++) if (isR[this.order[i]] !== -2) this.order[k++] = this.order[i];
      this.order.length = k;
      r.sort((x, y) => agents[y].tb - agents[x].tb || x - y);
      for (const id of r) {
        this.order.push(id);
        isR[id] = -1;
      }
      r.length = 0;
    }

    // 3. people move first; robots then treat their cells as fixed obstacles
    this.planPeople();

    // 4. robots: traffic controller
    const ready = this.ready;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.robot) continue;
      if (a.to < 0 && a.phase === PH_TRAVEL && a.goal >= 0 && a.cell !== a.goal) {
        ready[i] = t;
        a.want = -1;
        a.planTo = -1;
        a.waitOn = -1;
      }
    }
    const yields = this.yields;
    yields.length = 0;
    for (let i = 0; i < agents.length; i++) {
      const p = agents[i];
      if (p.robot || p.to >= 0 || p.phase !== PH_TRAVEL || p.want < 0) continue;
      const h = this.occ[p.want];
      if (h >= 0 && agents[h].robot && ready[h] === t) yields.push(h, p.cell);
    }
    this.controller.plan({ tick: t, order: this.order, ready, occ: this.occ, yields });
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (ready[i] === t && a.planTo >= 0 && a.to < 0) this.startMove(a, a.planTo, a.planSafety, a.planDir);
    }

    // 5. bookkeeping: states, stuck counters, wait-for edges
    const edge = this.edge;
    const st = this.stateTicks;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      let s: number;
      if (a.phase === PH_CHARGE) s = S_CHARGE;
      else if (a.phase === PH_DWELL) s = S_WORK;
      else if (a.to >= 0) s = S_TRAVEL;
      else if (a.goal < 0 || a.cell === a.goal) s = S_IDLE;
      else s = S_BLOCKED;
      edge[i] = -1;
      if (s === S_BLOCKED) {
        a.prog = 0;
        a.blockedSinceProgress++;
        a.stoppedRun++;
        a.blockedTicks++;
        if (a.backoff > 0) a.backoff--;
        if (a.want >= 0) {
          const h = this.occ[a.want];
          if (h >= 0 && h !== i) edge[i] = h;
          // a robot waiting 3+ ticks claims the cell it wants: people let it go first next tick
          if (a.robot && a.stoppedRun >= 3) this.claim[a.want] = t + 1;
        }
      } else a.stoppedRun = 0;
      if (a.phase === PH_TRAVEL && a.goal >= 0) {
        a.sinceProgress++;
        a.stuckTicks++;
      }
      if (measuring) st[a.type * 5 + s]++;
    }

    // 6. detection
    this.deadlocks.update(t, edge, measuring);
    this.jams.update(agents, measuring);

    // 7. invariants
    if (this.opts.checks) this.check();
  }

  private check(): void {
    const stamp = this.tick;
    const hs = this.holdStamp;
    const occ = this.occ;
    let held = 0;
    for (const a of this.agents) {
      for (let k = 0; k < 3; k++) {
        const c = k === 0 ? a.cell : k === 1 ? a.to : a.safety;
        if (c < 0) continue;
        held++;
        if (hs[c] === stamp) this.violations.overlap++;
        hs[c] = stamp;
        if (occ[c] !== a.id) this.violations.occMismatch++;
      }
    }
    let used = 0;
    for (let i = 0; i < occ.length; i++) if (occ[i] >= 0) used++;
    if (used !== held) this.violations.occMismatch++;
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  // ───────────── results ─────────────
  /** Canonical integer state (throws on any non-integer). */
  stateWords(): number[] {
    const out: number[] = [this.tick];
    for (const a of this.agents) {
      out.push(a.cell, a.to, a.safety, a.prog, a.turnLeft, a.heading, a.prefHeading, a.phase, a.leg, a.goal, a.dwellLeft,
        a.t2, a.tasksDone, a.battery, a.charger, a.goalTick, a.tb, a.bestDist, a.sinceProgress, a.stuckTicks, a.blockedSinceProgress,
        a.mark1, a.mark2, a.backoff, a.backoffNext, a.detourLen, a.detourPos, a.detourUntil, a.pBlocked, a.blockedTicks);
      for (let i = 0; i < a.detourLen; i++) out.push(a.detour[i]);
    }
    for (const p of this.pools) {
      out.push(p.k);
      for (let s = 0; s < p.size; s++) out.push(p.t1[s], p.t2[s]);
    }
    for (let i = 0; i < this.chargerBusy.length; i++) out.push(this.chargerBusy[i]);
    for (let i = 0; i < this.stationLoad.length; i++) out.push(this.stationLoad[i]);
    for (let i = 0; i < this.claim.length; i++) if (this.claim[i] === this.tick + 1) out.push(i);
    for (const id of this.order) out.push(id);
    for (const r of [...this.rngTie, ...this.rngLadder, this.rngHumans, this.rngPhysical]) out.push(...r.state());
    out.push(...this.tasksByType, this.stepAsides, this.swaps, this.retasks, this.resets, this.chargeWaits, this.charges);
    const c = this.controller.counters;
    out.push(c.detours, c.detourFails, c.randomSteps, c.safetyStops, c.resets, c.conflicts, c.yields);
    out.push(...this.deadlocks.state(), this.jams.starts, this.jams.maxAgents);
    for (let i = 0; i < this.stateTicks.length; i++) out.push(this.stateTicks[i]);
    for (const x of out) if (!Number.isSafeInteger(x)) throw new Error(`non-integer state value ${x}`);
    return out;
  }

  /** FNV-1a (32-bit) over the canonical state, 4 bytes per 32-bit half-word pair. */
  hash(): string {
    let h = 0x811c9dc5;
    const words = this.stateWords();
    for (const x of words) {
      const lo = x >>> 0;
      const hi = Math.floor(x / 4294967296) >>> 0;
      for (const v of [lo, hi]) {
        h = Math.imul(h ^ (v & 0xff), 0x01000193);
        h = Math.imul(h ^ ((v >>> 8) & 0xff), 0x01000193);
        h = Math.imul(h ^ ((v >>> 16) & 0xff), 0x01000193);
        h = Math.imul(h ^ (v >>> 24), 0x01000193);
      }
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  result(): RunResult {
    const t = this.tick;
    const mt = Math.max(0, t - this.opts.warmupTicks);
    const hours = mt / TICKS_PER_HOUR;
    const per = (x: number) => (hours > 0 ? x / hours : 0);
    const tb = this.tasksByType;
    const byType: Record<string, Record<string, number>> = {};
    const names = ['travel', 'work', 'blocked', 'idle', 'charge'];
    const robotSum = [0, 0, 0, 0, 0];
    for (let ty = 0; ty < 5; ty++) {
      let tot = 0;
      for (let s = 0; s < 5; s++) tot += this.stateTicks[ty * 5 + s];
      if (tot === 0) continue;
      const rec: Record<string, number> = {};
      for (let s = 0; s < 5; s++) {
        rec[names[s]] = round1((100 * this.stateTicks[ty * 5 + s]) / tot);
        if (ty < 3) robotSum[s] += this.stateTicks[ty * 5 + s];
      }
      byType[TYPE_IDS[ty]] = rec;
    }
    const rs = robotSum.reduce((a, b) => a + b, 0) || 1;
    const robotStates: Record<string, number> = {};
    for (let s = 0; s < 5; s++) robotStates[names[s]] = round1((100 * robotSum[s]) / rs);
    const c = this.controller.counters;
    const dl = this.deadlocks;
    const fleet: Record<string, number> = { ...this.opts.fleet };
    return {
      mode: this.opts.mode,
      ticks: t,
      measureHours: hours,
      fleet,
      tasksPerHour: {
        robots: round1(per(tb[0] + tb[1] + tb[2])),
        pickRobots: round1(per(tb[0] + tb[2])),
        forklifts: round1(per(tb[1])),
        people: round1(per(tb[3] + tb[4])),
        all: round1(per(tb[0] + tb[1] + tb[2] + tb[3] + tb[4])),
        byType: Object.fromEntries(TYPE_IDS.map((id, i) => [id, round1(per(tb[i]))])),
      },
      robotStates,
      byType,
      deadlocks: {
        count: dl.count,
        perHour: round1(per(dl.count)),
        maxTicks: Math.max(dl.maxEnded, dl.longestActive(t)),
        meanTicks: dl.count > 0 ? round1(dl.totalTicks / dl.count) : 0,
        over2min: dl.over2min,
        maxSize: dl.maxSize,
        activeAtEndTicks: dl.longestActive(t),
      },
      jams: { starts: this.jams.starts, perHour: round1(per(this.jams.starts)), maxAgents: this.jams.maxAgents },
      resets: this.resets,
      resetsPerHour: round1(per(this.resets)),
      retasksPerHour: round1(per(this.retasks)),
      ladder: { detours: c.detours, detourFails: c.detourFails, randomSteps: c.randomSteps, safetyStops: c.safetyStops, conflictTicks: c.conflicts, yields: c.yields },
      people: { stepAsides: this.stepAsides, stepAsidesPerHour: round1(per(this.stepAsides)), swaps: this.swaps },
      chargeWaits: this.chargeWaits,
      charges: this.charges,
      violations: { ...this.violations },
      hash: this.hash(),
    };
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function hashName(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
