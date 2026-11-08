// FakeSim (PROTOCOL §11): the same Sim interface as the real core, with simple made-up behaviour, so render and UI
// tracks can build on day one. Agents wander between pick faces, pack stations, docks and chargers on the real
// layout graph and never share a cell (an agent only moves into a free cell). It is NOT a model of anything:
// the live skeleton labels its numbers "demo data". Integers only, deterministic.
import {
  AGENT_STATES,
  AGENT_TYPES,
  TICKS_PER_HOUR,
  type AgentSpec,
  type AgentState,
  type AgentTypeId,
  type AgentsFile,
  type AgentView,
  type Cargo,
  type Command,
  type Heading,
  type LayoutFile,
  type PassClass,
  type Scenario,
  type Sim,
  type SimEvent,
  type SimStats,
  type Snapshot,
  type TaskKind,
  type TaskView,
} from '../contracts/types.ts';
import { DeadlockTracker, JamTracker } from './detect.ts';
import { headingOf, mmPerTick, moveTicks, secToTicks, turns } from './motion.ts';
import { fnv1a32, hash32, stream, type Rng } from './rng.ts';
import { buildWorld, DistanceCache, type World } from './world.ts';

export interface SimData {
  agents: AgentsFile;
  layout: LayoutFile;
}

interface FAgent {
  id: number;
  name: string;
  type: AgentTypeId;
  vendor: string;
  spec: AgentSpec;
  cls: PassClass;
  speed: number;
  carry: number;
  cell: number;
  to: number;
  moveStart: number;
  moveEnd: number;
  heading: Heading;
  state: AgentState;
  goal: number;
  goalKind: 'face' | 'station' | 'dock' | 'charger' | 'none';
  dwellUntil: number;
  taskId: number;
  taskKind: TaskKind;
  taskStart: number;
  cargo: Cargo;
  stops: number;
  battery: number;
  batteryMax: number;
  /** Charger pocket reserved for (or in use by) this robot, or -1. Charging itself = state 'charge'. */
  charger: number;
  blockedTicks: number;
  waitOn: number;
  /** Best distance to the current goal so far, and ticks without beating it (a side step never resets this). */
  bestDist: number;
  noProgress: number;
  removing: boolean;
}

const PREFIX: Record<AgentTypeId, string> = { amr: 'AMR', forklift: 'FL', humanoid: 'HU', picker: 'PK', driver: 'DR' };

export class FakeSim implements Sim {
  tick = 0;
  readonly world: World;
  readonly dist: DistanceCache;
  private agents: FAgent[] = [];
  private occ: Int32Array;
  private rng: Rng;
  private arrivals: Rng;
  private events: SimEvent[] = [];
  private log: { tick: number; c: Command }[] = [];
  private pending: Command[] = [];
  private orderRate: number;
  private orderQueue: number[] = []; // arrival ticks of open orders (FIFO)
  private nextOrder = 0;
  private shipped = 0;
  private nextTask = 1;
  private nextId = 0;
  private stateTicks: Record<AgentTypeId, Record<AgentState, number>>;
  private heat: Uint32Array;
  private chargerUse: Int32Array;
  private jams: JamTracker;
  private deadlocks = new DeadlockTracker();
  private specs: Map<AgentTypeId, AgentSpec>;
  private unitsPicked: Partial<Record<AgentTypeId, number>> = {};

  constructor(readonly scenario: Scenario, data: SimData) {
    this.world = buildWorld(data.layout);
    this.dist = new DistanceCache(this.world);
    this.occ = new Int32Array(this.world.n).fill(-1);
    this.heat = new Uint32Array(this.world.n);
    this.chargerUse = new Int32Array(this.world.chargers.length).fill(-1);
    this.rng = stream(scenario.seed, 'physical');
    this.arrivals = stream(scenario.seed, 'arrivals');
    this.orderRate = scenario.orders.perHour;
    this.jams = new JamTracker(this.world.width);
    this.specs = new Map(data.agents.agents.map((a) => [a.id, a]));
    this.stateTicks = Object.fromEntries(AGENT_TYPES.map((t) => [t, Object.fromEntries(AGENT_STATES.map((s) => [s, 0]))])) as Snapshot['stats']['ticksByState'];
    const battery = stream(scenario.seed, 'battery');
    for (const t of AGENT_TYPES) this.setCount(t, scenario.fleet[t], battery);
  }

