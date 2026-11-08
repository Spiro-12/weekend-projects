// Track B test harness: a small tick loop in the shape the sim core uses (PROTOCOL §5: people move first, then
// recover(), then plan()), driving any TrafficController on the real layouts. Robots get random goals (a few of them
// pockets), people walk to random goals as moving obstacles in occ and ask robots to make way through `yields`, and
// every planned move is checked against the invariants before it is applied. Not the sim core: no orders, battery
// or work loop. Deterministic (seeded streams, id order).
import agentsJson from '../../../data/agents.json';
import defaultLayout from '../../../data/layouts/default.json';
import type { AgentsFile, AgentTypeId, LayoutFile, PassClass } from '../../../src/contracts/types.ts';
import { DeadlockTracker } from '../../../src/sim/detect.ts';
import { headingOf, mmPerTick, moveTicks, turns } from '../../../src/sim/motion.ts';
import { stream, type Rng } from '../../../src/sim/rng.ts';
import { clearPlan, createPlan, type TrafficAgent, type TrafficController, type TrafficEvent, type TrafficInput, type TrafficPlan } from '../../../src/sim/traffic/types.ts';
import { buildWorld, Cell, classIndex, DistanceCache, PASS_CLASSES, UNREACHABLE, type World } from '../../../src/sim/world.ts';
import { CentralController } from '../../../src/sim/traffic/central/index.ts';

export const TICKS_PER_HOUR = 7200;
const CAPACITY = 512;
const SPECS = new Map((agentsJson as AgentsFile).agents.map((s) => [s.id, s]));

export type RobotType = 'amr' | 'forklift' | 'humanoid';
export type PersonType = 'picker' | 'driver';

export class HAgent {
  readonly robot: boolean;
  readonly passClass: PassClass;
  readonly pass: Uint8Array;
  readonly mm: number;
  readonly turnTicks: number;
  readonly safetyCells: number;
  to = -1;
  safety = -1;
  /** Ticks until arrival while moving. */
  left = 0;
  carry = 0;
  heading = 0;
  prefHeading = 0;
  goal = -1;
  dwell = 0;
  bestDist = 0;
  sinceProgress = 0;
  blockedSinceProgress = 0;
  stoppedRun = 0;
  goalTick = 0;
  tb = 0;
  pBlocked = 0;
  movedTick = -1;
  want = -1;
  /** Placed agents stop at their goal (reachedAt) instead of drawing a new one. */
  oneShot = false;
  /** Ticks left broken down (holds its cell, not ready). */
  broken = 0;
  /** Taken out of the fleet: off the floor, its view is a null hole. */
  removed = false;
  reachedAt = -1;
  goals = 0;
  readonly goalsByHour: number[] = [];
  readonly view: TrafficAgent | null;

  constructor(readonly id: number, readonly type: AgentTypeId, public cell: number, w: World) {
    const spec = SPECS.get(type)!;
    this.robot = spec.kind === 'robot';
    this.passClass = spec.passClass;
    this.pass = w.passable[classIndex(spec.passClass)];
    this.mm = mmPerTick(spec);
    this.turnTicks = spec.turnTicks;
    this.safetyCells = spec.safetyCells;
    this.view = this.robot
      ? { id, vendor: type === 'forklift' ? 'B' : type === 'humanoid' ? 'C' : id % 5 < 3 ? 'A' : 'D', passClass: spec.passClass, cell, heading: 0, goal: -1, safetyCells: spec.safetyCells, turnTicks: spec.turnTicks, sinceProgress: 0, blockedSinceProgress: 0 }
      : null;
  }
}

export interface Violations {
  /** Two agents holding one cell (cells, move targets and safety cells), checked every tick. */
  overlap: number;
  /** occ disagreeing with what the agents hold. */
  occMismatch: number;
  /** A planned move or safety cell that is already held (by anyone). */
  intoHeld: number;
  /** ... held by a person (cell or move target). */
  intoPerson: number;
  /** ... being vacated: held by an agent moving out of it, or the cell of a robot that starts a move this tick. */
  intoVacating: number;
  /** Two robots planned into the same cell (move target or safety cell). */
  conflict: number;
  /** Two robots planned through each other. */
  swap: number;
  /** A forklift-class robot planned onto a '.' cell. */
  forkliftOnNarrow: number;
  /** A pocket entered by a robot whose goal it isn't. */
  pocketNotGoal: number;
  /** Not ready, not a neighbour, not passable, wrong dir, or a missing/extra safety cell. */
  badMove: number;
  /** A ready robot with somewhere to go but no `want`, or a `want` that is not a usable neighbour. */
  wantMissing: number;
  /** A robot that moves somewhere other than its `want`. */
  wantNotMove: number;
}

