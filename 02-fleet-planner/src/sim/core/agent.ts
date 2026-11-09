// One agent of the real sim (robot or person). A plain monomorphic object with integer fields only: hash() reads every
// state field, and throws on a non-integer.
import type { AgentSpec, AgentTypeId, PassClass } from '../../contracts/types.ts';

/** Agent type index = position in AGENT_TYPES. */
export const T_AMR = 0;
export const T_FORKLIFT = 1;
export const T_HUMANOID = 2;
export const T_PICKER = 3;
export const T_DRIVER = 4;

/** State index = position in AGENT_STATES ('idle', 'travel', 'work', 'wait', 'blocked', 'charge', 'broken'). */
export const ST_IDLE = 0;
export const ST_TRAVEL = 1;
export const ST_WORK = 2;
export const ST_WAIT = 3;
export const ST_BLOCKED = 4;
export const ST_CHARGE = 5;
export const ST_BROKEN = 6;
export const N_STATES = 7;

/** Cargo index = position in CARGO_NAMES. */
export const CARGO_NAMES = ['none', 'tote', 'pallet', 'cart'] as const;
export const C_NONE = 0;
export const C_TOTE = 1;
export const C_PALLET = 2;
export const C_CART = 3;

/** What the agent is doing. */
export const J_NONE = 0; // free: gets work, a charger or a resting place this tick
export const J_PICK = 1; // carries a pick task: a cart robot's tote batch, or a manual cart (people only)
export const J_SERVE = 2; // zone worker walking to a waiting cart robot, or picking into its totes
export const J_PALLET = 3; // forklift or driver on a replenish / inbound pallet move
export const J_CHARGE = 4; // to a charger, or charging
export const J_REST = 5; // nothing to do: to parking / a rest cell / home / its zone, or resting there

/** Stages of J_PICK. */
export const PK_TO_STOP = 0;
export const PK_AT_STOP = 1; // cart robot: waiting for a picker or stock, or being picked into; cart: picking or waiting
export const PK_TO_PACK = 2;
export const PK_HANDOFF = 3;
export const PK_SETUP = 4; // manual cart: induct (label totes, set up the cart) before the first stop
export const PK_HOLD = 5; // all lines picked, held back until a pack station has a free queue slot
export const PK_ZONE_HOLD = 6; // between stops, held back until one of its remaining zones has room
/** Stages of J_SERVE. */
export const SV_TO_AMR = 0;
export const SV_WAIT_STOCK = 1;
export const SV_PICKING = 2;
export const SV_WAIT_AMR = 3; // at the face, waiting for the cart robot it was sent to meet
/** Stages of J_PALLET. */
export const PL_TO_DOCK = 0;
export const PL_LOAD = 1;
export const PL_TO_FACE = 2;
export const PL_UNLOAD = 3;
/** Stages of J_CHARGE. */
export const CH_TO = 0;
export const CH_ON = 1;
/** Stages of J_REST. */
export const RS_TO = 0;
export const RS_AT = 1;

/** What a J_REST agent rests on. */
export const RK_STAY = 0; // where it is
export const RK_PARKING = 1; // a parking pocket (robots)
export const RK_CELL = 2; // a reserved rest cell off the main paths
export const RK_HOME = 3; // a reserved home cell on the pack lane (people with carts)
export const RK_ZONE = 4; // its pick zone's home cell (zone workers)

/** How an agent "arrives" at its travel goal. */
export const G_EXACT = 0; // on the goal cell
export const G_NEAR = 1; // on the goal cell, or next to it when someone else holds it (pick faces)
export const G_MEET = 2; // next to the goal cell (a zone worker meeting a waiting cart robot)
export const G_STATION = 3; // on any free-standing cell next to the goal's pack station
export const G_REACH = 4; // a pallet drop at a face: on it, or up to 2 cells off when someone stands there (fork reach)

export class CoreAgent {
  // ── identity (fixed at spawn) ──
  readonly id: number;
  readonly type: number;
  readonly typeId: AgentTypeId;
  readonly spec: AgentSpec;
  readonly name: string;
  vendor: string;
  readonly robot: boolean;
  readonly cls: PassClass;
  /** Distance maps this agent reads. People use the 'small' maps: their cells are the same (PROTOCOL §3), and the people
   *  mover never enters a pocket, so the distances are identical and the cache holds half as many maps. */
  readonly distCls: PassClass;
  readonly pass: Uint8Array;
  readonly speed: number;
  readonly turnTicks: number;
  readonly safetyCells: number;
  readonly pickTicks: number;
  /** Ticks per line when picking into a cart robot's tote (the robot's screen does the search; see ASSISTED_PICK_PCT). */
  readonly assistTicks: number;
  readonly palletTicks: number;
  readonly handoffTicks: number;
  /** Battery in ticks of run time; charging adds chargeQ per tick plus a Bresenham remainder chargeR / chargeC. */
  readonly batteryMax: number;
  readonly chargeQ: number;
  readonly chargeR: number;
  readonly chargeC: number;
  readonly chargeAtPct: number;
  /** n in '<type>:<n>' (spawn order within the type, 0-based). */
  readonly spawnIndex: number;

