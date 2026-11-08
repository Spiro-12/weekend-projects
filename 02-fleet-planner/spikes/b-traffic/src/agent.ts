// One agent (robot or person). Plain monomorphic object with integer fields only (hashed by sim.hash()).

export const LEG_NONE = 0; // needs a task
export const LEG_A = 1; // to the first target (pick face, or dock for a pallet)
export const LEG_B = 2; // to the second target (pack station, or a rack face for a pallet)
export const LEG_CHARGE = 3; // to a charger

export const PH_TRAVEL = 0;
export const PH_DWELL = 1;
export const PH_CHARGE = 2;

/** Per-tick state for KPIs (index into stats arrays). */
export const S_TRAVEL = 0;
export const S_WORK = 1;
export const S_BLOCKED = 2;
export const S_IDLE = 3;
export const S_CHARGE = 4;
export const STATE_NAMES = ['travel', 'work', 'blocked', 'idle', 'charge'] as const;

export const DETOUR_MAX = 24;

export class Agent {
  // identity
  id: number;
  type: number;
  robot: boolean;
  /** Vendor index (sorted vendor ids), -1 for people. */
  vendor: number;
  /** Pass class index (world.passable[cls]). */
  cls: number;
  pass: Uint8Array;
  speed: number;
  turnTicks: number;
  safetyCells: number;

  // motion
  cell: number;
  /** Cell being moved into, or -1. While moving the agent holds cell, to and (forklift) safety. */
  to = -1;
  safety = -1;
  /** mm travelled toward `to` (carried remainder at a boundary). */
  prog = 0;
  turnLeft = 0;
  heading = 0;
  /** People: heading along the route (kept through a step aside). */
  prefHeading = 0;

  // work
  phase = PH_TRAVEL;
  leg = LEG_NONE;
  goal = -1;
  dist: Uint16Array | null = null;
  dwellLeft = 0;
  /** Second target of the current task. */
  t2 = -1;
  pool = -1;
  tasksDone = 0;

  // battery (robots), in ticks of run time
  battery = 0;
  batteryMax = 0;
  chargePerTick = 0;
  charger = -1;
  chargerPool = -1;

  // PIBT priority: older goalTick = higher priority; tb breaks ties (higher first), then id
  goalTick = 0;
  tb = 0;

  // progress and the recovery ladder
  bestDist = 0;
  sinceProgress = 0;
  /** Ticks since real progress or a goal reached (not reset by a re-task): drives the manual reset. */
  stuckTicks = 0;
  blockedSinceProgress = 0;
  mark1 = 0;
  mark2 = 0;
  backoff = 0;
  backoffNext = 0;
  detour = new Int32Array(DETOUR_MAX);
  detourLen = 0;
  detourPos = 0;
  detourUntil = 0;

  // people
  pBlocked = 0;

  // per-tick planning scratch (not part of the canonical state)
  planTo = -1;
  planSafety = -1;
  planDir = 0;
  want = -1;
  waitOn = -1;
  movedTick = -1;
  stoppedRun = 0;
  inJam = 0;
  blockedTicks = 0;

  constructor(id: number, type: number, robot: boolean, vendor: number, cls: number, pass: Uint8Array, speed: number,
    turnTicks: number, safetyCells: number, cell: number) {
    this.id = id;
    this.type = type;
    this.robot = robot;
    this.vendor = vendor;
    this.cls = cls;
    this.pass = pass;
    this.speed = speed;
    this.turnTicks = turnTicks;
    this.safetyCells = safetyCells;
    this.cell = cell;
  }
}