export interface DeadlockStats {
  started: number;
  ended: number;
  /** Longest finished or still-active deadlock, ticks (from the cycle's first tick). */
  maxTicks: number;
  over2min: number;
  activeAtEnd: number;
}

export interface HarnessOptions {
  layout?: LayoutFile;
  seed?: number;
  robots?: Partial<Record<RobotType, number>>;
  pickers?: number;
  drivers?: number;
  controller?: TrafficController;
  /** Rebuild and compare occupancy every tick. */
  checks?: boolean;
  /** Run the deadlock detector (detect.ts) every tick. */
  detect?: boolean;
  /** Record recover()+plan() wall time per tick (ms). */
  time?: boolean;
  /** Dwell ticks at a goal: [min, max]. */
  dwell?: [number, number];
  /**
   * Where goals are drawn. 'work' (default), like the Phase 1 work model (PROTOCOL §5): robots go to pick faces of
   * their class, `stationPct` percent to the least-loaded pack station (AMRs, humanoids) or dock staging cell
   * (forklifts), `pocketGoalPct` percent to a free pocket; pickers stay in their pick zone (contiguous aisles, split
   * evenly) and walk face to face; drivers go to docks and forklift faces. 'any': any cell of the class for everyone
   * (a harsher stress: robots dwell in cross aisles and the pack lane, people walk everywhere).
   */
  goals?: 'work' | 'any';
  stationPct?: number;
  /** Percent of robot goals that are a free pocket of its class (charger or parking). */
  pocketGoalPct?: number;
  /** Track A's convention: robots dwelling or idle at their goal are `ready` with goal = their cell, so the planner may
   *  push them aside. Pushed off mid-dwell, a robot drives back and resumes its dwell. */
  parkedReady?: boolean;
  /** Every this many ticks a random robot at a cell boundary breaks down for 120..599 ticks (holds its cell). */
  breakdownEvery?: number;
  /** Every this many ticks a random robot at a cell boundary leaves the fleet (its view becomes a null hole) and a new
   *  one joins at a free cell; every third time two join (the fleet grows). */
  churnEvery?: number;
  /** Fold every plan output into `digest` (determinism). */
  digest?: boolean;
  /** Called with each tick's input just before recover() (the input object is reused: copy what you keep). */
  onRecover?: (input: TrafficInput) => void;
  /** Called with each tick's input (after resets were applied) and output, after plan(). */
  onPlan?: (input: TrafficInput, out: TrafficPlan, resets: { agent: number; cell: number }[]) => void;
}

export class Harness {
  readonly world: World;
  readonly dist: DistanceCache;
  readonly occ: Int32Array;
  readonly agents: HAgent[] = [];
  readonly views: (TrafficAgent | null)[] = [];
  readonly ready = new Int32Array(CAPACITY).fill(-1);
  readonly out: TrafficPlan = createPlan(CAPACITY);
  readonly controller: TrafficController;
  readonly violations: Violations = { overlap: 0, occMismatch: 0, intoHeld: 0, intoPerson: 0, intoVacating: 0, conflict: 0, swap: 0, forkliftOnNarrow: 0, pocketNotGoal: 0, badMove: 0, wantMissing: 0, wantNotMove: 0 };
  readonly deadlock: DeadlockStats = { started: 0, ended: 0, maxTicks: 0, over2min: 0, activeAtEnd: 0 };
  readonly events: Record<TrafficEvent['t'], number> = { detour: 0, stepAside: 0, safetyStop: 0, yield: 0 };
  resets = 0;
  moves = 0;
  personMoves = 0;
  stepAsides = 0;
  tick = 0;
  digest = 0x811c9dc5;
  plannerMs: number[] = [];
  private order: number[] = [];
  private yields: number[] = [];
  private readonly claim: Int32Array;
  private readonly held: Int32Array;
  private readonly targetStamp: Int32Array;
  private readonly pocketBy: Int32Array;
  private readonly goalCells: number[][];
  private readonly faceCells: number[][];
  private readonly stationCells: number[][];
  private readonly pockets: number[][];
  /** Pick-zone faces per picker id. */
  private readonly zones = new Map<number, number[]>();
  private readonly aisles: number;
  private pickersSpawned = 0;
  private readonly rng: Rng;
  private readonly rngPeople: Rng;
  private readonly rngTie: Rng;
  private readonly tracker = new DeadlockTracker();
  private readonly waitFor = new Int32Array(CAPACITY).fill(-1);
  private readonly opts: HarnessOptions;
  private heldCount = 0;
  private mixTypes: AgentTypeId[] = [];

