// The real simulator (Track A): orders arrive, cart robots and people pick them, totes reach pack stations, orders
// ship; forklifts and drivers keep pick faces stocked, robots charge, things break. Deterministic, integer state only,
// headless. PROTOCOL §1, §3, §4, §5 and §8 are the rules; the tick loop and the people manners are lifted from spike b.
//
// One tick = 0.5 s. Phases, in this order, every agent in id order, every tie ending with an id tie-break:
//  0. moves whose time is up land on their target cell. (A k-tick move started at tick t holds both cells through tick
//     t+k−1 and lands at the start of t+k, so a robot can plan its next cell the same tick: exact average speed, and
//     the snapshot after tick t+k−1 still shows the move for the renderer to interpolate.)
//  1. queued commands    2. order arrivals (4 draws) and inbound pallets    3. faults (breakdowns, repairs)
//  4. people move (PROTOCOL §5 rules, people first)    5. traffic.recover() → resets / re-tasks
//  6. traffic.plan() → robot moves start    7. arrivals at goals, dwells, task progress, assignment, packing, shipping
//  8. battery    9. states and detection (DeadlockTracker, JamTracker)    10. stats, then tick++
import {
  AGENT_STATES,
  AGENT_TYPES,
  TICKS_PER_HOUR,
  type AgentSpec,
  type AgentTypeId,
  type AgentsFile,
  type AgentView,
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
  type TrafficMode,
} from '../../contracts/types.ts';
import { DeadlockTracker, JamTracker } from '../detect.ts';
import { FaultSchedule } from '../faults/index.ts';
import { headingOf, mmPerTick, moveTicks, secToTicks, turns } from '../motion.ts';
import { fnv1a32, hash32, scale, stream, type Rng } from '../rng.ts';
import { NaiveController } from '../traffic/naive.ts';
import { clearPlan, createPlan, type TrafficAgent, type TrafficController, type TrafficInput, type TrafficPlan } from '../traffic/types.ts';
import { buildWorld, classIndex, Cell, DistanceCache, UNREACHABLE, type World } from '../world.ts';
import {
  CARGO_NAMES,
  CH_ON,
  CH_TO,
  C_CART,
  C_NONE,
  C_PALLET,
  C_TOTE,
  CoreAgent,
  G_EXACT,
  G_MEET,
  G_NEAR,
  G_REACH,
  G_STATION,
  J_CHARGE,
  J_NONE,
  J_PALLET,
  J_PICK,
  J_REST,
  J_SERVE,
  N_STATES,
  PK_AT_STOP,
  PK_HANDOFF,
  PK_HOLD,
  PK_SETUP,
  PK_ZONE_HOLD,
  PK_TO_PACK,
  PK_TO_STOP,
  PL_LOAD,
  PL_TO_DOCK,
  PL_TO_FACE,
  PL_UNLOAD,
  RK_CELL,
  RK_HOME,
  RK_PARKING,
  RK_STAY,
  RK_ZONE,
  RS_AT,
  RS_TO,
  ST_BLOCKED,
  ST_BROKEN,
  ST_CHARGE,
  ST_IDLE,
  ST_TRAVEL,
  ST_WAIT,
  ST_WORK,
  SV_PICKING,
  SV_TO_AMR,
  SV_WAIT_AMR,
  SV_WAIT_STOCK,
  T_AMR,
  T_DRIVER,
  T_FORKLIFT,
  T_HUMANOID,
  T_PICKER,
} from './agent.ts';
import {
  ASSISTED_PICK_PCT,
  MEET_GIVEUP_TICKS,
  BATCH_MAX_WAIT_SEC,
  BATCH_WINDOW,
  BLEED_PENALTY_CELLS,
  BLEED_WAIT_TICKS,
  CART_SETUP_SEC,
  CLAIM_AFTER_TICKS,
  CONVEYOR_TICKS,
  CRITICAL_BATTERY_PCT,
  DEFAULT_HANDOFF_SEC,
  HOME_SPACING,
  ORDERS_PER_CART,
  PACK_QUEUE_SLOTS,
  SATURATE_MIN_QUEUE,
  SATURATE_ORDERS_PER_AGENT,
  PRESEND_CELLS,
  PUT_TO_CART_SEC,
  TOTE_HANDOFF_SEC,
  TOTES_PER_AMR,
  WAIT_CREDIT_MAX_CELLS,
  WAIT_CREDIT_TICKS,
  ZONE_FACES_PER_AMR,
  ZONE_MAX_AMRS,
  ZONE_PICKERS,
} from './constants.ts';
import { StateHasher } from './hash.ts';
import { OS_CONVEYOR, OS_PACK, OS_PICKING, OrderBook, type Order } from './orders.ts';
import { PackFloor, type PackStation } from './pack.ts';
import { movePeople } from './people.ts';
import { computeZones, faceWeights, zoneFaceOrder, type Zones } from './zones.ts';

export interface CoreSimData {
  agents: AgentsFile;
  layout: LayoutFile;
}

export interface CoreSimOptions {
  /** Traffic controller per mode. Default: NaiveController (the lead switches it to Track B's controller). */
  traffic?: (mode: TrafficMode) => TrafficController;
  /** Check the occupancy invariants every tick and count violations (tests). */
  checks?: boolean;
}

/** Invariant violation counters (always counted where cheap; the per-tick sweep only with `checks`). */
export interface Violations {
  /** Two agents holding one cell (cells, move targets and safety cells). */
  overlap: number;
  /** occ[] disagreeing with the agents' own cells. */
  occMismatch: number;
  /** A planned or people move into a held cell (refused). */
  moveIntoHeld: number;
  /** ... of which a robot into a person's cell. */
  robotIntoPerson: number;
  /** A forklift or driver on a narrow '.' cell. */
  forkOnNarrow: number;
  /** A robot moving into a pocket that is not its goal (refused). */
  pocketNotGoal: number;
  /** A planned move that is not to a passable 4-neighbour (refused). */
  badMove: number;
  /** A battery below 0. */
  negativeBattery: number;
}

interface Stop {
  face: number;
  orders: number[];
  /** Units still to pick at this face, per order. */
  left: number[];
  /** Units already taken from the face for this task (put back if the task is dropped). */
  picked: number;
}

interface PickTask {
  kind: 'pick';
  id: number;
  created: number;
  /** Carrier: the cart robot, or the person / humanoid with a manual cart. */
  agent: number;
  amr: boolean;
  orders: number[];
  lines: number;
  stops: Stop[];
  stop: number;
  station: number;
  /** Units picked so far, per picking agent type: credited to SimStats.unitsPicked when the tote reaches packing. */
  pickedBy: number[];
}

interface PalletTask {
  kind: 'replenish' | 'inbound';
  id: number;
  created: number;
  agent: number;
  face: number;
  /** Dock staging (service) cell. */
  dock: number;
}

interface PlainTask {
  kind: 'charge' | 'park';
  id: number;
  created: number;
  agent: number;
}

type Task = PickTask | PalletTask | PlainTask;

interface Pool {
  key: string;
  type: number;
  vendor: string;
  ids: number[];
}

const PREFIX: Record<AgentTypeId, string> = { amr: 'AMR', forklift: 'FL', humanoid: 'HU', picker: 'PK', driver: 'DR' };
const SALT_STOCK = 0x53544f4b; // 'STOK'
const SALT_INBOUND = 0x494e4244; // 'INBD'
const ARRIVAL_DRAWS = 4;
const ARRIVAL_SCALE = 28_800;

export class CoreSim implements Sim {
  // ───────────── shared with people.ts (internal) ─────────────
  readonly world: World;
  readonly dist: DistanceCache;
  readonly occ: Int32Array;
  readonly claim: Int32Array;
  /** Cells any class may stand on (for safety cells). */
  readonly open: Uint8Array;
  readonly rngHumans: Rng;
  byId: (CoreAgent | null)[] = [];
  agents: CoreAgent[] = [];
  people: CoreAgent[] = [];
  robots: CoreAgent[] = [];
  readonly counters = { stepAsides: 0, stepOffs: 0, swaps: 0, detours: 0, trafficStepAsides: 0, resets: 0, retasks: 0, pushedOff: 0, meetsGivenUp: 0 };
  readonly violations: Violations = {
    overlap: 0, occMismatch: 0, moveIntoHeld: 0, robotIntoPerson: 0, forkOnNarrow: 0, pocketNotGoal: 0, badMove: 0, negativeBattery: 0,
  };

  // ───────────── private state ─────────────
  private t = 0;
  private readonly scenario: Scenario;
  private readonly seed: number;
  private readonly specs: AgentSpec[];
  private readonly checks: boolean;
  private readonly trafficFactory: (mode: TrafficMode) => TrafficController;
  private traffic: TrafficController;
  private mode: TrafficMode;
  private orderRate: number;
  private readonly saturate: boolean;
  private nextId = 0;
  private nextTask = 1;
  private readonly spawnOrder: number[][] = AGENT_TYPES.map(() => []);
  private pending: Command[] = [];
  private log: { tick: number; c: Command }[] = [];
  private events: SimEvent[] = [];

  private readonly arrivals: Rng;
  private readonly rngSpawn: Rng;
  private readonly rngBattery: Rng;
  private readonly rngFaults: Rng;
  private readonly tiebreak = new Map<string, Rng>();

  private readonly orders: OrderBook;
  private readonly pack: PackFloor;
  private readonly packTicks: number;
  private readonly setupTicks = secToTicks(CART_SETUP_SEC);
  private readonly batchWaitTicks = secToTicks(BATCH_MAX_WAIT_SEC);
  private readonly putTicks = secToTicks(PUT_TO_CART_SEC);
  private readonly toteHandoffTicks = secToTicks(TOTE_HANDOFF_SEC);
  private readonly faults: FaultSchedule;
  private tasks: Task[] = [];
  private taskById = new Map<number, Task>();
  private palletTasks: PalletTask[] = [];

  // stock per face (lines), -1 = not tracked (no pallet mover can reach the face)
  private readonly stock: Int32Array;
  private readonly replenOpen: Int32Array;
  private readonly faceDock: Int32Array;
  private readonly linesPerReplenish: number;
  private readonly reachFaces: number[];
  private readonly inboundEvery: number;
  private nextInbound: number;
  private inboundCount = 0;

  private readonly chargerHolder: Int32Array;
  private readonly parkingHolder: Int32Array;
  private readonly restHolder: Int32Array;
  private chargeQueue: number[] = [];
  /** Carriers holding a full batch until a pack station has a free queue slot, in the order they became ready. */
  private packHold: number[] = [];
  /** Cart robots between stops held until one of their remaining zones has room, in the order they were held. */
  private zoneHold: number[] = [];
  /** restOk[classIndex][cell]: a robot / driver may rest here without blocking anything important. */
  private readonly restOk: Uint8Array[];
  /** Rest cells for forklifts and drivers in the dock zone (tried first). */
  private readonly restDock: Uint8Array;
  /** Station access, dock service and pocket entry cells. */
  private readonly infra: Uint8Array;
  private readonly inPack: Uint8Array;
  private readonly homes: number[];

  private zones: Zones | null = null;
  private zonesDirty = true;
  /** Cart robots each zone admits (see zoneHasRoom). */
  private zoneCap: number[] = [];
  private zoneLoads: number[] = [];
  private zoneLoadTick = -1;
  private readonly zoneOrder: number[];
  private readonly zoneWeights: number[];
  private activeAmrs = 0;
  /** Cart robots, humanoids and pickers present (saturate-mode queue size). */
  private pickingAgents = 0;
  private amrTasks = 0;
  private pools: Pool[] = [];
  private poolsDirty = true;

  // traffic seam
  private cap = 0;
  private ready: Int32Array = new Int32Array(0);
  private plan: TrafficPlan = createPlan(0);
  private tviews: (TrafficAgent | null)[] = [];
  private order: number[] = [];
  private orderDirty = true;
  private readonly yields: number[] = [];
  private readonly tin: TrafficInput;

  // detection and stats
  private readonly deadlocks = new DeadlockTracker();
  private readonly jams: JamTracker;
  private readonly heat: Uint32Array;
  private readonly ticksByState: Float64Array = new Float64Array(AGENT_TYPES.length * N_STATES);
  private readonly unitsPicked: number[] = AGENT_TYPES.map(() => 0);
  private posOf: Int32Array = new Int32Array(0);
  private dWait: Int32Array = new Int32Array(0);
  private dCells: Int32Array = new Int32Array(0);
  private dBlocked: Int32Array = new Int32Array(0);
  private dIds: Int32Array = new Int32Array(0);

  // scratch
  private readonly bfsStamp: Int32Array;
  private readonly bfsQueue: Int32Array;
  private stamp = 0;
  private readonly cand: CoreAgent[] = [];
  private readonly zoneCands: CoreAgent[][] = [];
  private readonly peekList: number[] = [];
  private readonly shipList: number[] = [];
  private readonly holdStamp: Int32Array;