  // ───────── commands ─────────
  command(c: Command): void {
    this.pending.push(c);
  }
  commandLog() {
    return this.log.slice();
  }

  private vendorsFor(t: AgentTypeId, count: number): string[] {
    const shares = t === 'amr' || t === 'forklift' || t === 'humanoid' ? this.scenario.vendors[t] ?? [{ id: 'A', pct: 100 }] : [{ id: '-', pct: 100 }];
    // Largest remainder, deterministic.
    const base = shares.map((s) => Math.floor((count * s.pct) / 100));
    let left = count - base.reduce((a, b) => a + b, 0);
    const order = shares.map((s, i) => ({ i, rem: (count * s.pct) % 100 })).sort((a, b) => b.rem - a.rem || a.i - b.i);
    for (const o of order) if (left-- > 0) base[o.i]++;
    const out: string[] = [];
    shares.forEach((s, i) => {
      for (let k = 0; k < base[i]; k++) out.push(s.id);
    });
    return out;
  }

  private setCount(t: AgentTypeId, count: number, battery?: Rng): void {
    const alive = this.agents.filter((a) => a.type === t && !a.removing);
    if (count < alive.length) {
      for (const a of alive.slice(count)) a.removing = true;
      return;
    }
    const spec = this.specs.get(t)!;
    const vendors = this.vendorsFor(t, count);
    for (let k = alive.length; k < count; k++) {
      const cell = this.freeCell(spec.passClass);
      if (cell < 0) return;
      const max = spec.battery ? spec.battery.runtimeH.value * TICKS_PER_HOUR : 1;
      const lo = spec.battery ? Math.floor((max * spec.battery.chargeAtPct) / 100) : 1;
      const level = battery && this.scenario.run.batterySpread && spec.battery ? lo + battery.int(max - lo + 1) : max;
      const sameType = this.agents.filter((a) => a.type === t).length;
      const vendor = vendors[k] ?? vendors[0] ?? '-';
      const a: FAgent = {
        id: this.nextId++,
        name: `${PREFIX[t]}-${vendor !== '-' ? vendor : ''}${String(sameType + 1).padStart(2, '0')}`,
        type: t,
        vendor,
        spec,
        cls: spec.passClass,
        speed: mmPerTick(spec),
        carry: 0,
        cell,
        to: -1,
        moveStart: 0,
        moveEnd: 0,
        heading: 0,
        state: 'idle',
        goal: -1,
        goalKind: 'none',
        dwellUntil: 0,
        taskId: -1,
        taskKind: 'pick',
        taskStart: 0,
        cargo: 'none',
        stops: 0,
        battery: level,
        batteryMax: max,
        charger: -1,
        blockedTicks: 0,
        waitOn: -1,
        bestDist: 0xffff,
        noProgress: 0,
        removing: false,
      };
      this.occ[cell] = a.id;
      this.agents.push(a);
    }
  }

  private freeCell(cls: PassClass): number {
    const pass = this.world.passable[cls === 'small' ? 0 : cls === 'forklift' ? 1 : 2];
    for (let tries = 0; tries < 10_000; tries++) {
      const c = this.rng.int(this.world.n);
      if (pass[c] && !this.world.isPocket[c] && this.occ[c] < 0) return c;
    }
    return -1;
  }

  // ───────── simulation ─────────
  step(n = 1): void {
    for (let i = 0; i < n; i++) this.stepOne();
  }