  constructor(opts: HarnessOptions = {}) {
    this.opts = opts;
    const w = (this.world = buildWorld(opts.layout ?? (defaultLayout as LayoutFile)));
    this.dist = new DistanceCache(w);
    this.occ = new Int32Array(w.n).fill(-1);
    this.claim = new Int32Array(w.n).fill(-1);
    this.held = new Int32Array(w.n).fill(-1);
    this.targetStamp = new Int32Array(w.n).fill(-1);
    this.pocketBy = new Int32Array(w.n).fill(-1);
    this.controller = opts.controller ?? new CentralController();
    const seed = opts.seed ?? 1;
    this.rng = stream(seed, 'harness');
    this.rngPeople = stream(seed, 'humans');
    this.rngTie = stream(seed, 'tiebreak');
    this.goalCells = w.passable.map((p) => {
      const cells: number[] = [];
      for (let i = 0; i < w.n; i++) if (p[i] && !w.isPocket[i]) cells.push(i);
      return cells;
    });
    this.faceCells = w.passable.map((p) => w.faces.map((f) => f.cell).filter((c) => p[c]).sort((a, b) => a - b));
    const pack = w.packStations.map((st) => st.service);
    const docks = w.docks.map((st) => st.service);
    this.stationCells = PASS_CLASSES.map((cls) => (cls === 'forklift' ? docks : pack).filter((c) => w.passable[classIndex(cls)][c]));
    this.pockets = w.passable.map(() => []);
    for (const p of [...w.chargers, ...w.parking].sort((a, b) => a.cell - b.cell)) this.pockets[classIndex(p.forClass)].push(p.cell);
    this.aisles = w.faces.reduce((m, f) => Math.max(m, f.aisle + 1), 0);

    const r = opts.robots ?? {};
    const spawn = (type: AgentTypeId, k: number) => {
      for (let i = 0; i < k; i++) {
        const a = this.spawnOne(type);
        if (type === 'picker') {
          // picker k of K: aisles [floor(k A / K), floor((k + 1) A / K)), at least one
          const K = opts.pickers ?? 1;
          const k = this.pickersSpawned++;
          const lo = Math.floor((k * this.aisles) / K);
          const hi = Math.max(lo + 1, Math.floor(((k + 1) * this.aisles) / K));
          this.zones.set(a.id, w.faces.filter((f) => f.aisle >= lo && f.aisle < hi).map((f) => f.cell).sort((x, y) => x - y));
        }
        this.newGoal(a);
      }
    };
    this.mixTypes = [...Array(r.amr ?? 0).fill('amr'), ...Array(r.forklift ?? 0).fill('forklift'), ...Array(r.humanoid ?? 0).fill('humanoid')];
    spawn('amr', r.amr ?? 0);
    spawn('forklift', r.forklift ?? 0);
    spawn('humanoid', r.humanoid ?? 0);
    spawn('picker', opts.pickers ?? 0);
    spawn('driver', opts.drivers ?? 0);
  }

  // ───────────── agents ─────────────

  private spawnOne(type: AgentTypeId): HAgent {
    const cells = this.goalCells[classIndex(SPECS.get(type)!.passClass)];
    let c = -1;
    for (let tries = 0; tries < 100000 && c < 0; tries++) {
      const x = cells[this.rng.int(cells.length)];
      if (this.occ[x] < 0) c = x;
    }
    if (c < 0) throw new Error('no free spawn cell');
    const a = this.add(type, c);
    a.heading = this.rng.int(4);
    return a;
  }