  constructor(scenario: Scenario, data: CoreSimData, opts: CoreSimOptions = {}) {
    this.scenario = scenario;
    this.seed = scenario.seed >>> 0;
    const w = (this.world = buildWorld(data.layout));
    this.dist = new DistanceCache(w);
    this.occ = new Int32Array(w.n).fill(-1);
    this.claim = new Int32Array(w.n).fill(-1);
    this.heat = new Uint32Array(w.n);
    this.holdStamp = new Int32Array(w.n).fill(-1);
    this.bfsStamp = new Int32Array(w.n).fill(-1);
    this.bfsQueue = new Int32Array(w.n);
    this.open = new Uint8Array(w.n);
    for (let i = 0; i < w.n; i++) this.open[i] = w.passable[0][i] | w.passable[1][i] | w.passable[2][i];
    this.checks = !!opts.checks;
    this.specs = AGENT_TYPES.map((id) => {
      const s = data.agents.agents.find((a) => a.id === id);
      if (!s) throw new Error(`agents.json has no spec for ${id}`);
      return s;
    });

    this.arrivals = stream(this.seed, 'arrivals');
    this.rngHumans = stream(this.seed, 'humans');
    this.rngFaults = stream(this.seed, 'faults'); // reserved for Phase 2 random faults (hashed, not drawn yet)
    this.rngBattery = stream(this.seed, 'battery');
    this.rngSpawn = stream(this.seed, 'spawn');

    this.mode = scenario.traffic.mode;
    this.trafficFactory = opts.traffic ?? ((mode) => new NaiveController(mode));
    this.traffic = this.trafficFactory(this.mode);
    this.orderRate = scenario.orders.perHour;
    this.saturate = scenario.orders.mode === 'saturate';
    this.orders = new OrderBook(this.seed, scenario.orders, w.faces.length);
    this.pack = new PackFloor(w, scenario.pack.stations);
    this.packTicks = secToTicks(scenario.pack.secPerOrder);
    this.faults = new FaultSchedule(scenario.events);
    this.jams = new JamTracker(w.width);

    // ── cells that matter ──
    this.infra = new Uint8Array(w.n);
    for (const s of w.packStations)
      for (const c of s.cells)
        for (let d = 0; d < 4; d++) {
          const j = w.nbr[c * 4 + d];
          if (j >= 0 && this.open[j]) this.infra[j] = 1;
        }
    for (const s of w.docks) this.infra[s.service] = 1;
    for (const p of [...w.chargers, ...w.parking]) this.infra[p.entry] = 1;
    this.inPack = new Uint8Array(w.n);
    for (const z of data.layout.zones)
      if (z.kind === 'pack')
        for (let y = z.y; y < z.y + z.h; y++) for (let x = z.x; x < z.x + z.w; x++) if (x >= 0 && y >= 0 && x < w.width && y < w.height) this.inPack[y * w.width + x] = 1;
    // Rest cells: off the pick faces and the cells next to them (aisle ends), off station / dock / pocket access, off
    // staging and the pack zone. Forklifts and drivers prefer the dock zone, where their pallet work starts.
    const nearFace = new Uint8Array(w.n);
    for (let c = 0; c < w.n; c++) {
      if (w.faceAt[c] < 0) continue;
      nearFace[c] = 1;
      for (let d = 0; d < 4; d++) {
        const j = w.nbr[c * 4 + d];
        if (j >= 0) nearFace[j] = 1;
      }
    }
    const inDock = new Uint8Array(w.n);
    for (const z of data.layout.zones)
      if (z.kind === 'dock')
        for (let y = z.y; y < z.y + z.h; y++) for (let x = z.x; x < z.x + z.w; x++) if (x >= 0 && y >= 0 && x < w.width && y < w.height) inDock[y * w.width + x] = 1;
    this.restOk = [0, 1].map((ci) => {
      const ok = new Uint8Array(w.n);
      for (let c = 0; c < w.n; c++)
        ok[c] = w.passable[ci][c] && !w.isPocket[c] && !nearFace[c] && !this.infra[c] && !this.inPack[c] && w.code[c] !== Cell.Staging ? 1 : 0;
      return ok;
    });
    this.restDock = new Uint8Array(w.n);
    for (let c = 0; c < w.n; c++) this.restDock[c] = this.restOk[1][c] && inDock[c] ? 1 : 0;
    this.homes = w.humanHome.filter((_, i) => i % HOME_SPACING === 0);
    this.chargerHolder = new Int32Array(w.chargers.length).fill(-1);
    this.parkingHolder = new Int32Array(w.parking.length).fill(-1);
    this.restHolder = new Int32Array(w.n).fill(-1);

    // ── stock and pallets ──
    const F = w.faces.length;
    this.linesPerReplenish = Math.max(0, Math.floor(scenario.pallets.linesPerReplenish));
    this.stock = new Int32Array(F).fill(-1);
    this.replenOpen = new Int32Array(F).fill(-1);
    this.faceDock = new Int32Array(F).fill(-1);
    this.reachFaces = [];
    const docks = w.docks.map((d) => d.service);
    for (let f = 0; f < F; f++) {
      const cell = w.faces[f].cell;
      let best = -1;
      let bestD = UNREACHABLE;
      for (const dk of docks) {
        const d = this.dist.to('forklift', dk)[cell];
        if (d < bestD) {
          bestD = d;
          best = dk;
        }
      }
      this.faceDock[f] = best;
      if (best < 0) continue;
      this.reachFaces.push(f);
      // Each face holds 2 × linesPerReplenish lines; the start level is spread over (L, 2L] so replenishment flows
      // steadily from the start instead of in one wave.
      const L = this.linesPerReplenish;
      if (L > 0) this.stock[f] = L + 1 + scale(hash32(this.seed, f, 0, SALT_STOCK), L);
    }
    const inbound = Math.max(0, Math.floor(scenario.pallets.inboundPerHour));
    this.inboundEvery = inbound > 0 && docks.length > 0 && this.reachFaces.length > 0 ? Math.max(1, Math.floor(TICKS_PER_HOUR / inbound)) : 0;
    this.nextInbound = this.inboundEvery;

    // ── zones ──
    this.zoneOrder = zoneFaceOrder(w);
    this.zoneWeights = faceWeights(F, this.orders.aFaces, scenario.orders.sku.aPicksPct);

    // ── traffic input (one object, reused every tick) ──
    this.tin = {
      tick: 0,
      world: w,
      dist: this.dist,
      agents: this.tviews,
      order: this.order,
      ready: this.ready,
      occ: this.occ,
      yields: this.yields,
    };

    // ── initial fleet: random free cells from the `spawn` stream, battery spread from the `battery` stream ──
    for (let ti = 0; ti < AGENT_TYPES.length; ti++) {
      const vendors = this.vendorList(ti, scenario.fleet[AGENT_TYPES[ti]] ?? 0);
      for (const v of vendors) {
        const cell = this.randomFreeCell(this.specs[ti].passClass);
        if (cell < 0) break;
        this.spawn(ti, v, cell, true);
      }
    }
  }

  // ═════════════════════════════ Sim interface ═════════════════════════════
  get tick(): number {
    return this.t;
  }

  step(n = 1): void {
    for (let i = 0; i < n; i++) this.stepOne();
  }

  command(c: Command): void {
    this.pending.push(c);
  }