  private stepOne(): void {
    const tick = this.tick;
    for (const c of this.pending) {
      this.log.push({ tick, c });
      if (c.t === 'setFleet') this.setCount(c.type, c.count);
      else if (c.t === 'setOrderRate') this.orderRate = c.perHour;
    }
    this.pending = [];

    // Orders: 4 draws per tick (PROTOCOL §8).
    const rate = this.scenario.orders.mode === 'saturate' ? 28_800 : this.orderRate;
    for (let d = 0; d < 4; d++) {
      if (this.arrivals.int(28_800) < rate) {
        const n = this.nextOrder++;
        const lines = 1 + (hash32(this.scenario.seed, n) % 4);
        this.orderQueue.push(tick);
        this.events.push({ t: 'orderArrived', tick, order: n, lines });
      }
    }

    const waitFor = new Int32Array(this.nextId).fill(-1);
    for (const a of this.agents) {
      this.stepAgent(a, tick, waitFor);
      this.stateTicks[a.type][a.state]++;
    }

    // Remove agents marked for removal once they stand still.
    for (const a of this.agents.filter((x) => x.removing && x.to < 0)) {
      this.occ[a.cell] = -1;
      if (a.state === 'charge') this.events.push({ t: 'chargeEnd', tick, agent: a.id });
      if (a.charger >= 0) this.chargerUse[a.charger] = -1;
    }
    this.agents = this.agents.filter((x) => !(x.removing && x.to < 0));

    const ids = this.agents.map((a) => a.id);
    const cells = this.agents.map((a) => a.cell);
    const blocked = this.agents.map((a) => a.blockedTicks);
    const j = this.jams.update(tick, cells, blocked, ids);
    for (const s of j.started) this.events.push({ t: 'jamStart', tick, jam: s.id, agents: s.agents, cell: s.cell });
    for (const e of j.ended) this.events.push({ t: 'jamEnd', tick, jam: e.id });
    const indexOf = new Map(this.agents.map((a, k) => [a.id, k]));
    const wf = new Int32Array(this.agents.length).fill(-1);
    this.agents.forEach((a, k) => {
      const target = a.id < waitFor.length ? waitFor[a.id] : -1;
      if (target >= 0) wf[k] = indexOf.get(target) ?? -1;
    });
    const d = this.deadlocks.update(tick, wf, ids);
    for (const s of d.started) this.events.push({ t: 'deadlockStart', tick, deadlock: s.id, agents: s.ids });
    for (const e of d.ended) this.events.push({ t: 'deadlockEnd', tick, deadlock: e.id });

    this.tick++;
  }

  private stepAgent(a: FAgent, tick: number, waitFor: Int32Array): void {
    const robot = a.spec.kind === 'robot';
    if (robot && a.state !== 'charge') a.battery = Math.max(0, a.battery - 1);

    // Finishing a move.
    if (a.to >= 0) {
      if (tick < a.moveEnd) {
        a.state = 'travel';
        return;
      }
      this.occ[a.cell] = -1;
      a.cell = a.to;
      a.to = -1;
    }
    // Dwelling (work, wait or charge).
    if (tick < a.dwellUntil) return;
    if (a.state === 'charge') {
      this.events.push({ t: 'chargeEnd', tick, agent: a.id });
      if (a.charger >= 0) this.chargerUse[a.charger] = -1;
      a.charger = -1;
      a.battery = a.batteryMax;
      a.goal = -1;
      a.state = 'idle';
    }
    if (a.removing) {
      a.state = 'idle';
      return;
    }

    // Arrived at the goal: do the work there.
    if (a.goal >= 0 && a.cell === a.goal) {
      this.arrive(a, tick);
      return;
    }
    if (a.goal < 0) this.chooseGoal(a, tick);
    if (a.goal < 0 || a.cell === a.goal) {
      a.state = 'idle';
      return;
    }

    const next = this.dist.next(a.cls, a.cell, a.goal);
    if (next < 0) {
      a.goal = -1;
      a.state = 'idle';
      return;
    }
    // Progress toward the goal: a side step and a walk back never count as progress.
    const d = this.dist.to(a.cls, a.goal)[a.cell];
    if (d < a.bestDist) {
      a.bestDist = d;
      a.noProgress = 0;
    } else a.noProgress++;
    if (a.noProgress > 60) {
      this.dropGoal(a); // 30 s without getting closer: give up and pick another goal (fake recovery)
      return;
    }
    const occupant = this.occ[next];
    if (occupant >= 0) {
      a.waitOn = occupant;
      a.blockedTicks++;
      a.state = 'blocked';
      waitFor[a.id] = occupant;
      this.heat[a.cell]++;
      // Most agents step aside after a few ticks; every fifth one is patient (so real jams can form, as on a floor).
      const patience = a.id % 10 === 0 ? 24 : 4 + (a.id % 4);
      if (a.blockedTicks > patience) {
        const pass = this.world.passable[a.cls === 'small' ? 0 : a.cls === 'forklift' ? 1 : 2];
        for (let k = 0; k < 4; k++) {
          const dir = (k + a.id + tick) % 4;
          const side = this.world.nbr[a.cell * 4 + dir];
          if (side < 0 || side === next || !pass[side] || this.world.isPocket[side] || this.occ[side] >= 0) continue;
          this.startMove(a, side, tick);
          return;
        }
        // Boxed in: yield for a moment without waiting on anyone (breaks symmetric standoffs), then re-plan.
        this.dropGoal(a);
        a.dwellUntil = tick + 3 + (a.id % 5);
        waitFor[a.id] = -1;
        a.waitOn = -1;
      }
      return;
    }
    this.startMove(a, next, tick);
  }