  /** Breakdowns and fleet churn (options), at the start of a tick. */
  private floorEvents(t: number): void {
    const be = this.opts.breakdownEvery ?? 0;
    if (be > 0 && t % be === 0) {
      const a = this.pickIdleRobot();
      if (a) a.broken = 120 + this.rng.int(480);
    }
    const ce = this.opts.churnEvery ?? 0;
    if (ce > 0 && t % ce === 0) {
      const a = this.pickIdleRobot();
      if (a) {
        if (this.pocketBy[a.cell] === a.id) this.pocketBy[a.cell] = -1;
        if (a.goal >= 0 && this.pocketBy[a.goal] === a.id) this.pocketBy[a.goal] = -1;
        this.clearOcc(a.cell);
        a.removed = true;
        this.views[a.id] = null;
        this.ready[a.id] = -1;
      }
      const joins = (t / ce) % 3 === 0 ? 2 : 1;
      for (let k = 0; k < joins && this.mixTypes.length > 0 && this.agents.length < CAPACITY; k++) {
        const n = this.spawnOne(this.mixTypes[this.rng.int(this.mixTypes.length)]);
        n.goalTick = t;
        this.newGoal(n);
      }
    }
  }

  /** A random robot at a cell boundary (not moving, broken or removed), or null. */
  private pickIdleRobot(): HAgent | null {
    const n = this.agents.length;
    for (let k = 0, s = this.rng.int(n); k < n; k++) {
      const a = this.agents[(s + k) % n];
      if (a.robot && !a.removed && a.broken === 0 && a.to < 0) return a;
    }
    return null;
  }

  private add(type: AgentTypeId, cell: number): HAgent {
    if (this.agents.length >= CAPACITY) throw new Error('harness capacity');
    if (this.occ[cell] >= 0) throw new Error(`cell ${cell} busy`);
    const a = new HAgent(this.agents.length, type, cell, this.world);
    this.agents.push(a);
    this.views.push(a.view);
    this.setOcc(cell, a.id);
    return a;
  }

  /** Place a one-shot agent: it walks to `goal` and stays there (reachedAt = arrival tick). */
  place(type: AgentTypeId, cell: number, goal: number, heading = 0, goalTick?: number): HAgent {
    const a = this.add(type, cell);
    a.heading = heading;
    a.prefHeading = heading;
    a.oneShot = true;
    this.setGoal(a, goal);
    // Priority is oldest goal first: an earlier goalTick puts this robot ahead of the others.
    if (goalTick !== undefined) a.goalTick = goalTick;
    return a;
  }

  private setOcc(c: number, id: number): void {
    if (this.occ[c] < 0) this.heldCount++;
    this.occ[c] = id;
  }

  private clearOcc(c: number): void {
    if (this.occ[c] >= 0) this.heldCount--;
    this.occ[c] = -1;
  }

  private setGoal(a: HAgent, g: number): void {
    a.goal = g;
    a.bestDist = g >= 0 ? this.dist.to(a.passClass, g)[a.cell] : 0;
    a.sinceProgress = 0;
    a.blockedSinceProgress = 0;
    a.goalTick = this.tick;
    a.tb = this.rngTie.u32() >>> 11;
    if (g >= 0 && a.cell === g) this.reach(a);
  }

  private newGoal(a: HAgent): void {
    const ci = classIndex(a.passClass);
    let g = -1;
    const pct = this.opts.pocketGoalPct ?? 0;
    if (a.robot && pct > 0 && this.rng.int(100) < pct) {
      const list = this.pockets[ci];
      for (let k = 0, s = list.length ? this.rng.int(list.length) : 0; k < list.length && g < 0; k++) {
        const c = list[(s + k) % list.length];
        if (this.pocketBy[c] < 0 && this.occ[c] < 0) g = c;
      }
      if (g >= 0) this.pocketBy[g] = a.id;
    }
    if (g < 0) {
      let cells = this.goalCells[ci];
      if ((this.opts.goals ?? 'work') === 'work') {
        const st = this.stationCells[ci];
        const zone = this.zones.get(a.id);
        if (zone && zone.length > 0) cells = zone;
        else if (st.length > 0 && this.rng.int(100) < (this.opts.stationPct ?? 20)) g = this.leastLoaded(st);
        else cells = this.faceCells[ci];
      }
      if (g < 0) g = cells[this.rng.int(cells.length)];
    }
    this.setGoal(a, g);
  }