  commandLog(): { tick: number; c: Command }[] {
    return this.log.slice();
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ═════════════════════════════ the tick ═════════════════════════════
  private stepOne(): void {
    const t = this.t;
    this.landMoves(t); // 0
    this.applyCommands(t); // 1
    this.orderArrivals(t); // 2
    this.applyFaults(t); // 3
    movePeople(this, t); // 4
    this.runTraffic(t); // 5, 6
    this.progress(t); // 7
    this.batteries(t); // 8
    this.detect(t); // 9
    this.countStats(); // 10
    if (this.checks) this.checkInvariants();
    this.t = t + 1;
  }

  // ── 0. motion ──
  private landMoves(t: number): void {
    const occ = this.occ;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.to < 0 || a.moveEnd > t) continue;
      if (occ[a.cell] === a.id) occ[a.cell] = -1;
      if (a.safety >= 0) {
        if (occ[a.safety] === a.id) occ[a.safety] = -1;
        a.safety = -1;
      }
      a.cell = a.to;
      a.to = -1;
      if (a.goal >= 0) {
        const d = this.dist.to(a.distCls, a.goal)[a.cell];
        if (d < a.bestDist) {
          a.bestDist = d;
          a.sinceProgress = 0;
          a.blockedSinceProgress = 0;
        }
      }
    }
  }

  /** Start a one-cell move (people mover and planner moves). The caller has checked that the cells are free. */
  doMove(a: CoreAgent, m: number, safety: number, dir: number, t: number): void {
    const n = turns(a.heading as Heading, dir as Heading);
    // PROTOCOL §1: the remainder carries only through a continuous straight move; a stop or a turn resets it.
    const continuous = a.moveEnd === t && n === 0;
    const mt = moveTicks(continuous ? a.carry : 0, a.speed, a.turnTicks * n, n > 0);
    this.occ[m] = a.id;
    if (safety >= 0) this.occ[safety] = a.id;
    a.to = m;
    a.safety = safety;
    a.heading = dir;
    a.moveStart = t;
    a.moveEnd = t + mt.ticks;
    a.carry = mt.carryMm;
  }

  /** A person waiting at a face (or beside a cart robot) stepped off for a vehicle or a passing picker. */
  steppedOff(p: CoreAgent, t: number): void {
    const at = p.to >= 0 ? p.to : p.cell;
    if (p.job === J_PICK && p.stage === PK_AT_STOP) {
      // within 2 cells it keeps waiting where it is (it can reach the face from there); further, it walks back
      const task = this.taskById.get(p.taskId) as PickTask;
      const face = this.world.faces[task.stops[task.stop].face].cell;
      if (this.dist.to(p.distCls, face)[at] <= 2) return;
      p.stage = PK_TO_STOP;
      p.waiting = 0;
      this.setGoal(p, face, G_NEAR, t);
    } else if (p.job === J_SERVE && p.stage === SV_WAIT_STOCK) {
      const amr = this.byId[p.partner];
      if (amr && this.dist.to(p.distCls, amr.cell)[at] > 2) this.sendToMeet(p, amr, t);
    }
  }

  /** Two people head-on squeeze past each other (people mover, PROTOCOL §5 rule 4). */
  swap(p: CoreAgent, q: CoreAgent, t: number): void {
    const v = p.cell;
    const u = q.cell;
    this.occ[v] = q.id;
    this.occ[u] = p.id;
    p.heading = headingOf(v, u, this.world.width);
    q.heading = headingOf(u, v, this.world.width);
    p.cell = u;
    q.cell = v;
    for (const x of [p, q]) {
      x.carry = 0;
      x.pBlocked = 0;
      x.moveStart = t;
      x.moveEnd = t;
      x.swappedAt = t;
      x.want = -1;
      x.waitOn = -1;
      if (x.goal >= 0) {
        const d = this.dist.to(x.distCls, x.goal)[x.cell];
        if (d < x.bestDist) x.bestDist = d;
      }
    }
    this.counters.swaps++;
  }

  // ── 1. commands ──
  private applyCommands(t: number): void {
    if (this.pending.length === 0) return;
    const list = this.pending;
    this.pending = [];
    for (const c of list) {
      this.log.push({ tick: t, c });
      if (c.t === 'setFleet') this.setFleet(c.type, c.count, c.vendor);
      else if (c.t === 'setOrderRate') this.orderRate = Math.max(0, Math.min(ARRIVAL_SCALE, Math.floor(c.perHour)));
      else if (c.t === 'setTraffic') {
        this.mode = c.mode;
        this.traffic = this.trafficFactory(c.mode);
        this.poolsDirty = true;
      } else if (c.t === 'inject') this.faults.add(c.event, t);
    }
  }

  private setFleet(type: AgentTypeId, count: number, vendor?: string): void {
    const ti = AGENT_TYPES.indexOf(type);
    if (ti < 0) return;
    const target = Math.max(0, Math.floor(count));
    if (vendor !== undefined) {
      this.adjustVendor(ti, vendor, target);
      return;
    }
    const list = this.vendorList(ti, target);
    const want = new Map<string, number>();
    for (const v of list) want.set(v, (want.get(v) ?? 0) + 1);
    const vendors = [...new Set([...this.agents.filter((a) => a.type === ti).map((a) => a.vendor), ...want.keys()])].sort();
    for (const v of vendors) this.adjustVendor(ti, v, want.get(v) ?? 0);
  }

  private adjustVendor(ti: number, vendor: string, target: number): void {
    const mine = this.agents.filter((a) => a.type === ti && a.vendor === vendor);
    const active = mine.filter((a) => !a.removing);
    if (active.length > target) {
      // the most recently spawned leave first; each finishes its task, then leaves
      for (const a of active.slice(target)) this.markRemoving(a);
      return;
    }
    let need = target - active.length;
    const leaving = mine.filter((a) => a.removing).sort((x, y) => y.id - x.id);
    for (const a of leaving) {
      if (need === 0) break;
      a.removing = 0;
      need--;
      this.fleetChanged(a);
    }
    for (; need > 0; need--) {
      const cell = this.spawnCell(ti);
      if (cell < 0) break;
      this.spawn(ti, vendor, cell, false);
    }
  }

  private markRemoving(a: CoreAgent): void {
    a.removing = 1;
    this.fleetChanged(a);
  }

  private fleetChanged(a: CoreAgent): void {
    if (a.type === T_PICKER || a.type === T_HUMANOID || a.type === T_AMR) this.zonesDirty = true;
    this.poolsDirty = true;
    this.recountAmrs();
  }

  private recountAmrs(): void {
    let n = 0;
    let p = 0;
    for (const a of this.agents) {
      if (a.type === T_AMR && !a.removing) n++;
      if (a.type === T_AMR || a.type === T_HUMANOID || a.type === T_PICKER) p++;
    }
    this.activeAmrs = n;
    this.pickingAgents = p;
  }

  /** Largest-remainder vendor split for `count` agents of a type (robots), people get vendor '-'. */
  private vendorList(ti: number, count: number): string[] {
    const t = AGENT_TYPES[ti];
    const shares = t === 'amr' || t === 'forklift' || t === 'humanoid' ? this.scenario.vendors[t] ?? [{ id: 'A', pct: 100 }] : [{ id: '-', pct: 100 }];
    const base = shares.map((s) => Math.floor((count * s.pct) / 100));
    let left = count - base.reduce((x, y) => x + y, 0);
    const byRem = shares.map((s, i) => ({ i, rem: (count * s.pct) % 100 })).sort((x, y) => y.rem - x.rem || x.i - y.i);
    for (const o of byRem) if (left-- > 0) base[o.i]++;
    const out: string[] = [];
    shares.forEach((s, i) => {
      for (let k = 0; k < base[i]; k++) out.push(s.id);
    });
    return out;
  }

  /** A setFleet arrival: robots appear at a free parking pocket, else a free charger pocket of their class, else a free
   *  cell from the `spawn` stream; people at a free cell. */
  private spawnCell(ti: number): number {
    const spec = this.specs[ti];
    if (spec.kind === 'robot') {
      for (const p of this.world.parking) if (p.forClass === spec.passClass && this.parkingHolder[p.id] < 0 && this.occ[p.cell] < 0) return p.cell;
      for (const p of this.world.chargers) if (p.forClass === spec.passClass && this.chargerHolder[p.id] < 0 && this.occ[p.cell] < 0) return p.cell;
    }
    return this.randomFreeCell(spec.passClass);
  }

  private randomFreeCell(cls: PassClass): number {
    const w = this.world;
    const pass = w.passable[classIndex(cls)];
    const ok = (c: number) => pass[c] && !w.isPocket[c] && !this.infra[c] && this.occ[c] < 0;
    for (let tries = 0; tries < 4 * w.n; tries++) {
      const c = this.rngSpawn.int(w.n);
      if (ok(c)) return c;
    }
    for (let c = 0; c < w.n; c++) if (ok(c)) return c;
    return -1;
  }

  private spawn(ti: number, vendor: string, cell: number, initial: boolean): CoreAgent {
    const spec = this.specs[ti];
    const typeId = AGENT_TYPES[ti];
    const spawnIndex = this.spawnOrder[ti].length;
    const runtime = spec.battery ? Math.max(1, Math.round(spec.battery.runtimeH.value * TICKS_PER_HOUR)) : 0;
    const charge = spec.battery ? Math.max(1, Math.round(spec.battery.chargeH.value * TICKS_PER_HOUR)) : 1;
    const a = new CoreAgent({
      id: this.nextId++,
      type: ti,
      typeId,
      spec,
      name: `${PREFIX[typeId]}-${vendor !== '-' ? vendor : ''}${String(spawnIndex + 1).padStart(2, '0')}`,
      vendor,
      pass: this.world.passable[classIndex(spec.passClass)],
      speed: mmPerTick(spec),
      pickTicks: spec.pickSecPerLine ? secToTicks(spec.pickSecPerLine.value) : 0,
      // people picking into a cart robot's tote skip the search (the robot parks at the location and shows the item)
      assistTicks: spec.pickSecPerLine ? secToTicks((spec.pickSecPerLine.value * (spec.kind === 'human' ? ASSISTED_PICK_PCT : 100)) / 100) : 0,
      palletTicks: spec.palletSecPerMove ? secToTicks(spec.palletSecPerMove.value) : 0,
      handoffTicks: secToTicks(spec.handoffSec?.value ?? DEFAULT_HANDOFF_SEC),
      batteryMax: runtime,
      chargeQ: Math.floor(runtime / charge),
      chargeR: runtime % charge,
      chargeC: charge,
      spawnIndex,
      cell,
    });
    this.spawnOrder[ti].push(a.id);
    if (a.robot) {
      // PROTOCOL §6: start levels spread between chargeAtPct and full (seeded `battery` stream) on the initial fleet.
      const lo = Math.floor((runtime * a.chargeAtPct) / 100);
      a.battery = initial && this.scenario.run.batterySpread ? lo + this.rngBattery.int(runtime - lo + 1) : runtime;
      a.tb = this.tie(vendor).u32() >>> 11;
    }
    this.ensureCapacity(a.id + 1);
    this.byId[a.id] = a;
    this.agents.push(a);
    (a.robot ? this.robots : this.people).push(a);
    this.occ[cell] = a.id;
    if (a.robot) {
      this.tviews[a.id] = {
        id: a.id, vendor, passClass: a.cls, cell, heading: 0, goal: -1, safetyCells: a.safetyCells, turnTicks: a.turnTicks,
        sinceProgress: 0, blockedSinceProgress: 0,
      };
      this.order.push(a.id);
      this.orderDirty = true;
    }
    // Spawned into a parking pocket: it is parked there.
    if (this.world.isPocket[cell]) {
      const park = this.world.parking.find((p) => p.cell === cell);
      if (park) {
        this.parkingHolder[park.id] = a.id;
        a.parking = park.id;
        a.job = J_REST;
        a.stage = RS_AT;
        a.restKind = RK_PARKING;
      }
    }
    this.fleetChanged(a);
    return a;
  }

  private tie(vendor: string): Rng {
    let r = this.tiebreak.get(vendor);
    if (!r) {
      r = stream(this.seed, `tiebreak:${vendor}`);
      this.tiebreak.set(vendor, r);
    }
    return r;
  }

  private ensureCapacity(n: number): void {
    if (n <= this.cap) return;
    let cap = Math.max(64, this.cap);
    while (cap < n) cap *= 2;
    const ready = new Int32Array(cap).fill(-1);
    ready.set(this.ready);
    this.ready = ready;
    this.plan = createPlan(cap);
    const posOf = new Int32Array(cap).fill(-1);
    posOf.set(this.posOf);
    this.posOf = posOf;
    while (this.byId.length < cap) this.byId.push(null);
    while (this.tviews.length < cap) this.tviews.push(null);
    this.tin.ready = this.ready;
    this.cap = cap;
  }

  // ── 2. orders and inbound pallets ──
  private orderArrivals(t: number): void {
    // PROTOCOL §8: exactly 4 draws per tick from `arrivals`; each int(28800) < perHour adds one order. Rate changes
    // never shift later draws. Saturate mode draws too (same stream position), then tops the queue up.
    for (let d = 0; d < ARRIVAL_DRAWS; d++) {
      const hit = this.arrivals.int(ARRIVAL_SCALE) < this.orderRate;
      if (hit && !this.saturate) this.newOrder(t);
    }
    if (this.saturate) {
      const target = SATURATE_MIN_QUEUE + SATURATE_ORDERS_PER_AGENT * this.pickingAgents;
      while (this.orders.queued < target) this.newOrder(t);
    }
    if (this.inboundEvery > 0 && t >= this.nextInbound) {
      this.nextInbound += this.inboundEvery;
      this.newInbound(t);
    }
  }

  private newOrder(t: number): void {
    const o = this.orders.create(t);
    this.events.push({ t: 'orderArrived', tick: t, order: o.id, lines: o.faces.length });
  }

  /** Inbound: one pallet every floor(7200 / inboundPerHour) ticks, docks in turn, put away to a seeded rack face. */
  private newInbound(t: number): void {
    const k = this.inboundCount++;
    const docks = this.world.docks;
    const dock = docks[k % docks.length].service;
    const face = this.reachFaces[scale(hash32(this.seed, k, 0, SALT_INBOUND), this.reachFaces.length)];
    this.addPalletTask({ kind: 'inbound', id: this.nextTask++, created: t, agent: -1, face, dock });
  }

  private addPalletTask(p: PalletTask): void {
    this.palletTasks.push(p);
    this.addTask(p);
  }

  private addTask(task: Task): void {
    this.tasks.push(task);
    this.taskById.set(task.id, task);
  }

  private removeTask(id: number): void {
    const task = this.taskById.get(id);
    if (!task) return;
    this.taskById.delete(id);
    const i = this.tasks.indexOf(task);
    if (i >= 0) this.tasks.splice(i, 1);
    if (task.kind === 'replenish' || task.kind === 'inbound') {
      const k = this.palletTasks.indexOf(task);
      if (k >= 0) this.palletTasks.splice(k, 1);
    }
    if (task.kind === 'pick' && task.amr) this.amrTasks--;
  }

  // ── 3. faults ──
  private applyFaults(t: number): void {
    for (const b of this.faults.due(t)) {
      const ti = AGENT_TYPES.indexOf(b.type);
      const id = this.spawnOrder[ti][b.n];
      const a = id === undefined ? null : this.byId[id];
      if (!a || a.brokenUntil > 0) continue;
      if (a.to >= 0) a.breakPending = b.forTicks;
      else this.breakAgent(a, b.forTicks, t);
    }
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.brokenUntil > 0 && t >= a.brokenUntil) {
        a.brokenUntil = 0;
        this.events.push({ t: 'repair', tick: t, agent: a.id });
      } else if (a.breakPending > 0 && a.to < 0) {
        const n = a.breakPending;
        a.breakPending = 0;
        this.breakAgent(a, n, t);
      }
    }
  }

  /** Breakdown: the agent stops and holds its cell for `ticks`; its batch goes back to the queue (orders re-picked). */
  private breakAgent(a: CoreAgent, ticks: number, t: number): void {
    this.dropJob(a, t);
    a.brokenUntil = t + ticks;
    this.events.push({ t: 'breakdown', tick: t, agent: a.id });
  }

  // ── 5, 6. traffic ──
  private runTraffic(t: number): void {
    const tin = this.tin;
    tin.tick = t;
    const ready = this.ready;
    for (let i = 0; i < this.robots.length; i++) {
      const r = this.robots[i];
      const v = this.tviews[r.id]!;
      // below 10%: drop the task at this cell boundary (not while being picked into) and go to charge
      if (r.needCharge === 2 && r.to < 0 && r.brokenUntil === 0 && r.dwellUntil === 0 && (r.job === J_PICK || r.job === J_PALLET || r.job === J_SERVE)) {
        const served = r.job === J_PICK && r.partner >= 0 && this.byId[r.partner]?.stage === SV_PICKING;
        if (!served) this.dropJob(r, t);
      }
      const travel = r.goal >= 0 && r.brokenUntil === 0 && r.dwellUntil === 0 && !this.atGoal(r);
      v.cell = r.cell;
      v.heading = r.heading;
      v.vendor = r.vendor;
      v.goal = travel ? r.goal : -1;
      v.sinceProgress = r.sinceProgress;
      v.blockedSinceProgress = r.blockedSinceProgress;
      // A forklift needs no safety cell for the move that ends at its stop (it is braking to a halt there).
      v.safetyCells = r.safetyCells > 0 && travel && this.nearStop(r) ? 0 : r.safetyCells;
      ready[r.id] = travel && r.to < 0 ? t : -1;
      if (!travel && this.pushable(r)) {
        // A robot waiting at its stop or resting on open floor stands at its own goal: the planner may push it out of
        // the way (robots yield to people, PIBT pushes); it comes back. It is not trying to progress, so no ladder.
        v.goal = r.cell;
        v.sinceProgress = 0;
        v.blockedSinceProgress = 0;
        ready[r.id] = t;
        r.parkReady = t;
      }
    }
    // Rule 2: a blocked person asks the robot in the way to make way.
    const yields = this.yields;
    yields.length = 0;
    for (let i = 0; i < this.people.length; i++) {
      const p = this.people[i];
      if (p.blockedAt !== t || p.waitOn < 0) continue;
      const h = this.byId[p.waitOn];
      if (h && h.robot && ready[h.id] === t) yields.push(h.id, p.cell);
    }
    if (this.orderDirty) this.sortOrder();

    const rec = this.traffic.recover(tin);
    for (const r of rec.resets) this.applyReset(r.agent, r.cell, t);
    for (const id of rec.retasks) this.applyRetask(id, t);
    if (this.orderDirty) this.sortOrder(); // a re-task draws a new goal tick and tie-break

    const plan = this.plan;
    clearPlan(plan);
    this.traffic.plan(tin, plan);
    for (let i = 0; i < this.robots.length; i++) {
      const r = this.robots[i];
      if (ready[r.id] !== t) continue;
      const m = plan.moveTo[r.id];
      if (r.parkReady === t) {
        r.want = -1;
        if (m >= 0 && this.startRobotMove(r, m, plan.safety[r.id], plan.dir[r.id], t)) this.pushedOff(r, t);
        continue;
      }
      r.want = plan.want[r.id] >= 0 ? plan.want[r.id] : m;
      if (m >= 0 && this.startRobotMove(r, m, plan.safety[r.id], plan.dir[r.id], t)) continue;
      r.blockedAt = t;
      r.waitOn = r.want >= 0 && this.occ[r.want] >= 0 && this.occ[r.want] !== r.id ? this.occ[r.want] : -1;
    }
    for (const e of plan.events) {
      if (e.t === 'safetyStop') this.events.push({ t: 'safetyStop', tick: t, agent: e.agent, cell: e.cell });
      else if (e.t === 'yield') {
        const person = this.occ[e.cell];
        if (person >= 0 && this.byId[person] && !this.byId[person]!.robot) this.events.push({ t: 'yield', tick: t, agent: e.agent, person });
      } else if (e.t === 'detour') this.counters.detours++;
      else this.counters.trafficStepAsides++;
    }
  }

  /** A stationary robot the planner may push: a cart robot waiting at a stop (not being picked into), or a robot with
   *  nothing to do resting on open floor (not in a pocket). */
  private pushable(r: CoreAgent): boolean {
    if (r.to >= 0 || r.brokenUntil > 0 || r.dwellUntil > 0 || this.world.isPocket[r.cell]) return false;
    // a held robot is pushable even when it is being removed: it still has its batch to finish
    if (r.job === J_PICK && (r.stage === PK_HOLD || r.stage === PK_ZONE_HOLD)) return r.goal < 0;
    if (r.removing) return false;
    if (r.job === J_REST) return r.stage === RS_AT;
    if (r.job === J_NONE) return true;
    if (r.job !== J_PICK || r.stage !== PK_AT_STOP || r.waiting !== 1 || !this.isAmrTask(r)) return false;
    const w = r.partner >= 0 ? this.byId[r.partner] : null;
    return !w || (w.stage !== SV_PICKING && w.stage !== SV_WAIT_STOCK);
  }

  /** A pushed robot: a cart robot heads back to its stop (its picker, if any, stays paired); a resting robot rests
   *  wherever it ends up. */
  private pushedOff(r: CoreAgent, t: number): void {
    this.counters.pushedOff++;
    if (r.job === J_PICK && (r.stage === PK_HOLD || r.stage === PK_ZONE_HOLD)) return; // still held, wherever it was pushed
    if (r.job === J_PICK) {
      const task = this.taskById.get(r.taskId) as PickTask;
      r.stage = PK_TO_STOP;
      r.waiting = 0;
      this.setGoal(r, this.world.faces[task.stops[task.stop].face].cell, G_NEAR, t);
    } else if (r.job === J_REST) {
      this.releaseRest(r);
      r.restKind = RK_STAY;
      r.stage = RS_AT;
    }
  }

  /** Planner priority (PROTOCOL §5): oldest goal tick, then the seeded tie-break drawn with the goal, then id. */
  private sortOrder(): void {
    const by = this.byId;
    this.order.sort((x, y) => {
      const a = by[x]!;
      const b = by[y]!;
      return a.goalTick - b.goalTick || a.tb - b.tb || x - y;
    });
    this.orderDirty = false;
  }

  private startRobotMove(r: CoreAgent, m: number, s: number, dir: number, t: number): boolean {
    const w = this.world;
    const v = r.cell;
    let d = dir;
    if (d < 0 || d > 3 || w.nbr[v * 4 + d] !== m) {
      d = -1;
      for (let k = 0; k < 4; k++) if (w.nbr[v * 4 + k] === m) d = k;
    }
    if (d < 0 || !r.pass[m]) {
      this.violations.badMove++;
      return false;
    }
    if (w.isPocket[m] && m !== r.goal) {
      this.violations.pocketNotGoal++;
      return false;
    }
    const h = this.occ[m] >= 0 ? this.occ[m] : s >= 0 && this.occ[s] >= 0 && this.occ[s] !== r.id ? this.occ[s] : -1;
    if (h >= 0) {
      this.violations.moveIntoHeld++;
      if (this.byId[h] && !this.byId[h]!.robot) this.violations.robotIntoPerson++;
      return false;
    }
    if (s >= 0 && (!this.open[s] || s === v)) s = -1;
    this.doMove(r, m, s, d, t);
    return true;
  }

  private applyReset(id: number, cell: number, t: number): void {
    const r = this.byId[id];
    if (!r || !r.robot || r.to >= 0 || r.brokenUntil > 0 || cell < 0 || cell >= this.world.n) return;
    if (this.occ[cell] >= 0 || !r.pass[cell] || (this.world.isPocket[cell] && cell !== r.goal)) return;
    if (this.occ[r.cell] === r.id) this.occ[r.cell] = -1;
    r.cell = cell;
    this.occ[cell] = r.id;
    r.carry = 0;
    r.blockedTicks = 0;
    r.sinceProgress = 0;
    r.blockedSinceProgress = 0;
    if (r.goal >= 0) r.bestDist = this.dist.to(r.distCls, r.goal)[cell];
    this.refreshView(r, t);
    this.counters.resets++;
    this.events.push({ t: 'manualReset', tick: t, agent: id });
  }

  /** Fleet-manager job timeout: another station or job (PROTOCOL §5). Emits `retask` only when the goal changes. */
  private applyRetask(id: number, t: number): void {
    const r = this.byId[id];
    if (!r || !r.robot || r.brokenUntil > 0) return;
    const before = r.goal;
    if (r.job === J_PICK && r.stage === PK_TO_PACK) {
      const task = this.taskById.get(r.taskId) as PickTask;
      const s = this.pack.leastLoaded((st) => this.dist.to(r.distCls, st.service)[r.cell], task.station, (st) => this.packQueue(st.id) < PACK_QUEUE_SLOTS);
      if (s >= 0 && s !== task.station) {
        this.pack.stations[task.station].load -= task.orders.length;
        this.pack.stations[s].load += task.orders.length;
        task.station = s;
        for (const oid of task.orders) this.orders.open.get(oid)!.station = s;
        this.setGoal(r, this.pack.stations[s].service, G_STATION, t, s);
      }
    } else if (r.job === J_PICK && r.stage === PK_TO_STOP) {
      const task = this.taskById.get(r.taskId) as PickTask;
      if (task.stops.length - task.stop >= 2) {
        const [cur] = task.stops.splice(task.stop, 1);
        task.stops.push(cur);
        this.releasePartner(r);
        // the rotated stop list goes through zone admission like any next stop
        if (this.admitStop(r, task)) this.setGoal(r, this.world.faces[task.stops[task.stop].face].cell, G_NEAR, t);
        else this.zoneHoldCarrier(r, t);
      }
    } else if (r.job === J_PALLET && r.stage === PL_TO_DOCK) {
      const task = this.taskById.get(r.taskId) as PalletTask;
      const cell = this.world.faces[task.face].cell;
      let best = -1;
      let bestD = UNREACHABLE;
      for (const dk of this.world.docks) {
        if (dk.service === task.dock) continue;
        const d = this.dist.to('forklift', dk.service)[cell];
        if (d < bestD) {
          bestD = d;
          best = dk.service;
        }
      }
      if (best >= 0) {
        task.dock = best;
        this.setGoal(r, best, G_EXACT, t);
      }
    } else if (r.job === J_CHARGE && r.stage === CH_TO) {
      const p = this.nearestFreeCharger(r, r.charger);
      if (p >= 0) {
        this.chargerHolder[r.charger] = -1;
        this.chargerHolder[p] = r.id;
        r.charger = p;
        this.setGoal(r, this.world.chargers[p].cell, G_EXACT, t);
      }
    }
    if (r.goal !== before && r.goal >= 0) {
      this.counters.retasks++;
      this.events.push({ t: 'retask', tick: t, agent: id, goal: r.goal });
      this.refreshView(r, t);
    }
  }

  /** After a reset or a re-task, the planner's view of the robot is rebuilt exactly as phase 5 builds it: new cell and
   *  goal, fresh progress counters (the planner must not start a detour from stale ones), the final-stop safety rule. */
  private refreshView(r: CoreAgent, t: number): void {
    const v = this.tviews[r.id]!;
    const travel = r.goal >= 0 && r.dwellUntil === 0 && !this.atGoal(r);
    v.cell = r.cell;
    v.heading = r.heading;
    v.goal = travel ? r.goal : -1;
    v.sinceProgress = r.sinceProgress;
    v.blockedSinceProgress = r.blockedSinceProgress;
    v.safetyCells = r.safetyCells > 0 && travel && this.nearStop(r) ? 0 : r.safetyCells;
    this.ready[r.id] = travel && r.to < 0 ? t : -1;
  }

  // ── goals ──
  private setGoal(a: CoreAgent, cell: number, mode: number, t: number, station = -1): void {
    a.goal = cell;
    a.goalMode = mode;
    a.goalStation = station;
    a.goalTick = t;
    a.laneX = -1;
    a.goalHold = !a.robot && (mode === G_STATION || mode === G_EXACT) ? 1 : 0;
    a.bestDist = this.dist.to(a.distCls, cell)[a.to >= 0 ? a.to : a.cell];
    a.sinceProgress = 0;
    a.blockedSinceProgress = 0;
    a.pBlocked = 0;
    if (a.robot) {
      a.tb = this.tie(a.vendor).u32() >>> 11;
      this.orderDirty = true;
    }
  }

  private clearGoal(a: CoreAgent): void {
    a.goal = -1;
    a.goalMode = G_EXACT;
    a.goalStation = -1;
    a.laneX = -1;
    a.goalHold = 0;
  }

  /** Would the agent stop on cell j (an arrival cell for its goal)? Used to drop the safety cell on the final move. */
  stopsAt(a: CoreAgent, j: number): boolean {
    if (a.goal < 0) return false;
    if (j === a.goal) return true;
    if (a.goalMode === G_EXACT) return false;
    if (a.goalMode === G_STATION) return this.pack.stationAt[j] === a.goalStation + 1;
    const reach = a.goalMode === G_REACH ? 2 : 1;
    return this.dist.to(a.distCls, a.goal)[j] <= reach && (a.goalMode === G_MEET || (this.occ[a.goal] >= 0 && this.occ[a.goal] !== a.id));
  }

  /** Is some neighbour of the agent's cell a stop for it (so its next move may be the last)? */
  private nearStop(a: CoreAgent): boolean {
    for (let d = 0; d < 4; d++) {
      const j = this.world.nbr[a.cell * 4 + d];
      if (j >= 0 && a.pass[j] && this.stopsAt(a, j)) return true;
    }
    return false;
  }

  /** Has the agent reached its travel goal (for its goal mode)? Only meaningful at a cell boundary. */
  atGoal(a: CoreAgent): boolean {
    if (a.goal < 0) return false;
    switch (a.goalMode) {
      case G_NEAR:
      case G_REACH: {
        if (a.cell === a.goal) return true;
        const h = this.occ[a.goal];
        const d = this.dist.to(a.distCls, a.goal)[a.cell];
        return h >= 0 && h !== a.id && (d === 1 || (a.goalMode === G_REACH && d === 2));
      }
      case G_MEET:
        return this.dist.to(a.distCls, a.goal)[a.cell] <= 1;
      case G_STATION:
        return this.pack.stationAt[a.cell] === a.goalStation + 1;
      default:
        return a.cell === a.goal;
    }
  }

  // ── 7. arrivals, dwells, task progress, assignment ──
  private progress(t: number): void {
    if (this.zonesDirty) this.rebuildZones();
    const agents = this.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.brokenUntil > 0 || a.to >= 0) continue;
      if (a.dwellUntil > 0) {
        a.lastWork = t;
        if (a.job === J_SERVE && a.partner >= 0) {
          const amr = this.byId[a.partner];
          if (amr) amr.lastWork = t;
        }
        if (a.dwellStart < t && t + 1 >= a.dwellUntil) this.endDwell(a, t);
        if (a.dwellUntil > 0) continue;
      }
      // a cart assigned mid-step starts its setup now that it stands still
      if (a.job === J_PICK && a.stage === PK_SETUP) {
        this.startDwell(a, this.setupTicks, t);
        continue;
      }
      // Critical battery: drop the task at this safe point (not moving, not dwelling, not being picked into).
      if (a.needCharge === 2 && (a.job === J_PICK || a.job === J_PALLET || a.job === J_SERVE)) {
        const served = a.job === J_PICK && a.partner >= 0 && this.byId[a.partner]?.stage === SV_PICKING;
        if (!served) this.dropJob(a, t);
      }
      if (a.waiting === 1 && a.goal < 0) {
        if (a.job === J_PICK && a.stage === PK_AT_STOP && !this.isAmrTask(a)) this.tryCartPick(a, t);
        else if (a.job === J_SERVE && a.stage === SV_WAIT_STOCK) this.tryServe(a, t);
        else if (a.job === J_SERVE && a.stage === SV_WAIT_AMR) {
          // a meeting that can't happen: the robot it waits for has been blocked MEET_GIVEUP_TICKS (often by the
          // waiting picker itself, standing in the aisle): give it up and stand down like an idle person
          const r = this.byId[a.partner];
          if (r && r.partner === a.id && r.stage === PK_TO_STOP && r.blockedTicks >= MEET_GIVEUP_TICKS) {
            r.partner = -1;
            this.freeAgent(a);
            this.counters.meetsGivenUp++;
          } else this.checkMeet(a, t);
        }
      }
      // A cart robot whose picker already waits right beside it, within 2 cells of the face, stops there to be picked.
      if (a.job === J_PICK && a.stage === PK_TO_STOP && a.partner >= 0 && a.goal >= 0) {
        const wk = this.byId[a.partner];
        if (wk && wk.stage === SV_WAIT_AMR && this.dist.to(a.distCls, wk.cell)[a.cell] === 1 && this.dist.to(a.distCls, a.goal)[a.cell] <= 2) {
          this.arrive(a, t);
          continue;
        }
      }
      if (a.goal >= 0 && this.atGoal(a)) this.arrive(a, t);
    }
    this.releaseZoneHold(t);
    this.releasePackHold(t);
    this.matchZones(t);
    this.assign(t);
    this.packAndShip(t);
  }

  private isAmrTask(a: CoreAgent): boolean {
    const task = this.taskById.get(a.taskId);
    return !!task && task.kind === 'pick' && task.amr;
  }

  private startDwell(a: CoreAgent, ticks: number, t: number): void {
    a.dwellStart = t;
    a.dwellUntil = t + Math.max(1, ticks);
    a.lastWork = t;
  }

  private arrive(a: CoreAgent, t: number): void {
    this.clearGoal(a);
    switch (a.job) {
      case J_PICK: {
        if (a.stage === PK_TO_STOP) {
          a.stage = PK_AT_STOP;
          if (this.isAmrTask(a)) {
            a.waiting = 1; // for the zone's picker (matchZones; it may already be on its way), or for stock
            a.waitSince = t;
            // a picker already walking to the face re-aims at where the robot actually stopped
            const wk = a.partner >= 0 ? this.byId[a.partner] : null;
            if (wk && wk.partner === a.id && wk.stage === SV_TO_AMR && wk.goal !== a.cell) this.sendToMeet(wk, a, t);
          } else this.tryCartPick(a, t);
        } else if (a.stage === PK_HOLD || a.stage === PK_ZONE_HOLD) {
          // reached its holding cell: keep waiting for a pack slot / room in a zone
        } else if (a.stage === PK_TO_PACK) {
          a.stage = PK_HANDOFF;
          // a cart robot hands its totes off in one go (its spec handoffSec); a person unloads a cart tote by tote
          const task = this.taskById.get(a.taskId) as PickTask;
          this.startDwell(a, task.amr ? a.handoffTicks : task.orders.length * this.toteHandoffTicks, t);
        }
        break;
      }
      case J_SERVE:
        if (a.stage === SV_TO_AMR) this.checkMeet(a, t);
        break;
      case J_PALLET:
        if (a.stage === PL_TO_DOCK) {
          a.stage = PL_LOAD;
          this.startDwell(a, a.palletTicks, t);
        } else if (a.stage === PL_TO_FACE) {
          a.stage = PL_UNLOAD;
          this.startDwell(a, a.palletTicks, t);
        }
        break;
      case J_CHARGE:
        if (a.stage === CH_TO && a.charger >= 0 && a.cell === this.world.chargers[a.charger].cell) {
          a.stage = CH_ON;
          a.waiting = 0;
          this.events.push({ t: 'chargeStart', tick: t, agent: a.id, charger: a.charger });
        }
        break;
      case J_REST:
        a.stage = RS_AT;
        break;
    }
  }

  private endDwell(a: CoreAgent, t: number): void {
    a.dwellUntil = 0;
    const units = a.dwellUnits;
    a.dwellUnits = 0;
    switch (a.job) {
      case J_PICK: {
        const task = this.taskById.get(a.taskId) as PickTask;
        if (a.stage === PK_AT_STOP) {
          this.consumeStop(task, units, a, t);
          if (this.stopLeft(task) > 0) this.tryCartPick(a, t);
          else this.nextStop(a, task, t);
        } else if (a.stage === PK_HANDOFF) this.deliver(a, task, t);
        else if (a.stage === PK_SETUP) {
          a.stage = PK_TO_STOP;
          this.setGoal(a, this.world.faces[task.stops[task.stop].face].cell, G_NEAR, t);
        }
        break;
      }
      case J_SERVE: {
        const amr = this.byId[a.partner]!;
        const task = this.taskById.get(amr.taskId) as PickTask;
        this.consumeStop(task, units, a, t);
        if (this.stopLeft(task) > 0) this.tryServe(a, t);
        else {
          amr.partner = -1;
          this.freeAgent(a);
          this.nextStop(amr, task, t);
        }
        break;
      }
      case J_PALLET: {
        const task = this.taskById.get(a.taskId) as PalletTask;
        if (a.stage === PL_LOAD) {
          a.cargo = C_PALLET;
          a.stage = PL_TO_FACE;
          this.setGoal(a, this.world.faces[task.face].cell, G_REACH, t);
        } else if (a.stage === PL_UNLOAD) {
          a.cargo = C_NONE;
          this.events.push({ t: 'palletMoved', tick: t, agent: a.id, kind: task.kind });
          if (task.kind === 'replenish') {
            const L = this.linesPerReplenish;
            this.stock[task.face] = Math.min(2 * L, this.stock[task.face] + L);
            this.replenOpen[task.face] = -1;
            this.checkReplenish(task.face, t);
          }
          this.removeTask(task.id);
          this.freeAgent(a);
        }
        break;
      }
    }
  }

  private stopLeft(task: PickTask): number {
    const s = task.stops[task.stop];
    let n = 0;
    for (const x of s.left) n += x;
    return n;
  }

  /** `units` picked at the current stop: pickDone per order (oldest order's lines first). */
  private consumeStop(task: PickTask, units: number, picker: CoreAgent, t: number): void {
    const s = task.stops[task.stop];
    let u = units;
    for (let k = 0; k < s.orders.length && u > 0; k++) {
      const take = Math.min(u, s.left[k]);
      if (take <= 0) continue;
      s.left[k] -= take;
      u -= take;
      this.events.push({ t: 'pickDone', tick: t, agent: picker.id, order: s.orders[k], units: take });
    }
    s.picked += units;
    task.pickedBy[picker.type] += units;
  }

  /** Take up to `want` units from a face. A pick at an empty face waits for the replenishment. */
  private takeStock(face: number, want: number, t: number): number {
    const st = this.stock[face];
    if (st < 0) return want;
    const units = Math.min(want, st);
    this.stock[face] = st - units;
    this.checkReplenish(face, t);
    return units;
  }

  private checkReplenish(face: number, t: number): void {
    const L = this.linesPerReplenish;
    if (L <= 0 || this.stock[face] < 0 || this.stock[face] > L || this.replenOpen[face] >= 0) return;
    const id = this.nextTask++;
    this.replenOpen[face] = id;
    this.addPalletTask({ kind: 'replenish', id, created: t, agent: -1, face, dock: this.faceDock[face] });
  }

  private tryCartPick(a: CoreAgent, t: number): void {
    const task = this.taskById.get(a.taskId) as PickTask;
    const units = this.takeStock(task.stops[task.stop].face, this.stopLeft(task), t);
    if (units > 0) {
      a.waiting = 0;
      a.dwellUnits = units;
      // a multi-order cart: each unit is also scanned and sorted into its order's tote (put-to-cart)
      this.startDwell(a, units * (a.pickTicks + (task.orders.length > 1 ? this.putTicks : 0)), t);
    } else if (a.waiting === 0) {
      a.waiting = 1;
      a.waitSince = t;
    }
  }

  private tryServe(w: CoreAgent, t: number): void {
    const amr = this.byId[w.partner]!;
    const task = this.taskById.get(amr.taskId) as PickTask;
    const units = this.takeStock(task.stops[task.stop].face, this.stopLeft(task), t);
    if (units > 0) {
      w.stage = SV_PICKING;
      w.waiting = 0;
      w.dwellUnits = units;
      this.startDwell(w, units * w.assistTicks, t);
      amr.waiting = 0;
      amr.lastWork = t;
    } else {
      w.stage = SV_WAIT_STOCK;
      if (w.waiting === 0) {
        w.waiting = 1;
        w.waitSince = t;
      }
    }
  }

  private nextStop(carrier: CoreAgent, task: PickTask, t: number): void {
    carrier.waiting = 0;
    task.stop++;
    if (task.stop < task.stops.length) {
      if (!this.admitStop(carrier, task)) {
        this.zoneHoldCarrier(carrier, t);
        return;
      }
      carrier.stage = PK_TO_STOP;
      this.setGoal(carrier, this.world.faces[task.stops[task.stop].face].cell, G_NEAR, t);
      return;
    }
    // All lines picked: the WMS releases the tote(s) to the least-loaded pack station with a free queue slot
    // (PROTOCOL §5 rule 8 plus pack admission); with none free, the carrier holds (PACK_QUEUE_SLOTS).
    if (this.packHold.length === 0 && this.sendToPack(carrier, task, t)) return;
    carrier.stage = PK_HOLD;
    carrier.waiting = 1;
    carrier.waitSince = t;
    // first in, first out by hold tick, then id
    let slot = this.packHold.length;
    while (slot > 0) {
      const prev = this.byId[this.packHold[slot - 1]];
      if (!prev || prev.waitSince < t || prev.id < carrier.id) break;
      slot--;
    }
    this.packHold.splice(slot, 0, carrier.id);
    this.clearGoal(carrier);
    // hold out of the main and cross aisles: stay on a pick-aisle cell, or move to the nearest free one
    this.goToHoldCell(carrier, t);
  }

  /** Every remaining zone is full: hold (pushable, state 'wait') until one has room, on a pick-aisle cell (moving to the
   *  nearest free one if the carrier stands on a main or cross aisle). */
  private zoneHoldCarrier(carrier: CoreAgent, t: number): void {
    carrier.stage = PK_ZONE_HOLD;
    carrier.waiting = 1;
    carrier.waitSince = t;
    this.clearGoal(carrier);
    this.zoneHold.push(carrier.id);
    this.goToHoldCell(carrier, t);
  }

  private goToHoldCell(carrier: CoreAgent, t: number): void {
    const at = carrier.to >= 0 ? carrier.to : carrier.cell;
    if (this.world.faceAt[at] >= 0) return;
    const c = this.findHoldCell(carrier);
    if (c < 0) return;
    this.restHolder[c] = carrier.id;
    carrier.restCell = c;
    this.setGoal(carrier, c, G_EXACT, t);
  }

  private releaseHoldCell(a: CoreAgent): void {
    if (a.restCell < 0) return;
    if (this.restHolder[a.restCell] === a.id) this.restHolder[a.restCell] = -1;
    a.restCell = -1;
  }

  /** Carriers (cart robots and manual carts) heading to or handing off at pack station s. */
  private packQueue(s: number): number {
    let n = 0;
    for (const a of this.agents) {
      if (a.job !== J_PICK || (a.stage !== PK_TO_PACK && a.stage !== PK_HANDOFF)) continue;
      const task = this.taskById.get(a.taskId) as PickTask;
      if (task.station === s) n++;
    }
    return n;
  }

  /** Send a carrier with a full batch to the least-loaded station that has a free queue slot; false if none. */
  private sendToPack(carrier: CoreAgent, task: PickTask, t: number): boolean {
    const from = carrier.to >= 0 ? carrier.to : carrier.cell;
    const s = this.pack.leastLoaded((st) => this.dist.to(carrier.distCls, st.service)[from], -1, (st) => this.packQueue(st.id) < PACK_QUEUE_SLOTS);
    if (s < 0) return false;
    this.releaseHoldCell(carrier);
    task.station = s;
    this.pack.stations[s].load += task.orders.length;
    for (const oid of task.orders) this.orders.open.get(oid)!.station = s;
    carrier.stage = PK_TO_PACK;
    carrier.waiting = 0;
    this.setGoal(carrier, this.pack.stations[s].service, G_STATION, t, s);
    return true;
  }

  /** Release held carriers first in, first out (ready tick, then id) while stations have free slots. */
  private releasePackHold(t: number): void {
    while (this.packHold.length > 0) {
      const a = this.byId[this.packHold[0]];
      if (!a || a.job !== J_PICK || a.stage !== PK_HOLD || a.brokenUntil > 0) {
        this.packHold.shift();
        continue;
      }
      if (!this.sendToPack(a, this.taskById.get(a.taskId) as PickTask, t)) return;
      this.packHold.shift();
    }
  }

  /** Nearest free pick-aisle (face) cell to hold on, by BFS over the carrier's cells; -1 if none. */
  private findHoldCell(a: CoreAgent): number {
    const w = this.world;
    const st = ++this.stamp;
    const q = this.bfsQueue;
    const seen = this.bfsStamp;
    const start = a.to >= 0 ? a.to : a.cell;
    let head = 0;
    let tail = 0;
    q[tail++] = start;
    seen[start] = st;
    while (head < tail) {
      const u = q[head++];
      if (w.faceAt[u] >= 0 && this.occ[u] < 0 && this.restHolder[u] < 0) return u;
      for (let d = 0; d < 4; d++) {
        const j = w.nbr[u * 4 + d];
        if (j < 0 || !a.pass[j] || w.isPocket[j] || seen[j] === st) continue;
        seen[j] = st;
        q[tail++] = j;
      }
    }
    return -1;
  }

  private deliver(a: CoreAgent, task: PickTask, t: number): void {
    const st = this.pack.stations[task.station];
    this.events.push({ t: 'toteDelivered', tick: t, agent: a.id, station: st.id });
    for (const oid of task.orders) {
      const o = this.orders.open.get(oid)!;
      o.stage = OS_PACK;
      o.task = -1;
      st.queue.push(oid);
    }
    // units count once, when they reach packing: a dropped and re-picked batch is never counted twice
    for (let k = 0; k < task.pickedBy.length; k++) this.unitsPicked[k] += task.pickedBy[k];
    a.cargo = C_NONE;
    this.removeTask(task.id);
    this.freeAgent(a);
  }

  private freeAgent(a: CoreAgent): void {
    a.job = J_NONE;
    a.stage = 0;
    a.taskId = -1;
    a.partner = -1;
    a.waiting = 0;
    a.dwellUntil = 0;
    a.dwellUnits = 0;
    this.clearGoal(a);
  }

  /** Units taken from a face for a pick dwell that is cut short go back on the face (capped at its capacity). */
  private returnDwellUnits(a: CoreAgent, task: PickTask): void {
    if (a.dwellUntil <= 0 || a.dwellUnits <= 0 || task.stop >= task.stops.length) return;
    const face = task.stops[task.stop].face;
    if (this.stock[face] >= 0) this.stock[face] = Math.min(2 * this.linesPerReplenish, this.stock[face] + a.dwellUnits);
    a.dwellUnits = 0;
  }

  /** Cancel whatever the agent is doing (breakdown, critical battery, leaving). Orders go back to the queue, pallet
   *  moves back to the open list, reservations are released. */
  private dropJob(a: CoreAgent, t: number): void {
    switch (a.job) {
      case J_PICK: {
        const task = this.taskById.get(a.taskId) as PickTask | undefined;
        if (task) {
          if (task.station >= 0) this.pack.stations[task.station].load -= task.orders.length;
          // the totes are emptied back onto their faces, and the orders are released again
          const L2 = 2 * this.linesPerReplenish;
          for (const st of task.stops) if (st.picked > 0 && this.stock[st.face] >= 0) this.stock[st.face] = Math.min(L2, this.stock[st.face] + st.picked);
          // ... and so do the units of a pick cut short (taken at the start of the dwell, counted only at its end)
          this.returnDwellUnits(a, task);
          this.orders.requeue(task.orders);
          if (a.partner >= 0) {
            const wk = this.byId[a.partner];
            if (wk && wk.partner === a.id) {
              this.returnDwellUnits(wk, task);
              this.freeAgent(wk);
            }
          }
          this.removeTask(task.id);
        }
        if (a.stage === PK_ZONE_HOLD) {
          const k = this.zoneHold.indexOf(a.id);
          if (k >= 0) this.zoneHold.splice(k, 1);
        }
        if (a.stage === PK_HOLD) {
          const k = this.packHold.indexOf(a.id);
          if (k >= 0) this.packHold.splice(k, 1);
        }
        if (a.stage === PK_HOLD || a.stage === PK_ZONE_HOLD) this.releaseHoldCell(a);
        a.cargo = C_NONE;
        break;
      }
      case J_SERVE: {
        const amr = this.byId[a.partner];
        if (amr && amr.partner === a.id) {
          const task = this.taskById.get(amr.taskId) as PickTask | undefined;
          if (task) this.returnDwellUnits(a, task);
          amr.partner = -1;
          amr.waiting = 1;
        }
        break;
      }
      case J_PALLET: {
        const task = this.taskById.get(a.taskId) as PalletTask | undefined;
        if (task) task.agent = -1;
        a.cargo = C_NONE;
        break;
      }
      case J_CHARGE:
        if (a.stage === CH_ON) this.events.push({ t: 'chargeEnd', tick: t, agent: a.id });
        if (a.charger >= 0) this.chargerHolder[a.charger] = -1;
        a.charger = -1;
        this.removeTask(a.taskId);
        break;
      case J_REST:
        this.releaseRest(a);
        break;
    }
    this.freeAgent(a);
  }

  // ── zone workers meet cart robots (the Locus model) ──
  private zoneMode(): boolean {
    return this.activeAmrs > 0 || this.amrTasks > 0;
  }

  private rebuildZones(): void {
    this.zonesDirty = false;
    // Zone membership changes only with the fleet; a broken or charging worker's zone is covered by its team mate and
    // its neighbours (zone bleed in matchZones), so one humanoid going to charge never rezones the floor.
    // A worker's share of the work is its pick rate times the share of the time it is not charging (a humanoid with
    // 2 h of runtime and 1 h of charging picks two thirds of the time), so a zone of humanoids is sized for what
    // they actually deliver.
    const workers = this.agents
      .filter((a) => (a.type === T_PICKER || a.type === T_HUMANOID) && !a.removing && a.pickTicks > 0)
      .map((a) => ({ id: a.id, weight: Math.floor((1_000_000 / a.assistTicks) * (a.batteryMax > 0 ? a.batteryMax / (a.batteryMax + a.chargeC) : 1)) }));
    this.zones = computeZones(this.world, this.zoneOrder, this.zoneWeights, workers, ZONE_PICKERS);
    this.zoneLoadTick = -1;
    // a zone takes ZONE_MAX_AMRS robots per worker, but no more than its aisle space holds (ZONE_FACES_PER_AMR faces each)
    const faces = new Array<number>(this.zones.members.length).fill(0);
    for (let f = 0; f < this.zones.faceZone.length; f++) if (this.zones.faceZone[f] >= 0) faces[this.zones.faceZone[f]]++;
    this.zoneCap = this.zones.members.map((m, z) => Math.max(2, Math.min(ZONE_MAX_AMRS * m.length, Math.floor(faces[z] / ZONE_FACES_PER_AMR))));
    for (const a of this.agents) a.zone = -1;
    this.zones.workers.forEach((id, k) => (this.byId[id]!.zone = k));
    // Resting zone workers re-plan where to wait (their zone may have moved).
    for (const a of this.agents)
      if ((a.type === T_PICKER || a.type === T_HUMANOID) && a.job === J_REST) {
        this.releaseRest(a);
        this.freeAgent(a);
      }
  }

  /**
   * Zone workers meet cart robots. A free worker goes to the cart robot in its zone it can meet soonest: one already
   * waiting at a face (key: the worker's distance to it), or one on its way to a face in the zone and at most
   * PRESEND_CELLS from it (key: the later of the two arrivals, in cells, so the picker is there when the robot is).
   * Ties: longest wait, then id. A worker already walking switches to a robot it can meet strictly sooner (it serves
   * the robot in front of it), so it is never stuck behind robots it could be picking for.
   */
  private matchZones(t: number): void {
    if (!this.zones || !this.zoneMode()) return;
    const fz = this.zones.faceZone;
    const buckets = this.zoneCands;
    while (buckets.length < this.zones.members.length) buckets.push([]);
    for (const b of buckets) b.length = 0;
    let any = false;
    for (const r of this.robots) {
      if (r.type !== T_AMR || r.job !== J_PICK || r.partner >= 0 || r.brokenUntil > 0) continue;
      if (r.stage !== PK_AT_STOP && r.stage !== PK_TO_STOP) continue;
      // a robot still blocked past MEET_GIVEUP_TICKS is not offered again (its picker just gave the meeting up)
      if (r.stage === PK_TO_STOP && r.blockedTicks >= MEET_GIVEUP_TICKS) continue;
      // a robot on its way counts once it is within PRESEND_CELLS of the face (bestDist = cells to go, at a boundary)
      if (r.stage === PK_TO_STOP && r.bestDist > PRESEND_CELLS) continue;
      const task = this.taskById.get(r.taskId) as PickTask;
      if (!task.amr) continue;
      const face = task.stops[task.stop].face;
      if (this.stock[face] === 0) continue; // waits for the replenishment first
      const z = fz[face];
      if (z < 0) continue;
      buckets[z].push(r);
      any = true;
    }
    if (!any) return;
    const nz = buckets.length;
    for (const id of this.zones.workers) {
      const w = this.byId[id]!;
      const z = this.zones.workerZone[w.zone];
      if (buckets[z].length === 0 && (z === 0 || buckets[z - 1].length === 0) && (z === nz - 1 || buckets[z + 1].length === 0)) continue;
      const walking = w.job === J_SERVE && (w.stage === SV_TO_AMR || w.stage === SV_WAIT_AMR) && w.to < 0;
      if (!walking && (!this.isFree(w) || w.removing || w.needCharge > 0)) continue;
      let best: CoreAgent | null = null;
      let bestKey = 0;
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= nz) continue;
        for (const r of buckets[zz]) {
          if (r.partner >= 0) continue;
          // zone bleed: a robot already waiting BLEED_WAIT_TICKS in a neighbouring zone, at a small distance penalty
          if (dz !== 0 && (r.stage !== PK_AT_STOP || t - r.waitSince < BLEED_WAIT_TICKS)) continue;
          let key = this.meetKey(w, r);
          if (key < 0) continue;
          key -= this.waitCredit(r, t);
          if (dz !== 0) key += 2 * BLEED_PENALTY_CELLS;
          if (!best || key < bestKey || (key === bestKey && (r.waitSince < best.waitSince || (r.waitSince === best.waitSince && r.id < best.id)))) {
            best = r;
            bestKey = key;
          }
        }
      }
      if (!best) continue;
      if (walking) {
        const cur = this.byId[w.partner];
        if (cur && cur.partner === w.id) {
          const k0 = this.meetKey(w, cur);
          const k = k0 < 0 ? k0 : k0 - this.waitCredit(cur, t);
          if (k0 >= 0 && k <= bestKey) continue;
          cur.partner = -1;
        }
      } else this.releaseRest(w);
      w.job = J_SERVE;
      w.taskId = best.taskId;
      w.partner = best.id;
      best.partner = w.id;
      this.sendToMeet(w, best, t);
    }
  }

  /** How soon worker w can meet cart robot r (twice the cells, +1 for a robot still on its way, more while it is
   *  blocked), or -1 if it can't. */
  /** A robot waiting at its stop moves up the queue the longer it waits: one cell per WAIT_CREDIT_TICKS waited,
   *  at most WAIT_CREDIT_MAX_CELLS (in meet-key units, twice the cells). Without it a far robot in an edge zone could
   *  wait a quarter of an hour behind nearer ones. */
  private waitCredit(r: CoreAgent, t: number): number {
    if (r.stage !== PK_AT_STOP) return 0;
    const cells = Math.floor((t - r.waitSince) / WAIT_CREDIT_TICKS);
    return 2 * (cells < WAIT_CREDIT_MAX_CELLS ? cells : WAIT_CREDIT_MAX_CELLS);
  }

  private meetKey(w: CoreAgent, r: CoreAgent): number {
    const from = w.to >= 0 ? w.to : w.cell;
    if (r.stage === PK_AT_STOP) {
      const d = this.dist.to(w.distCls, r.cell)[from];
      return d === UNREACHABLE ? -1 : 2 * d;
    }
    const task = this.taskById.get(r.taskId) as PickTask;
    const fc = this.world.faces[task.stops[task.stop].face].cell;
    const dw = this.dist.to(w.distCls, fc)[from];
    const dr = this.dist.to(r.distCls, fc)[r.to >= 0 ? r.to : r.cell];
    if (dw === UNREACHABLE || dr === UNREACHABLE) return -1;
    // a robot stuck in traffic counts as further away, so a waiting picker turns to robots that have arrived
    return 2 * (dw > dr ? dw : dr) + 1 + 2 * (r.blockedTicks < 60 ? r.blockedTicks : 60);
  }

  /** Walk the worker to its robot: beside the robot if it is at its stop, else beside the face it is heading to. */
  private sendToMeet(w: CoreAgent, r: CoreAgent, t: number): void {
    w.stage = SV_TO_AMR;
    w.waiting = 0;
    let cell = r.cell;
    if (r.stage !== PK_AT_STOP) {
      const task = this.taskById.get(r.taskId) as PickTask;
      cell = this.world.faces[task.stops[task.stop].face].cell;
    }
    this.setGoal(w, cell, G_MEET, t);
    if (!w.robot) w.laneX = cell % this.world.width;
  }

  /** A worker reached its meeting point (or is waiting there): pick if beside the robot, follow it if it stopped
   *  somewhere else, keep waiting if it is still coming, or give up if the robot moved on. */
  private checkMeet(w: CoreAgent, t: number): void {
    const r = this.byId[w.partner];
    if (!r || r.partner !== w.id || r.job !== J_PICK || (r.stage !== PK_AT_STOP && r.stage !== PK_TO_STOP)) {
      this.freeAgent(w);
      return;
    }
    if (r.stage === PK_AT_STOP && r.to < 0) {
      if (this.dist.to(w.distCls, r.cell)[w.cell] <= 1) {
        this.clearGoal(w);
        this.tryServe(w, t);
      } else this.sendToMeet(w, r, t);
      return;
    }
    this.clearGoal(w);
    w.stage = SV_WAIT_AMR;
    if (w.waiting === 0) {
      w.waiting = 1;
      w.waitSince = t;
    }
  }

  /** A cart robot no longer goes to the stop its worker was sent to: the worker is free again. */
  private releasePartner(r: CoreAgent): void {
    if (r.partner < 0) return;
    const w = this.byId[r.partner];
    if (w && w.partner === r.id && w.job === J_SERVE) this.freeAgent(w);
    r.partner = -1;
  }

  /**
   * Zone admission for cart robots: the next stop is the first remaining one (in the planned nearest-next order) whose
   * zone has fewer than ZONE_MAX_AMRS robots heading to or waiting at it; if every remaining zone is full, the planned
   * next stop. Robots queued in a small hot zone would otherwise fill both aisle lanes and wall in its picker.
   */
  private admitStop(carrier: CoreAgent, task: PickTask): boolean {
    if (!task.amr || !this.zones) return true;
    const fz = this.zones.faceZone;
    for (let i = task.stop; i < task.stops.length; i++) {
      const z = fz[task.stops[i].face];
      if (!this.zoneHasRoom(z, carrier.id)) continue;
      if (i > task.stop) {
        const moved = task.stops.splice(i, 1)[0];
        task.stops.splice(task.stop, 0, moved);
      }
      // keep this tick's zone loads current: the carrier now counts toward zone z
      if (z >= 0 && this.zoneLoadTick === this.t && carrier.countedZone !== z) {
        if (carrier.countedZone >= 0) this.zoneLoads[carrier.countedZone]--;
        this.zoneLoads[z]++;
        carrier.countedZone = z;
      }
      return true;
    }
    return false;
  }

  private zoneHasRoom(zone: number, except: number): boolean {
    return zone < 0 || this.zoneLoad(zone, except) < this.zoneCap[zone];
  }

  /** WMS release control for a new cart-robot batch: some line of it is in a zone with room. */
  private batchAdmissible(batch: Order[]): boolean {
    if (!this.zones) return true;
    for (const o of batch) for (const f of o.faces) if (this.zoneHasRoom(this.zones.faceZone[f], -1)) return true;
    return false;
  }

  /** Release zone-held cart robots (in the order they were held) whose remaining stops now have a zone with room. */
  private releaseZoneHold(t: number): void {
    for (let i = 0; i < this.zoneHold.length; ) {
      const a = this.byId[this.zoneHold[i]];
      if (!a || a.job !== J_PICK || a.stage !== PK_ZONE_HOLD || a.brokenUntil > 0) {
        this.zoneHold.splice(i, 1);
        continue;
      }
      const task = this.taskById.get(a.taskId) as PickTask;
      if (!this.admitStop(a, task)) {
        i++;
        continue;
      }
      this.zoneHold.splice(i, 1);
      this.releaseHoldCell(a);
      a.stage = PK_TO_STOP;
      a.waiting = 0;
      this.setGoal(a, this.world.faces[task.stops[task.stop].face].cell, G_NEAR, t);
    }
  }

  /** Cart robots (other than `except`) heading to or waiting at a stop in this zone. */
  private zoneLoad(zone: number, except: number): number {
    if (this.zoneLoadTick !== this.t) this.refreshZoneLoads();
    const e = except >= 0 ? this.byId[except] : null;
    return this.zoneLoads[zone] - (e && e.countedZone === zone ? 1 : 0);
  }

  /** Zone loads, counted once per tick (and kept up to date as robots are admitted within the tick). */
  private refreshZoneLoads(): void {
    this.zoneLoadTick = this.t;
    const fz = this.zones!.faceZone;
    this.zoneLoads.length = this.zones!.members.length;
    this.zoneLoads.fill(0);
    for (const r of this.robots) {
      r.countedZone = -1;
      if (r.type !== T_AMR || r.job !== J_PICK || (r.stage !== PK_TO_STOP && r.stage !== PK_AT_STOP)) continue;
      const task = this.taskById.get(r.taskId) as PickTask;
      if (!task.amr || task.stop >= task.stops.length) continue;
      const z = fz[task.stops[task.stop].face];
      if (z < 0) continue;
      this.zoneLoads[z]++;
      r.countedZone = z;
    }
  }

  private isFree(a: CoreAgent): boolean {
    return (a.job === J_NONE || a.job === J_REST) && a.brokenUntil === 0;
  }

  // ── assignment: pools keyed by type (central) or type and vendor (many brains, Phase 2) ──
  private rebuildPools(): void {
    this.poolsDirty = false;
    const map = new Map<string, Pool>();
    for (const a of this.agents) {
      const key = this.mode === 'central' || !a.robot ? a.typeId : `${a.typeId}:${a.vendor}`;
      let p = map.get(key);
      if (!p) {
        p = { key, type: a.type, vendor: this.mode === 'central' || !a.robot ? '*' : a.vendor, ids: [] };
        map.set(key, p);
      }
      p.ids.push(a.id);
    }
    this.pools = [...map.values()].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  }

  /** Free agents of the given types from every matching pool (id order within a pool, pools in key order). */
  /** Free agents of type t1 or t2 that can do the work (not leaving, not needing a charge, with a pick or pallet
   *  time), from every matching pool (id order within a pool, pools in key order). */
  private candidates(t1: number, t2: number, work: 'pick' | 'pallet', out: CoreAgent[]): CoreAgent[] {
    out.length = 0;
    for (const p of this.pools) {
      if (p.type !== t1 && p.type !== t2) continue;
      for (const id of p.ids) {
        const a = this.byId[id];
        if (!a || !this.isFree(a) || a.removing || a.needCharge !== 0) continue;
        if (work === 'pallet' ? a.palletTicks > 0 : a.type === T_AMR || a.pickTicks > 0) out.push(a);
      }
    }
    return out;
  }

  /** Greedy nearest-idle by BFS distance (PROTOCOL §5); ties go to the lowest id. Unreachable agents are skipped. */
  private nearest(list: CoreAgent[], cls: PassClass | null, cell: number): number {
    let best = -1;
    let bestD = UNREACHABLE;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const d = this.dist.to(cls ?? a.distCls, cell)[a.to >= 0 ? a.to : a.cell];
      if (d < bestD || (d === bestD && d !== UNREACHABLE && list[best].id > a.id)) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private assign(t: number): void {
    if (this.poolsDirty) this.rebuildPools();
    // 1. removed agents leave once they have no task
    for (let i = this.agents.length - 1; i >= 0; i--) {
      const a = this.agents[i];
      if (a.removing && a.to < 0 && a.brokenUntil === 0 && (a.job === J_NONE || a.job === J_REST || a.job === J_CHARGE)) this.leave(a, t);
    }
    // 2. chargers: robots below chargeAtPct after their task (PROTOCOL §5), first come first served
    for (const r of this.robots) {
      if (r.needCharge > 0 && this.isFree(r) && r.chargeQueuedAt < 0) {
        r.chargeQueuedAt = t;
        this.chargeQueue.push(r.id);
      }
    }
    for (let i = 0; i < this.chargeQueue.length; ) {
      const r = this.byId[this.chargeQueue[i]];
      if (!r || !this.isFree(r) || r.needCharge === 0) {
        if (r) r.chargeQueuedAt = -1;
        this.chargeQueue.splice(i, 1);
        continue;
      }
      const p = this.nearestFreeCharger(r, -1);
      if (p < 0) {
        i++;
        continue;
      }
      this.chargeQueue.splice(i, 1);
      this.startCharge(r, p, t);
    }
    // 3. pick batches: oldest orders first; each batch to the nearest free carrier
    const zone = this.zoneMode();
    if (this.orders.queued > 0) {
      const carriers = zone ? this.candidates(T_AMR, T_AMR, 'pick', this.cand) : this.candidates(T_PICKER, T_HUMANOID, 'pick', this.cand);
      const cap = zone ? TOTES_PER_AMR : ORDERS_PER_CART;
      while (this.orders.queued > 0 && carriers.length > 0) {
        // batch release: a batch leaves full, or once its oldest order has waited BATCH_MAX_WAIT_SEC
        if (this.orders.queued < cap) {
          const oldest = this.orders.open.get(this.orders.peek(1, this.peekList)[0])!;
          if (t - oldest.arrived < this.batchWaitTicks) break;
        }
        const batch = this.formBatch(cap);
        const ref = this.world.faces[batch[0].faces[0]].cell;
        const k = this.nearest(carriers, null, ref);
        if (k < 0) {
          this.orders.requeue(batch.map((o) => o.id));
          break;
        }
        if (zone && !this.batchAdmissible(batch)) {
          // every zone this batch needs is full: the WMS keeps it queued rather than send another robot in
          this.orders.requeue(batch.map((o) => o.id));
          break;
        }
        const c = carriers[k];
        carriers.splice(k, 1);
        this.startPick(c, batch, zone, t);
      }
    }
    // 4. pallet moves: oldest first, each to the nearest free forklift or driver
    if (this.palletTasks.length > 0) {
      const movers = this.candidates(T_FORKLIFT, T_DRIVER, 'pallet', this.cand);
      for (const task of this.palletTasks) {
        if (movers.length === 0) break;
        if (task.agent >= 0) continue;
        const k = this.nearest(movers, 'forklift', task.dock);
        if (k < 0) continue;
        const m = movers[k];
        movers.splice(k, 1);
        this.releaseRest(m);
        if (m.job === J_REST) this.freeAgent(m);
        task.agent = m.id;
        m.job = J_PALLET;
        m.stage = PL_TO_DOCK;
        m.taskId = task.id;
        this.setGoal(m, task.dock, G_EXACT, t);
        this.events.push({ t: 'taskAssigned', tick: t, task: task.id, kind: task.kind, agents: [m.id] });
      }
    }
    // 5. everyone still free: a place to rest
    for (const a of this.agents) if (a.job === J_NONE && a.brokenUntil === 0) this.planRest(a, t);
  }

  /**
   * WMS batching (cluster picking, both work models): the oldest queued order always goes first, so no order waits
   * behind newer ones; the rest of the batch comes from the next BATCH_WINDOW orders, each time the one whose lines
   * are closest (BFS cells) to the faces already in the batch. Ties go to the older order.
   */
  private formBatch(cap: number): Order[] {
    const batch: Order[] = [this.orders.take()!];
    const faces: number[] = batch[0].faces.slice();
    while (batch.length < cap && this.orders.queued > 0) {
      const ids = this.orders.peek(BATCH_WINDOW, this.peekList);
      let best = -1;
      let bestScore = 0;
      for (const id of ids) {
        const o = this.orders.open.get(id)!;
        let score = 0;
        for (const f of o.faces) {
          const D = this.dist.to('small', this.world.faces[f].cell);
          let m = UNREACHABLE;
          for (const g of faces) {
            const d = D[this.world.faces[g].cell];
            if (d < m) m = d;
          }
          score += m;
        }
        if (best < 0 || score < bestScore) {
          best = id;
          bestScore = score;
        }
      }
      const o = this.orders.takeId(best)!;
      batch.push(o);
      for (const f of o.faces) faces.push(f);
    }
    return batch;
  }

  private startPick(c: CoreAgent, batch: Order[], amr: boolean, t: number): void {
    this.releaseRest(c);
    if (c.job === J_REST) this.freeAgent(c);
    // group lines by face (first-seen order), then visit the faces nearest-next from where the carrier is
    const faces: number[] = [];
    const stopsByFace = new Map<number, Stop>();
    let lines = 0;
    for (const o of batch) {
      o.stage = OS_PICKING;
      for (const f of o.faces) {
        lines++;
        let s = stopsByFace.get(f);
        if (!s) {
          s = { face: f, orders: [], left: [], picked: 0 };
          stopsByFace.set(f, s);
          faces.push(f);
        }
        const k = s.orders.indexOf(o.id);
        if (k >= 0) s.left[k]++;
        else {
          s.orders.push(o.id);
          s.left.push(1);
        }
      }
    }
    const stops: Stop[] = [];
    let cur = c.to >= 0 ? c.to : c.cell;
    while (faces.length > 0) {
      let bi = 0;
      let bd = UNREACHABLE + 1;
      for (let i = 0; i < faces.length; i++) {
        const d = this.dist.to(c.distCls, this.world.faces[faces[i]].cell)[cur];
        if (d < bd || (d === bd && faces[i] < faces[bi])) {
          bd = d;
          bi = i;
        }
      }
      const f = faces.splice(bi, 1)[0];
      stops.push(stopsByFace.get(f)!);
      cur = this.world.faces[f].cell;
    }
    const task: PickTask = {
      kind: 'pick', id: this.nextTask++, created: t, agent: c.id, amr, orders: batch.map((o) => o.id), lines, stops, stop: 0, station: -1, pickedBy: AGENT_TYPES.map(() => 0),
    };
    for (const o of batch) o.task = task.id;
    this.addTask(task);
    if (amr) this.amrTasks++;
    c.job = J_PICK;
    c.stage = PK_TO_STOP;
    c.taskId = task.id;
    c.partner = -1;
    c.waiting = 0;
    c.cargo = amr ? C_TOTE : C_CART;
    this.admitStop(c, task);
    if (amr) this.setGoal(c, this.world.faces[stops[0].face].cell, G_NEAR, t);
    else {
      // a manual cart starts with its induct: the picker sets up and labels the totes where it stands (once a step in
      // progress ends), then walks to the first face (a cart robot is inducted by the system, its totes ride on it)
      c.stage = PK_SETUP;
      this.clearGoal(c);
      if (c.to < 0) this.startDwell(c, this.setupTicks, t);
    }
    this.events.push({ t: 'taskAssigned', tick: t, task: task.id, kind: 'pick', agents: [c.id] });
  }

  private nearestFreeCharger(r: CoreAgent, except: number): number {
    let best = -1;
    let bestD = UNREACHABLE;
    const from = r.to >= 0 ? r.to : r.cell;
    for (const p of this.world.chargers) {
      if (p.id === except || p.forClass !== r.cls) continue;
      const holder = this.chargerHolder[p.id];
      const occupant = this.occ[p.cell];
      if ((holder >= 0 && holder !== r.id) || (occupant >= 0 && occupant !== r.id)) continue;
      const d = this.dist.to(r.distCls, p.cell)[from];
      if (d < bestD) {
        bestD = d;
        best = p.id;
      }
    }
    return best;
  }

  private startCharge(r: CoreAgent, p: number, t: number): void {
    this.releaseRest(r);
    if (r.job === J_REST) this.freeAgent(r);
    r.chargeQueuedAt = -1;
    r.charger = p;
    this.chargerHolder[p] = r.id;
    r.job = J_CHARGE;
    r.stage = CH_TO;
    const task: PlainTask = { kind: 'charge', id: this.nextTask++, created: t, agent: r.id };
    this.addTask(task);
    r.taskId = task.id;
    this.setGoal(r, this.world.chargers[p].cell, G_EXACT, t);
    this.events.push({ t: 'taskAssigned', tick: t, task: task.id, kind: 'charge', agents: [r.id] });
  }

  private endCharge(r: CoreAgent, t: number): void {
    this.events.push({ t: 'chargeEnd', tick: t, agent: r.id });
    if (r.charger >= 0) this.chargerHolder[r.charger] = -1;
    r.charger = -1;
    r.needCharge = 0;
    r.chargeAcc = 0;
    this.removeTask(r.taskId);
    this.freeAgent(r);
  }

  /** Nothing to do: park (robots), go home (people with carts), stay in the zone (zone workers), or step off anything
   *  important to a rest cell. Robots waiting for a charger wait at the resting place (state 'wait'). */
  private planRest(a: CoreAgent, t: number): void {
    const zoneWorker = this.zoneMode() && (a.type === T_PICKER || a.type === T_HUMANOID) && a.zone >= 0;
    let kind = RK_STAY;
    let goal = -1;
    let mode = G_EXACT;
    if (zoneWorker && this.zones) {
      const z = this.zones;
      const k = a.zone;
      const x = a.cell % this.world.width;
      const y = (a.cell - x) / this.world.width;
      if (z.home[k] >= 0 && (x < z.x0[k] || x > z.x1[k] || y < z.y0[k] || y > z.y1[k])) {
        kind = RK_ZONE;
        goal = z.home[k];
        mode = G_NEAR;
      }
    } else if (a.robot && a.cls === 'small') {
      const p = this.nearestFreePocket(a, this.world.parking, this.parkingHolder);
      if (p >= 0) {
        this.parkingHolder[p] = a.id;
        a.parking = p;
        kind = RK_PARKING;
        goal = this.world.parking[p].cell;
      } else if (this.badRest(a)) {
        goal = this.findRestCell(a);
        if (goal >= 0) kind = RK_CELL;
      }
    } else if (a.type === T_PICKER || a.type === T_HUMANOID) {
      goal = this.findHome(a);
      if (goal >= 0) kind = RK_HOME;
    } else if (this.badRest(a)) {
      goal = this.findRestCell(a);
      if (goal >= 0) kind = RK_CELL;
    }
    a.job = J_REST;
    a.restKind = kind;
    a.waiting = a.needCharge > 0 ? 1 : 0;
    if (a.waiting) a.waitSince = t;
    if (kind === RK_CELL || kind === RK_HOME) {
      this.restHolder[goal] = a.id;
      a.restCell = goal;
    }
    if (goal >= 0 && goal !== a.cell) {
      a.stage = RS_TO;
      this.setGoal(a, goal, mode, t);
      const task: PlainTask = { kind: 'park', id: this.nextTask++, created: t, agent: a.id };
      this.addTask(task);
      a.taskId = task.id;
      this.events.push({ t: 'taskAssigned', tick: t, task: task.id, kind: 'park', agents: [a.id] });
    } else a.stage = RS_AT;
  }

  private releaseRest(a: CoreAgent): void {
    if (a.parking >= 0) {
      if (this.parkingHolder[a.parking] === a.id) this.parkingHolder[a.parking] = -1;
      a.parking = -1;
    }
    if (a.restCell >= 0) {
      if (this.restHolder[a.restCell] === a.id) this.restHolder[a.restCell] = -1;
      a.restCell = -1;
    }
    if (a.job === J_REST && a.taskId >= 0) {
      this.removeTask(a.taskId);
      a.taskId = -1;
    }
  }

  /** Is the agent standing somewhere it must not idle (a pick face, a station or dock access cell, a pocket entry, the
   *  pack lane, or a pocket it does not hold)? */
  private badRest(a: CoreAgent): boolean {
    const c = a.to >= 0 ? a.to : a.cell;
    if (a.cls === 'forklift') return !this.restDock[c];
    return !this.restOk[0][c];
  }

  private nearestFreePocket(a: CoreAgent, list: { id: number; cell: number; forClass: PassClass }[], holder: Int32Array): number {
    let best = -1;
    let bestD = UNREACHABLE;
    const from = a.to >= 0 ? a.to : a.cell;
    for (const p of list) {
      if (p.forClass !== a.cls) continue;
      if ((holder[p.id] >= 0 && holder[p.id] !== a.id) || (this.occ[p.cell] >= 0 && this.occ[p.cell] !== a.id)) continue;
      const d = this.dist.to(a.distCls, p.cell)[from];
      if (d < bestD) {
        bestD = d;
        best = p.id;
      }
    }
    return best;
  }

  /** Nearest free rest cell by BFS over the agent's cells (rare: only when an agent goes idle on a bad cell). Forklifts
   *  and drivers look in the dock zone first. */
  private findRestCell(a: CoreAgent): number {
    if (a.cls === 'forklift') {
      const c = this.bfsRest(a, this.restDock);
      if (c >= 0) return c;
    }
    return this.bfsRest(a, this.restOk[a.cls === 'forklift' ? 1 : 0]);
  }

  private bfsRest(a: CoreAgent, ok: Uint8Array): number {
    const w = this.world;
    const st = ++this.stamp;
    const q = this.bfsQueue;
    const seen = this.bfsStamp;
    const start = a.to >= 0 ? a.to : a.cell;
    let head = 0;
    let tail = 0;
    q[tail++] = start;
    seen[start] = st;
    while (head < tail) {
      const u = q[head++];
      if (ok[u] && (this.occ[u] < 0 || this.occ[u] === a.id) && this.restHolder[u] < 0) return u;
      for (let d = 0; d < 4; d++) {
        const j = w.nbr[u * 4 + d];
        if (j < 0 || !a.pass[j] || w.isPocket[j] || seen[j] === st) continue;
        seen[j] = st;
        q[tail++] = j;
      }
    }
    return -1;
  }

  private findHome(a: CoreAgent): number {
    let best = -1;
    let bestD = UNREACHABLE;
    const from = a.to >= 0 ? a.to : a.cell;
    for (const h of this.homes) {
      if (this.restHolder[h] >= 0 || (this.occ[h] >= 0 && this.occ[h] !== a.id)) continue;
      const d = this.dist.to(a.distCls, h)[from];
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  private leave(a: CoreAgent, t: number): void {
    this.dropJob(a, t);
    if (this.occ[a.cell] === a.id) this.occ[a.cell] = -1;
    const qi = this.chargeQueue.indexOf(a.id);
    if (qi >= 0) this.chargeQueue.splice(qi, 1);
    this.byId[a.id] = null;
    this.agents.splice(this.agents.indexOf(a), 1);
    const list = a.robot ? this.robots : this.people;
    list.splice(list.indexOf(a), 1);
    if (a.robot) {
      this.tviews[a.id] = null;
      this.ready[a.id] = -1;
      this.order.splice(this.order.indexOf(a.id), 1);
    }
    this.fleetChanged(a);
  }

  // ── packing and shipping ──
  private packAndShip(t: number): void {
    for (const s of this.pack.stations) {
      if (s.packing >= 0 && t >= s.packEnd) {
        const o = this.orders.open.get(s.packing)!;
        o.stage = OS_CONVEYOR;
        this.events.push({ t: 'orderPacked', tick: t, order: o.id });
        this.pack.convey(o.id, t + CONVEYOR_TICKS);
        s.load--;
        s.packing = -1;
      }
      if (s.packing < 0 && s.queue.length > 0) {
        s.packing = s.queue.shift()!;
        s.packEnd = t + this.packTicks;
      }
    }
    this.pack.arriving(t, this.shipList);
    for (const id of this.shipList) {
      const o = this.orders.ship(id);
      if (o) this.events.push({ t: 'orderShipped', tick: t, order: o.id, arrivedTick: o.arrived });
    }
  }

  // ── 8. battery ──
  private batteries(t: number): void {
    for (let i = 0; i < this.robots.length; i++) {
      const r = this.robots[i];
      if (r.batteryMax === 0) continue;
      if (r.job === J_CHARGE && r.stage === CH_ON) {
        // charges at runtime ÷ charge time per tick (Bresenham remainder keeps it exact and integer)
        r.battery += r.chargeQ;
        r.chargeAcc += r.chargeR;
        if (r.chargeAcc >= r.chargeC) {
          r.chargeAcc -= r.chargeC;
          r.battery++;
        }
        if (r.battery >= r.batteryMax) {
          r.battery = r.batteryMax;
          this.endCharge(r, t);
        }
        continue;
      }
      if (r.brokenUntil === 0 && r.battery > 0) r.battery--;
      if (r.battery * 100 < r.batteryMax * CRITICAL_BATTERY_PCT) r.needCharge = 2;
      else if (r.needCharge === 0 && r.battery * 100 < r.batteryMax * r.chargeAtPct) r.needCharge = 1;
      if (r.battery < 0) this.violations.negativeBattery++;
    }
  }

  // ── 9. states and detection ──
  private detect(t: number): void {
    const n = this.agents.length;
    if (this.dWait.length < n) {
      const m = Math.max(64, n * 2);
      this.dWait = new Int32Array(m);
      this.dCells = new Int32Array(m);
      this.dBlocked = new Int32Array(m);
      this.dIds = new Int32Array(m);
    }
    const posOf = this.posOf;
    for (let i = 0; i < n; i++) posOf[this.agents[i].id] = i;
    for (let i = 0; i < n; i++) {
      const a = this.agents[i];
      const st = this.stateOf(a, t);
      a.state = st;
      if (st === ST_BLOCKED) {
        a.blockedTicks++;
        this.heat[a.cell]++;
        // rule 3: robots (and drivers, people on vehicles) waiting 3+ ticks claim the cell they want, and a vehicle
        // also the cell beyond it (its safety field) when a person stands there
        if ((a.robot || a.type === T_DRIVER) && a.want >= 0 && a.blockedTicks >= CLAIM_AFTER_TICKS) {
          this.claim[a.want] = t + 1;
          if (a.safetyCells > 0) {
            const d = headingOf(a.cell, a.want, this.world.width);
            const beyond = this.world.nbr[a.want * 4 + d];
            const h = beyond >= 0 ? this.occ[beyond] : -1;
            if (h >= 0 && this.byId[h] && !this.byId[h]!.robot) this.claim[beyond] = t + 1;
          }
        }
      } else a.blockedTicks = 0;
      if (st !== ST_BLOCKED && st !== ST_WAIT) a.waitOn = -1;
      else if (st === ST_WAIT) a.waitOn = this.waitTarget(a);
      // ticks since the robot last got closer to its goal, moving or not (a robot shuffled around never progresses)
      if (a.robot && a.goal >= 0 && a.dwellUntil === 0) {
        a.sinceProgress++;
        if (st === ST_BLOCKED) a.blockedSinceProgress++;
      }
      this.dCells[i] = a.cell;
      this.dBlocked[i] = a.blockedTicks;
      this.dIds[i] = a.id;
    }
    for (let i = 0; i < n; i++) {
      const wo = this.agents[i].waitOn;
      this.dWait[i] = wo >= 0 && this.byId[wo] ? posOf[wo] : -1;
    }
    const wf = this.dWait.subarray(0, n);
    const ids = this.dIds.subarray(0, n);
    const d = this.deadlocks.update(t, wf, ids);
    for (const s of d.started) this.events.push({ t: 'deadlockStart', tick: t, deadlock: s.id, agents: s.ids });
    for (const e of d.ended) this.events.push({ t: 'deadlockEnd', tick: t, deadlock: e.id });
    const j = this.jams.update(t, this.dCells.subarray(0, n), this.dBlocked.subarray(0, n), ids);
    for (const s of j.started) this.events.push({ t: 'jamStart', tick: t, jam: s.id, agents: s.agents, cell: s.cell });
    for (const e of j.ended) this.events.push({ t: 'jamEnd', tick: t, jam: e.id });
  }

  /** The agent's state this tick. Moving counts as 'travel' only on a task (PROTOCOL §6: productive = moving to or
   *  with a task, or task work); a trip to park or rest is 'idle' and a trip to a charger is 'charge'. */
  private stateOf(a: CoreAgent, t: number): number {
    if (a.brokenUntil > 0) return ST_BROKEN;
    // held for a pack slot (on its way to a holding cell or standing): waiting, not productive
    if (a.job === J_PICK && (a.stage === PK_HOLD || a.stage === PK_ZONE_HOLD) && (a.to >= 0 || a.blockedAt !== t)) return ST_WAIT;
    // queued for a charger (resting or on its way to rest meanwhile): waiting
    if (a.chargeQueuedAt >= 0 && a.job !== J_CHARGE && (a.to >= 0 || a.blockedAt !== t)) return ST_WAIT;
    const moving = a.to >= 0;
    if (moving || a.goal >= 0) {
      if (a.job === J_REST || a.job === J_NONE) return moving || a.blockedAt !== t ? (a.waiting === 1 ? ST_WAIT : ST_IDLE) : ST_BLOCKED;
      if (a.job === J_CHARGE) return moving || a.blockedAt !== t ? ST_CHARGE : ST_BLOCKED;
    }
    if (moving) return ST_TRAVEL;
    if (a.job === J_CHARGE && a.stage === CH_ON) return ST_CHARGE;
    if (a.lastWork === t) return ST_WORK;
    if (a.blockedAt === t) return ST_BLOCKED;
    if (a.waiting === 1) return ST_WAIT;
    if (a.goal >= 0) return ST_TRAVEL;
    return ST_IDLE;
  }

  /** Who a waiting agent waits for: its zone worker, or the forklift bringing the stock. */
  private waitTarget(a: CoreAgent): number {
    if (a.job === J_PICK && a.partner >= 0) return a.partner;
    if (a.job === J_SERVE && a.stage === SV_WAIT_AMR) return a.partner;
    let task: Task | undefined;
    if (a.job === J_PICK) task = this.taskById.get(a.taskId);
    else if (a.job === J_SERVE) task = this.taskById.get(this.byId[a.partner]?.taskId ?? -1);
    // held for a pack slot or zone room: waiting for capacity, not for an agent
    if (a.job === J_PICK && (a.stage === PK_HOLD || a.stage === PK_ZONE_HOLD)) return -1;
    if (task && task.kind === 'pick' && task.stop < task.stops.length) {
      const r = this.replenOpen[task.stops[task.stop].face];
      const p = r >= 0 ? (this.taskById.get(r) as PalletTask | undefined) : undefined;
      return p ? p.agent : -1;
    }
    return -1;
  }

  // ── 10. stats ──
  private countStats(): void {
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      this.ticksByState[a.type * N_STATES + a.state]++;
    }
  }

  private checkInvariants(): void {
    const stamp = this.t;
    const hs = this.holdStamp;
    const occ = this.occ;
    const w = this.world;
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
      if ((a.type === T_FORKLIFT || a.type === T_DRIVER) && (w.code[a.cell] === Cell.Narrow || (a.to >= 0 && w.code[a.to] === Cell.Narrow))) this.violations.forkOnNarrow++;
      if (a.battery < 0) this.violations.negativeBattery++;
    }
    let used = 0;
    for (let i = 0; i < occ.length; i++) if (occ[i] >= 0) used++;
    if (used !== held) this.violations.occMismatch++;
  }

  // ═════════════════════════════ outputs ═════════════════════════════
  stats(): SimStats {
    const fleet = Object.fromEntries(AGENT_TYPES.map((t) => [t, 0])) as SimStats['fleet'];
    for (const a of this.agents) fleet[a.typeId]++;
    return {
      tick: this.t,
      openOrders: this.orders.open.size,
      shippedOrders: this.orders.shipped,
      ticksByState: this.ticksByStateRecord(),
      unitsPicked: { picker: this.unitsPicked[T_PICKER], humanoid: this.unitsPicked[T_HUMANOID] },
      fleet,
    };
  }

  private ticksByStateRecord(): SimStats['ticksByState'] {
    const out = {} as SimStats['ticksByState'];
    AGENT_TYPES.forEach((type, ti) => {
      const rec = {} as Record<(typeof AGENT_STATES)[number], number>;
      AGENT_STATES.forEach((s, si) => (rec[s] = this.ticksByState[ti * N_STATES + si]));
      out[type] = rec;
    });
    return out;
  }

  snapshot(): Snapshot {
    const agents: AgentView[] = this.agents.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.typeId,
      vendor: a.vendor,
      model: a.spec.model,
      cell: a.cell,
      to: a.to,
      moveStart: a.moveStart,
      moveEnd: a.moveEnd,
      heading: a.heading as Heading,
      state: AGENT_STATES[a.state],
      goal: a.goal,
      route: a.goal >= 0 ? this.dist.route(a.distCls, a.to >= 0 ? a.to : a.cell, a.goal, 12) : [],
      taskId: a.taskId,
      cargo: CARGO_NAMES[a.cargo],
      batteryPct: a.robot && a.batteryMax > 0 ? Math.floor((a.battery * 100) / a.batteryMax) : 100,
      blockedTicks: a.blockedTicks,
      waitOn: a.waitOn,
    }));
    const tasks: TaskView[] = this.tasks.map((task) => this.taskView(task));
    return {
      tick: this.t,
      width: this.world.width,
      height: this.world.height,
      agents,
      tasks,
      stats: { ticksByState: this.ticksByStateRecord() },
      openOrders: this.orders.open.size,
      shippedOrders: this.orders.shipped,
      chargers: this.world.chargers.map((c) => ({ cell: c.cell, vendor: '-', agentId: this.chargerHolder[c.id] })),
      deadlocks: this.deadlocks.active().map((d) => ({ ids: d.ids, sinceTick: d.sinceTick })),
      heat: Array.from(this.heat),
    };
  }

  private taskView(task: Task): TaskView {
    const a = task.agent >= 0 ? this.byId[task.agent] : null;
    if (task.kind === 'pick') {
      const ids = [task.agent];
      if (a && a.partner >= 0) ids.push(a.partner);
      let stage = 'to pack';
      if (a) {
        const n = `${Math.min(task.stop + 1, task.stops.length)}/${task.stops.length}`;
        if (a.stage === PK_TO_STOP) stage = `to face ${n}`;
        else if (a.stage === PK_AT_STOP) {
          const partner = a.partner >= 0 ? this.byId[a.partner] : null;
          if (a.lastWork === this.t - 1 || (partner && partner.stage === SV_PICKING)) stage = `picking ${n}`;
          else if (this.stock[task.stops[task.stop].face] === 0) stage = `waiting for stock ${n}`;
          else stage = task.amr ? (partner ? `picker coming ${n}` : `waiting for picker ${n}`) : `picking ${n}`;
        } else if (a.stage === PK_HANDOFF) stage = 'handoff';
        else if (a.stage === PK_SETUP) stage = 'cart setup';
        else if (a.stage === PK_HOLD) stage = 'waiting for a pack slot';
        else if (a.stage === PK_ZONE_HOLD) stage = 'waiting for room in a zone';
      }
      return { id: task.id, kind: 'pick', orderIds: task.orders.slice(), lines: task.lines, stage, createdTick: task.created, agentIds: ids };
    }
    if (task.kind === 'replenish' || task.kind === 'inbound') {
      const stage = !a ? 'waiting for a forklift' : ['to dock', 'loading', 'to rack', 'unloading'][a.stage] ?? 'to dock';
      const lines = task.kind === 'replenish' ? this.linesPerReplenish : 0;
      return { id: task.id, kind: task.kind as TaskKind, orderIds: [], lines, stage, createdTick: task.created, agentIds: a ? [a.id] : [] };
    }
    let stage = '';
    if (task.kind === 'charge') stage = a && a.stage === CH_ON ? 'charging' : 'to charger';
    else if (a) stage = (a.stage === RS_TO ? 'to ' : 'at ') + (['spot', 'parking', 'rest spot', 'home', 'zone'][a.restKind] ?? 'spot');
    return { id: task.id, kind: task.kind, orderIds: [], lines: 0, stage, createdTick: task.created, agentIds: a ? [a.id] : [] };
  }

  /** FNV-1a over every integer of agent state, queues, stocks, RNG states and traffic.stateWords(). Throws on any
   *  non-integer. */
  hash(): string {
    const h = new StateHasher();
    const words: number[] = [];
    words.push(this.t, this.nextId, this.nextTask, this.orderRate, this.inboundCount, this.nextInbound, this.activeAmrs, this.amrTasks);
    words.push(this.orders.nextId, this.orders.shipped, fnv1a32(this.mode));
    for (const a of this.agents) {
      words.push(
        a.id, a.type, fnv1a32(a.vendor), a.spawnIndex, a.cell, a.to, a.safety, a.moveStart, a.moveEnd, a.carry, a.heading, a.prefHeading,
        a.goal, a.goalMode, a.goalStation, a.laneX, a.goalHold, a.goalTick, a.tb, a.bestDist, a.sinceProgress, a.blockedSinceProgress, a.parkReady,
        a.blockedAt, a.blockedTicks, a.pBlocked, a.want, a.waitOn, a.swappedAt, a.state, a.job, a.stage, a.taskId, a.cargo, a.dwellStart,
        a.dwellUntil, a.dwellUnits, a.lastWork, a.waiting, a.waitSince, a.partner, a.restKind, a.restCell, a.zone, a.battery, a.chargeAcc,
        a.needCharge, a.charger, a.parking, a.chargeQueuedAt, a.brokenUntil, a.breakPending, a.removing,
      );
    }
    for (const o of this.orders.open.values()) {
      words.push(o.id, o.arrived, o.stage, o.task, o.station, o.faces.length);
      for (const f of o.faces) words.push(f);
    }
    words.push(...this.orders.queueIds());
    for (const task of this.tasks) {
      words.push(task.id, task.created, task.agent, fnv1a32(task.kind));
      if (task.kind === 'pick') {
        words.push(task.amr ? 1 : 0, task.lines, task.stop, task.station, task.orders.length, ...task.orders, task.stops.length);
        for (const s of task.stops) words.push(s.face, s.picked, s.orders.length, ...s.orders, ...s.left);
        words.push(...task.pickedBy);
      } else if (task.kind === 'replenish' || task.kind === 'inbound') words.push(task.face, task.dock);
    }
    for (const p of this.palletTasks) words.push(p.id);
    this.pack.stateWords(words);
    this.faults.stateWords(words);
    for (const arr of [this.stock, this.replenOpen, this.chargerHolder, this.parkingHolder]) for (let i = 0; i < arr.length; i++) words.push(arr[i]);
    for (let c = 0; c < this.restHolder.length; c++) if (this.restHolder[c] >= 0) words.push(c, this.restHolder[c]);
    for (let c = 0; c < this.claim.length; c++) if (this.claim[c] > this.t) words.push(c, this.claim[c]);
    words.push(this.chargeQueue.length, ...this.chargeQueue, this.packHold.length, ...this.packHold, this.zoneHold.length, ...this.zoneHold, this.order.length, ...this.order);
    if (this.zones) words.push(...this.zones.workers, ...this.zones.workerZone, ...this.zones.home);
    for (const r of [this.arrivals, this.rngHumans, this.rngSpawn, this.rngBattery, this.rngFaults]) words.push(...r.state());
    for (const v of [...this.tiebreak.keys()].sort()) words.push(fnv1a32(v), ...this.tiebreak.get(v)!.state());
    for (let i = 0; i < this.ticksByState.length; i++) words.push(this.ticksByState[i]);
    words.push(...this.unitsPicked);
    words.push(this.deadlocks.total, this.jams.total);
    for (const d of this.deadlocks.active()) words.push(d.id, d.sinceTick, ...d.ids);
    for (const j of this.jams.active()) words.push(j.id, j.sinceTick, ...j.agents);
    const tw = this.traffic.stateWords();
    words.push(tw.length);
    for (const x of tw) words.push(x);
    for (const x of words) h.add(x);
    return h.digest();
  }

  // ═════════════════════════════ test and debug views ═════════════════════════════
  /** Internal numbers for tests and the report (not part of the Sim contract). */
  debug() {
    return {
      violations: { ...this.violations },
      counters: { ...this.counters },
      queued: this.orders.queued,
      openOrders: this.orders.open.size,
      stock: Array.from(this.stock),
      palletTasks: this.palletTasks.length,
      zoneMode: this.zoneMode(),
      zones: this.zones ? { members: this.zones.members.map((m) => m.slice()), faceZone: Array.from(this.zones.faceZone) } : null,
      pools: this.pools.map((p) => ({ key: p.key, ids: p.ids.slice() })),
      stations: this.pack.stations.map((s: PackStation) => ({ load: s.load, queue: s.queue.length, packing: s.packing })),
      chargeQueue: this.chargeQueue.slice(),
      deadlocksTotal: this.deadlocks.total,
      jamsTotal: this.jams.total,
    };
  }

  /** The agent id for '<type>:<n>' (spawn order within the type), or -1. */
  agentRef(type: AgentTypeId, n: number): number {
    return this.spawnOrder[AGENT_TYPES.indexOf(type)][n] ?? -1;
  }
}

export function createCoreSim(scenario: Scenario, data: CoreSimData, opts: CoreSimOptions = {}): CoreSim {
  return new CoreSim(scenario, data, opts);
}