  private dropGoal(a: FAgent): void {
    if (a.goalKind === 'charger' && a.charger >= 0) {
      this.chargerUse[a.charger] = -1;
      a.charger = -1;
    }
    a.goal = -1;
    a.goalKind = 'none';
    a.blockedTicks = 0;
    a.noProgress = 0;
    a.bestDist = 0xffff;
    a.state = 'idle';
  }

  private startMove(a: FAgent, next: number, tick: number): void {
    const h = headingOf(a.cell, next, this.world.width);
    const turned = turns(a.heading, h);
    const m = moveTicks(a.blockedTicks > 0 || a.state !== 'travel' ? 0 : a.carry, a.speed, turned * a.spec.turnTicks, turned > 0);
    a.carry = m.carryMm;
    a.heading = h;
    a.to = next;
    a.moveStart = tick;
    a.moveEnd = tick + m.ticks;
    this.occ[next] = a.id;
    a.blockedTicks = 0;
    a.waitOn = -1;
    a.state = 'travel';
  }

  private arrive(a: FAgent, tick: number): void {
    const s = a.spec;
    switch (a.goalKind) {
      case 'face':
        if (a.type === 'amr') {
          a.state = 'wait';
          a.dwellUntil = tick + 8 + this.rng.int(8);
          a.cargo = 'tote';
        } else if (a.type === 'forklift' || a.type === 'driver') {
          a.state = 'work';
          a.dwellUntil = tick + secToTicks(s.palletSecPerMove?.value ?? 30);
          if (a.cargo === 'pallet') this.events.push({ t: 'palletMoved', tick, agent: a.id, kind: 'replenish' });
          a.cargo = 'none';
        } else {
          a.state = 'work';
          a.dwellUntil = tick + secToTicks(s.pickSecPerLine?.value ?? 20);
          a.cargo = 'cart';
          this.events.push({ t: 'pickDone', tick, agent: a.id, order: Math.max(0, this.nextOrder - 1), units: 1 });
          this.unitsPicked[a.type] = (this.unitsPicked[a.type] ?? 0) + 1;
        }
        a.stops++;
        break;
      case 'station':
        a.state = 'work';
        a.dwellUntil = tick + secToTicks(s.handoffSec?.value ?? 10);
        this.events.push({ t: 'toteDelivered', tick, agent: a.id, station: 0 });
        this.shipOne(tick);
        a.cargo = 'none';
        a.stops = 0;
        break;
      case 'dock':
        a.state = 'work';
        a.dwellUntil = tick + secToTicks(s.palletSecPerMove?.value ?? 30);
        a.cargo = 'pallet';
        break;
      case 'charger':
        a.state = 'charge';
        a.dwellUntil = tick + Math.max(1, Math.ceil(((a.batteryMax - a.battery) * (s.battery?.chargeH.value ?? 1)) / (s.battery?.runtimeH.value ?? 1)));
        this.events.push({ t: 'chargeStart', tick, agent: a.id, charger: a.charger });
        break;
      default:
        a.state = 'idle';
    }
    a.goal = -1;
  }

  private shipOne(tick: number): void {
    if (!this.orderQueue.length) return;
    const arrivedTick = this.orderQueue.shift()!;
    this.events.push({ t: 'orderShipped', tick, order: this.shipped, arrivedTick });
    this.shipped++;
  }

  private chooseGoal(a: FAgent, tick: number): void {
    const w = this.world;
    const robot = a.spec.kind === 'robot';
    if (robot && a.spec.battery && a.battery * 100 < a.batteryMax * a.spec.battery.chargeAtPct) {
      const free = w.chargers.findIndex((c, i) => c.forClass === a.cls && this.chargerUse[i] < 0);
      if (free >= 0) {
        this.chargerUse[free] = a.id;
        a.charger = free;
        this.setGoal(a, w.chargers[free].cell, 'charger', 'charge', tick);
        return;
      }
    }
    const face = () => w.faces[this.rng.chance(4, 5) ? this.rng.int(Math.max(1, Math.floor(w.faces.length / 5))) : this.rng.int(w.faces.length)].cell;
    if (a.type === 'forklift' || a.type === 'driver') {
      if (a.cargo === 'pallet') this.setGoal(a, face(), 'face', 'replenish', tick);
      else this.setGoal(a, w.docks[this.rng.int(w.docks.length)].service, 'dock', 'inbound', tick);
      return;
    }
    const stopsBeforePack = a.type === 'amr' ? 2 : 3;
    if (a.stops >= stopsBeforePack && w.packStations.length) this.setGoal(a, w.packStations[this.rng.int(w.packStations.length)].service, 'station', 'pick', tick);
    else this.setGoal(a, face(), 'face', 'pick', tick);
  }