  /** PROTOCOL §5 rule 8: the WMS sends each trip to the least-loaded station (fewest agents heading there or in it),
   *  ties from a random start. */
  private leastLoaded(cells: number[]): number {
    const start = this.rng.int(cells.length);
    let best = -1;
    let bestLoad = 0x7fffffff;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[(start + k) % cells.length];
      let load = 0;
      for (const b of this.agents) if (!b.removed && (b.goal === c || (b.cell === c && b.dwell > 0))) load++;
      if (load < bestLoad) {
        best = c;
        bestLoad = load;
      }
    }
    return best;
  }

  private reach(a: HAgent): void {
    a.goals++;
    const h = Math.floor(this.tick / TICKS_PER_HOUR);
    while (a.goalsByHour.length <= h) a.goalsByHour.push(0);
    a.goalsByHour[h]++;
    if (a.oneShot) {
      if (a.reachedAt < 0) a.reachedAt = this.tick;
      if (!(a.robot && this.opts.parkedReady)) a.goal = -1;
      return;
    }
    const [lo, hi] = this.opts.dwell ?? [4, 20];
    a.dwell = lo + this.rng.int(hi - lo + 1);
  }

  private startMove(a: HAgent, c: number, s: number, d: number): void {
    this.setOcc(c, a.id);
    if (s >= 0) this.setOcc(s, a.id);
    a.to = c;
    a.safety = s;
    const t = turns(a.heading as 0, d as 0);
    const m = moveTicks(a.carry, a.mm, t * a.turnTicks, t > 0);
    a.left = m.ticks;
    a.carry = m.carryMm;
    a.heading = d;
    a.movedTick = this.tick;
  }

  private arrive(a: HAgent): void {
    const old = a.cell;
    this.clearOcc(old);
    if (a.safety >= 0) this.clearOcc(a.safety);
    a.safety = -1;
    a.cell = a.to;
    a.to = -1;
    if (this.world.isPocket[old] && this.pocketBy[old] === a.id && a.goal !== old) this.pocketBy[old] = -1;
    if (a.goal >= 0) {
      const d = this.dist.to(a.passClass, a.goal)[a.cell];
      if (old === a.goal) a.bestDist = d; // pushed off its goal (parked robots): measure progress from here
      if (d < a.bestDist) {
        a.bestDist = d;
        a.sinceProgress = 0;
        a.blockedSinceProgress = 0;
      }
      if (a.cell === a.goal) {
        if (a.dwell > 0 || (a.oneShot && a.reachedAt >= 0)) {
          // back at the goal it was pushed off: resume
          a.sinceProgress = 0;
          a.blockedSinceProgress = 0;
        } else this.reach(a);
      }
    }
  }

  // ───────────── people (PROTOCOL §5 rules 1 to 4, simplified from spike b) ─────────────

  private safetyFree(a: HAgent, c: number, d: number): number {
    if (a.safetyCells <= 0) return -1;
    const s = this.world.nbr[c * 4 + d];
    if (s < 0) return -1;
    let open = 0;
    for (const p of this.world.passable) open |= p[s];
    if (!open) return -1;
    return this.occ[s] < 0 && this.claim[s] !== this.tick ? s : -2;
  }

  private movePeople(): void {
    const w = this.world;
    const occ = this.occ;
    for (const a of this.agents) {
      if (a.robot) continue;
      a.want = -1;
      if (a.to >= 0 || a.dwell > 0 || a.goal < 0 || a.cell === a.goal || a.movedTick === this.tick) continue;
      const D = this.dist.to(a.passClass, a.goal);
      const v = a.cell;
      const dv = D[v];
      let first = -1;
      let firstKey = 99;
      let free = -1;
      let freeDir = 0;
      let freeSafety = -1;
      let freeKey = 99;
      for (let d = 0; d < 4; d++) {
        const j = w.nbr[v * 4 + d];
        if (j < 0 || !a.pass[j] || w.isPocket[j] || D[j] >= dv) continue;
        const key = (d === a.prefHeading ? 0 : 4) + d;
        if (key < firstKey) {
          first = j;
          firstKey = key;
        }
        const s = this.safetyFree(a, j, d);
        if (occ[j] < 0 && this.claim[j] !== this.tick && s !== -2 && key < freeKey) {
          free = j;
          freeDir = d;
          freeSafety = s;
          freeKey = key;
        }
      }
      a.want = first;
      if (free >= 0) {
        this.startMove(a, free, freeSafety, freeDir);
        a.prefHeading = freeDir;
        a.pBlocked = 0;
        this.personMoves++;
        continue;
      }
      a.carry = 0;
      const h = first >= 0 ? occ[first] : -1;
      const q = h >= 0 ? this.agents[h] : null;
      // two people on foot head-on squeeze past each other
      if (q && a.type === 'picker' && q.type === 'picker' && q.to < 0 && q.dwell === 0 && q.goal >= 0 && q.cell !== q.goal) {
        const Dq = this.dist.to(q.passClass, q.goal);
        if (Dq[v] < Dq[first]) {
          occ[v] = q.id;
          occ[first] = a.id;
          a.cell = first;
          q.cell = v;
          a.pBlocked = 0;
          q.pBlocked = 0;
          q.want = -1;
          q.movedTick = this.tick;
          for (const x of [a, q]) {
            const dx = this.dist.to(x.passClass, x.goal)[x.cell];
            if (dx < x.bestDist) x.bestDist = dx;
            if (x.cell === x.goal) this.reach(x);
          }
          continue;
        }
      }
      // the agent in the way is already leaving: wait for it
      if (q && q.to >= 0 && q.cell === first) continue;
      if (++a.pBlocked < 4) continue;
      // step aside: to the side of the route first, then closer to the goal, seeded tie-break
      let n = 0;
      let bestKey = 0x7fffffff;
      let pick = -1;
      let pickDir = 0;
      let pickSafety = -1;
      for (let d = 0; d < 4; d++) {
        const j = w.nbr[v * 4 + d];
        if (j < 0 || !a.pass[j] || w.isPocket[j] || occ[j] >= 0 || this.claim[j] === this.tick || D[j] === UNREACHABLE) continue;
        const s = this.safetyFree(a, j, d);
        if (s === -2) continue;
        const key = (((d - a.prefHeading + 4) & 1) === 1 ? 0 : 0x10000) + D[j];
        if (key < bestKey) {
          bestKey = key;
          pick = j;
          pickDir = d;
          pickSafety = s;
          n = 1;
        } else if (key === bestKey && this.rngPeople.int(++n) === 0) {
          pick = j;
          pickDir = d;
          pickSafety = s;
        }
      }
      if (pick >= 0) {
        this.startMove(a, pick, pickSafety, pickDir);
        a.pBlocked = 0;
        this.stepAsides++;
        this.personMoves++;
      }
    }
  }

  // ───────────── the tick ─────────────

  step(): void {
    const t = ++this.tick;
    const agents = this.agents;
    const occ = this.occ;

    // 0. breakdowns and fleet churn
    this.floorEvents(t);

    // 1. moves, dwells (a robot pushed off its goal mid-dwell drives back first)
    for (const a of agents) {
      if (a.removed) continue;
      if (a.broken > 0) {
        a.broken--;
        continue;
      }
      if (a.to >= 0) {
        if (--a.left <= 0) this.arrive(a);
      } else if (a.dwell > 0 && a.cell === a.goal && --a.dwell === 0) {
        if (!a.oneShot) this.newGoal(a);
      }
    }

    // 2. people move first
    this.movePeople();

    // 3. ready robots, views, priority (oldest goal first, then tie-break, then id)
    const ready = this.ready;
    const order = this.order;
    order.length = 0;
    const parkedReady = !!this.opts.parkedReady;
    for (const a of agents) {
      if (!a.robot || a.removed) continue;
      order.push(a.id);
      if (a.to < 0 && a.broken === 0 && a.goal >= 0 && (a.cell !== a.goal || parkedReady)) ready[a.id] = t;
      this.refreshView(a);
    }
    order.sort((x, y) => agents[x].goalTick - agents[y].goalTick || agents[y].tb - agents[x].tb || x - y);

    // 4. yields: a blocked person asks the ready robot in its way to make room
    const yields = this.yields;
    yields.length = 0;
    for (const p of agents) {
      if (p.robot || p.to >= 0 || p.want < 0) continue;
      const h = occ[p.want];
      if (h >= 0 && agents[h].robot && !agents[h].removed && ready[h] === t) yields.push(h, p.cell);
    }

    const input: TrafficInput = { tick: t, world: this.world, dist: this.dist, agents: this.views, order, ready, occ, yields };
    const t0 = this.opts.time ? performance.now() : 0;
    // 5. recover: resets applied before planning
    this.opts.onRecover?.(input);
    const rec = this.controller.recover(input);
    for (const r of rec.resets) {
      const a = agents[r.agent];
      if (!a || !a.robot || a.to >= 0 || occ[r.cell] >= 0 || !a.pass[r.cell] || this.world.isPocket[r.cell]) {
        this.violations.badMove++;
        continue;
      }
      this.clearOcc(a.cell);
      a.cell = r.cell;
      this.setOcc(r.cell, a.id);
      a.carry = 0;
      a.bestDist = this.dist.to(a.passClass, a.goal)[a.cell];
      a.sinceProgress = 0;
      a.blockedSinceProgress = 0;
      this.resets++;
      this.refreshView(a);
      if (a.cell === a.goal) {
        ready[a.id] = -1;
        this.reach(a);
      }
    }
    // 6. plan
    const out = this.out;
    clearPlan(out);
    this.controller.plan(input, out);
    if (this.opts.time) this.plannerMs.push(performance.now() - t0);
    this.opts.onPlan?.(input, out, rec.resets);
    if (this.opts.digest) this.fold(out, rec.resets);
    for (const e of out.events) this.events[e.t]++;
    this.applyPlan(t);

    // 7. bookkeeping: blocked counters, robot cell claims, wait-for graph
    const wf = this.waitFor;
    for (const a of agents) {
      wf[a.id] = -1;
      if (a.removed || a.broken > 0) continue;
      if (a.to >= 0 || a.goal < 0 || a.cell === a.goal) {
        a.stoppedRun = 0;
        if (a.to >= 0 && a.goal >= 0) a.sinceProgress++;
        continue;
      }
      a.sinceProgress++;
      a.blockedSinceProgress++;
      a.stoppedRun++;
      a.carry = 0;
      const want = a.robot ? (ready[a.id] === t ? out.want[a.id] : -1) : a.want;
      if (want >= 0) {
        const h = occ[want];
        if (h >= 0 && h !== a.id) wf[a.id] = h;
        if (a.robot && a.stoppedRun >= 3) this.claim[want] = t + 1;
      }
    }
    if (this.opts.detect) this.detect(t);
    if (this.opts.checks) this.check();
  }

  private refreshView(a: HAgent): void {
    const v = a.view!;
    v.cell = a.cell;
    v.heading = a.heading;
    v.goal = a.goal;
    v.sinceProgress = a.sinceProgress;
    v.blockedSinceProgress = a.blockedSinceProgress;
  }

  /** Check every planned move against the invariants, then apply the valid ones. */
  private applyPlan(t: number): void {
    const w = this.world;
    const occ = this.occ;
    const out = this.out;
    const ts = this.targetStamp;
    const V = this.violations;
    const movers: HAgent[] = [];
    for (const a of this.agents) {
      if (a.robot && !a.removed && this.ready[a.id] === t) this.checkWant(a);
      const c = out.moveTo[a.id];
      if (c < 0) {
        if (out.safety[a.id] >= 0 || out.dir[a.id] >= 0) V.badMove++;
        continue;
      }
      let bad = false;
      const d = out.dir[a.id];
      if (!a.robot || this.ready[a.id] !== t || a.to >= 0) bad = true;
      else {
        const v = a.cell;
        const adjacent = w.nbr[v * 4] === c || w.nbr[v * 4 + 1] === c || w.nbr[v * 4 + 2] === c || w.nbr[v * 4 + 3] === c;
        if (!adjacent || !a.pass[c] || d !== headingOf(v, c, w.width)) bad = true;
        if (a.passClass === 'forklift' && w.code[c] === Cell.Narrow) {
          V.forkliftOnNarrow++;
          bad = true;
        }
        if (w.isPocket[c] && c !== a.goal) {
          V.pocketNotGoal++;
          bad = true;
        }
        // expected safety cell: the open cell ahead of the target (forklift-class robots)
        let want = -1;
        if (a.safetyCells > 0 && !bad) {
          const s = w.nbr[c * 4 + d];
          let open = 0;
          if (s >= 0) for (const p of w.passable) open |= p[s];
          if (s >= 0 && open) want = s;
        }
        if (out.safety[a.id] !== want) bad = true;
      }
      if (bad) {
        V.badMove++;
        continue;
      }
      for (const x of [c, out.safety[a.id]]) {
        if (x < 0) continue;
        const h = occ[x];
        if (h >= 0) {
          V.intoHeld++;
          bad = true;
          const b = this.agents[h];
          if (!b.robot) V.intoPerson++;
          if (b.cell === x && (b.to >= 0 || out.moveTo[h] >= 0)) V.intoVacating++;
        }
        if (ts[x] === t) {
          V.conflict++;
          bad = true;
        }
        ts[x] = t;
      }
      const h = occ[c];
      if (h >= 0 && out.moveTo[h] === a.cell) V.swap++;
      if (!bad) movers.push(a);
    }
    for (const a of movers) {
      this.startMove(a, out.moveTo[a.id], out.safety[a.id], out.dir[a.id]);
      this.moves++;
    }
  }

  /** A ready robot reports a usable neighbour as `want` whenever it has one, and moves only to its `want`. */
  private checkWant(a: HAgent): void {
    const w = this.world;
    const D = this.dist.to(a.passClass, a.goal);
    const usable = (j: number) => j >= 0 && a.pass[j] === 1 && (!w.isPocket[j] || j === a.goal) && D[j] !== UNREACHABLE;
    let any = false;
    for (let d = 0; d < 4; d++) if (usable(w.nbr[a.cell * 4 + d])) any = true;
    const want = this.out.want[a.id];
    const adjacent = want >= 0 && [0, 1, 2, 3].some((d) => w.nbr[a.cell * 4 + d] === want);
    if (any && (!adjacent || !usable(want))) this.violations.wantMissing++;
    const m = this.out.moveTo[a.id];
    if (m >= 0 && m !== want) this.violations.wantNotMove++;
  }

  private fold(out: TrafficPlan, resets: { agent: number; cell: number }[]): void {
    let h = this.digest;
    const mix = (x: number) => {
      h = Math.imul(h ^ (x & 0xffff), 0x01000193);
      h = Math.imul(h ^ (x >>> 16), 0x01000193);
    };
    mix(this.tick);
    for (let i = 0; i < this.agents.length; i++) {
      mix(out.moveTo[i]);
      mix(out.safety[i]);
      mix(out.dir[i]);
      mix(out.want[i]);
    }
    for (const e of out.events) {
      mix(e.t.length);
      mix(e.agent);
      mix(e.cell);
    }
    for (const r of resets) {
      mix(r.agent);
      mix(r.cell);
    }
    this.digest = h >>> 0;
  }

  private detect(t: number): void {
    const n = this.agents.length;
    const { started, ended } = this.tracker.update(t, this.waitFor.subarray(0, n));
    this.deadlock.started += started.length;
    for (const d of ended) {
      this.deadlock.ended++;
      const len = t - d.sinceTick;
      if (len > this.deadlock.maxTicks) this.deadlock.maxTicks = len;
      if (len > 240) this.deadlock.over2min++;
    }
  }

  /** Close the books on still-active deadlocks (call at the end of a run). */
  finishDeadlocks(): DeadlockStats {
    const active = this.tracker.active();
    this.deadlock.activeAtEnd = active.length;
    for (const d of active) {
      const len = this.tick - d.sinceTick;
      if (len > this.deadlock.maxTicks) this.deadlock.maxTicks = len;
      if (len > 240) this.deadlock.over2min++;
    }
    return this.deadlock;
  }

  /** Every held cell belongs to exactly one agent and occ agrees with every agent. */
  private check(): void {
    const t = this.tick;
    const held = this.held;
    let count = 0;
    for (const a of this.agents) {
      if (a.removed) continue;
      for (const c of [a.cell, a.to, a.safety]) {
        if (c < 0) continue;
        count++;
        if (held[c] === t) this.violations.overlap++;
        held[c] = t;
        if (this.occ[c] !== a.id) this.violations.occMismatch++;
      }
    }
    if (count !== this.heldCount) this.violations.occMismatch++;
  }

  run(ticks: number): this {
    for (let i = 0; i < ticks; i++) this.step();
    return this;
  }

  /** Run until every one-shot agent reached its goal, or maxTicks. Returns the ticks used. */
  runUntilReached(maxTicks: number): number {
    for (let i = 0; i < maxTicks; i++) {
      if (this.agents.every((a) => !a.oneShot || a.reachedAt >= 0)) return i;
      this.step();
    }
    return maxTicks;
  }

  robots(): HAgent[] {
    return this.agents.filter((a) => a.robot && !a.removed);
  }
}

/** The default scenario's robot mix (24 AMRs, 4 forklifts, 2 humanoids per 30 robots), scaled. */
export function mix(robots: number): { amr: number; forklift: number; humanoid: number } {
  const forklift = Math.round((robots * 4) / 30);
  const humanoid = Math.round((robots * 2) / 30);
  return { amr: robots - forklift - humanoid, forklift, humanoid };
}

/** x, y → cell on a layout of width w. */
export const at = (w: number) => (x: number, y: number) => y * w + x;

/** Mean and p95 of a sample. */
export function meanP95(xs: ArrayLike<number>): { mean: number; p95: number; max: number } {
  const s = Float64Array.from(xs).sort();
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i];
  return { mean: sum / s.length, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] };
}