  // ── motion ──
  cell: number;
  /** Cell it is moving into, or -1. While moving it holds cell, to and (forklifts, drivers) safety. */
  to = -1;
  safety = -1;
  moveStart = 0;
  moveEnd = 0;
  /** Leftover mm from the previous move (PROTOCOL §1; carried only through continuous straight moves). */
  carry = 0;
  heading = 0;
  /** People: heading along the route, kept through a side step. */
  prefHeading = 0;

  // ── travel goal ──
  goal = -1;
  goalMode = 0;
  /** Pack station index for G_STATION goals, else -1. */
  goalStation = -1;
  /** Zone workers walking to a cart robot prefer the robot's lane (x), so the other lane stays free. -1 = no preference. */
  laneX = -1;
  /** People's manners: don't crowd a busy goal (wait 2 cells back). */
  goalHold = 0;
  /** Tick the current goal was set, and the seeded tie-break drawn with it (planner priority, PROTOCOL §5). */
  goalTick = 0;
  tb = 0;
  bestDist = 0;
  sinceProgress = 0;
  blockedSinceProgress = 0;

  // ── per tick ──
  /** State index for this tick (ST_*), set in phase 9. */
  state = ST_IDLE;
  /** Tick it last worked (picking, loading, handing off, or being picked into). */
  lastWork = -1;
  /** Tick it last wanted to move and could not (state 'blocked'). */
  blockedAt = -1;
  /** Consecutive blocked ticks. */
  blockedTicks = 0;
  /** People: blocked ticks toward the next side step. */
  pBlocked = 0;
  /** Preferred next cell, and the agent it waits for (wait-for graph), -1 if none. */
  want = -1;
  waitOn = -1;
  /** Tick it swapped cells with a person (it must not move again that tick). */
  swappedAt = -1;
  /** Tick it was handed to the planner as a pushable robot standing at its own goal (waiting at a stop, resting). */
  parkReady = -1;
  /** Zone this cart robot counts toward in this tick's zone loads (scratch, recomputed every tick; not state). */
  countedZone = -1;

  // ── work ──
  job = J_NONE;
  stage = 0;
  taskId = -1;
  cargo = C_NONE;
  dwellStart = 0;
  dwellUntil = 0;
  /** Units being picked in the current pick dwell. */
  dwellUnits = 0;
  /** Waiting for a picker, stock or a charger (state 'wait'). */
  waiting = 0;
  waitSince = 0;
  /** J_SERVE: the cart robot being served. J_PICK (cart robot): the zone worker serving it. Else -1. */
  partner = -1;
  restKind = 0;
  /** Reserved rest / home cell (RK_CELL, RK_HOME), or -1. */
  restCell = -1;
  /** Zone index (zone workers), or -1. */
  zone = -1;

  // ── battery (robots) ──
  battery = 0;
  chargeAcc = 0;
  needCharge = 0;
  /** Charger pocket id reserved or in use, or -1. */
  charger = -1;
  /** Parking pocket id reserved or in use, or -1. */
  parking = -1;
  /** Tick it joined the charger queue, or -1. */
  chargeQueuedAt = -1;

  // ── faults and fleet ──
  /** Broken through tick brokenUntil − 1; 0 when not broken. */
  brokenUntil = 0;
  /** A breakdown (ticks) that waits for the current move to finish. */
  breakPending = 0;
  removing = 0;

  constructor(init: {
    id: number;
    type: number;
    typeId: AgentTypeId;
    spec: AgentSpec;
    name: string;
    vendor: string;
    pass: Uint8Array;
    speed: number;
    pickTicks: number;
    assistTicks: number;
    palletTicks: number;
    handoffTicks: number;
    batteryMax: number;
    chargeQ: number;
    chargeR: number;
    chargeC: number;
    spawnIndex: number;
    cell: number;
  }) {
    this.id = init.id;
    this.type = init.type;
    this.typeId = init.typeId;
    this.spec = init.spec;
    this.name = init.name;
    this.vendor = init.vendor;
    this.robot = init.spec.kind === 'robot';
    this.cls = init.spec.passClass;
    this.distCls = init.spec.passClass === 'human' ? 'small' : init.spec.passClass;
    this.pass = init.pass;
    this.speed = init.speed;
    this.turnTicks = init.spec.turnTicks;
    this.safetyCells = init.spec.safetyCells;
    this.pickTicks = init.pickTicks;
    this.assistTicks = init.assistTicks;
    this.palletTicks = init.palletTicks;
    this.handoffTicks = init.handoffTicks;
    this.batteryMax = init.batteryMax;
    this.chargeQ = init.chargeQ;
    this.chargeR = init.chargeR;
    this.chargeC = init.chargeC;
    this.chargeAtPct = init.spec.battery?.chargeAtPct ?? 0;
    this.spawnIndex = init.spawnIndex;
    this.cell = init.cell;
  }
}