  private setGoal(a: FAgent, cell: number, kind: FAgent['goalKind'], task: TaskKind, tick: number): void {
    a.goal = cell;
    a.bestDist = 0xffff;
    a.noProgress = 0;
    a.goalKind = kind;
    if (a.taskKind !== task || a.taskId < 0 || kind === 'charger') {
      a.taskId = this.nextTask++;
      a.taskKind = task;
      a.taskStart = tick;
      this.events.push({ t: 'taskAssigned', tick, task: a.taskId, kind: task, agents: [a.id] });
    }
  }

  // ───────── outputs ─────────
  snapshot(): Snapshot {
    const agents: AgentView[] = this.agents.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      vendor: a.vendor,
      model: a.spec.model,
      cell: a.cell,
      to: a.to,
      moveStart: a.moveStart,
      moveEnd: a.moveEnd,
      heading: a.heading,
      state: a.state,
      goal: a.goal,
      route: a.goal >= 0 ? this.dist.route(a.cls, a.to >= 0 ? a.to : a.cell, a.goal, 12) : [],
      taskId: a.taskId,
      cargo: a.cargo,
      batteryPct: a.spec.kind === 'robot' ? Math.floor((a.battery * 100) / a.batteryMax) : 100,
      blockedTicks: a.blockedTicks,
      waitOn: a.state === 'blocked' ? a.waitOn : -1,
    }));
    const tasks: TaskView[] = this.agents
      .filter((a) => a.taskId >= 0)
      .map((a) => ({
        id: a.taskId,
        kind: a.taskKind,
        orderIds: [],
        lines: a.taskKind === 'pick' ? 1 + (a.taskId % 3) : 0,
        stage: a.goalKind === 'none' ? a.state : `to ${a.goalKind}`,
        createdTick: a.taskStart,
        agentIds: [a.id],
      }));
    return {
      tick: this.tick,
      width: this.world.width,
      height: this.world.height,
      agents,
      tasks,
      stats: { ticksByState: JSON.parse(JSON.stringify(this.stateTicks)) },
      openOrders: this.orderQueue.length,
      shippedOrders: this.shipped,
      chargers: this.world.chargers.map((c, i) => ({
        cell: c.cell,
        vendor: '-',
        agentId: this.chargerUse[i],
      })),
      deadlocks: this.deadlocks.active().map((d) => ({ ids: d.ids, sinceTick: d.sinceTick })),
      heat: Array.from(this.heat),
    };
  }

  stats(): SimStats {
    const fleet = Object.fromEntries(AGENT_TYPES.map((t) => [t, this.agents.filter((a) => a.type === t).length])) as SimStats['fleet'];
    return {
      tick: this.tick,
      openOrders: this.orderQueue.length,
      shippedOrders: this.shipped,
      ticksByState: JSON.parse(JSON.stringify(this.stateTicks)),
      unitsPicked: { ...this.unitsPicked },
      fleet,
    };
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  hash(): string {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      if (!Number.isInteger(v)) throw new Error(`FakeSim.hash: non-integer state ${v}`);
      h = Math.imul(h ^ (v & 0xffff), 0x01000193);
      h = Math.imul(h ^ ((v >>> 16) & 0xffff), 0x01000193);
    };
    mix(this.tick);
    mix(this.nextOrder);
    mix(this.shipped);
    for (const a of this.agents)
      for (const v of [a.id, a.cell, a.to, a.moveStart, a.moveEnd, a.heading, a.goal, a.dwellUntil, a.carry, a.battery, a.blockedTicks, a.taskId, a.bestDist, a.noProgress])
        mix(v);
    for (const v of this.rng.state()) mix(v);
    for (const v of this.arrivals.state()) mix(v);
    return (h >>> 0).toString(16).padStart(8, '0') + fnv1a32(String(this.agents.length)).toString(16).slice(0, 4);
  }
}

export function createFakeSim(scenario: Scenario, data: SimData): Sim {
  return new FakeSim(scenario, data);
}
