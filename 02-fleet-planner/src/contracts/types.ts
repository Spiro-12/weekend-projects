// Fleet Planner contracts (PROTOCOL.md is the prose version). Only the lead changes this file, together with
// PROTOCOL.md and fixtures/. No DOM, no node: this file compiles under tsconfig.sim.json.

// ───────────────────────────── §1 Units and time ─────────────────────────────
/** One sim tick = 0.5 s of warehouse time. */
export const TICK_MS = 500;
/** One grid cell = 1.5 m. */
export const CELL_MM = 1500;
export const TICKS_PER_MIN = 120;
export const TICKS_PER_HOUR = 7200;

// ───────────────────────────── §2 Agent specs and sources ─────────────────────────────
export type AgentTypeId = 'amr' | 'forklift' | 'humanoid' | 'picker' | 'driver';
export const AGENT_TYPES: readonly AgentTypeId[] = ['amr', 'forklift', 'humanoid', 'picker', 'driver'];
export const ROBOT_TYPES = ['amr', 'forklift', 'humanoid'] as const;
export type RobotTypeId = (typeof ROBOT_TYPES)[number];
export type HumanTypeId = 'picker' | 'driver';
export type AgentKind = 'robot' | 'human';
/** Which cells an agent may use: 'small' = AMR/humanoid, 'forklift' = forklift-rated cells only, 'human' = people. */
export type PassClass = 'small' | 'forklift' | 'human';
export type Capability = 'pick' | 'carry_tote' | 'carry_pallet';

/** A number with its provenance. `src` is a sources.json id, or 'estimate' (then `note` explains the reasoning). */
export interface Sourced {
  value: number;
  unit: string;
  src: string;
  note?: string;
  range?: [number, number];
}

export interface AgentSpec {
  id: AgentTypeId;
  label: string;
  kind: AgentKind;
  /** Render model key in public/assets/manifest.json (code-built models use a 'code:' prefix). */
  model: string;
  /** Real products the numbers are based on (shown in hovers, never as branding). */
  basedOn: string[];
  passClass: PassClass;
  /** Speed in shared aisles. */
  speedMps: Sourced;
  topSpeedMps?: Sourced;
  payloadKg: Sourced;
  /** Extra cells kept clear ahead while moving (forklift safety field). */
  safetyCells: number;
  can: Capability[];
  /** Seconds per order line at a pick face (pickers, humanoids). */
  pickSecPerLine?: Sourced;
  /** Seconds to pick up or put down a pallet (forklifts, drivers). */
  palletSecPerMove?: Sourced;
  /** Seconds for a robot to hand off or receive totes at a station. */
  handoffSec?: Sourced;
  battery?: { runtimeH: Sourced; chargeH: Sourced; chargeAtPct: number };
  cost: {
    buyUsd?: Sourced;
    raasUsdPerMonth?: Sourced;
    raasSetupUsd?: Sourced;
    maintPctPerYear?: Sourced;
    softwareUsdPerYear?: Sourced;
    integrationUsd?: Sourced;
    wageUsdPerHour?: Sourced;
    /** Equipment a person needs (a manual forklift for a driver). */
    equipmentUsd?: Sourced;
  };
}

export interface AgentsFile {
  format: 'fp-agents';
  v: 1;
  agents: AgentSpec[];
  labor: {
    /** Fully loaded multiplier minus 1 (0.46 => wage x 1.46). */
    laborLoad: Sourced;
    supervisor: { wageUsdPerHour: Sourced; minPerReset: Sourced };
    packer: { wageUsdPerHour: Sourced };
    turnoverPctPerYear?: Sourced;
  };
}

export interface SourceRef {
  id: string;
  title: string;
  publisher: string;
  url: string;
  date: string;
  accessed: string;
}
export interface SourcesFile {
  format: 'fp-sources';
  v: 1;
  sources: SourceRef[];
}

// ───────────────────────────── §3 Layout ─────────────────────────────
/**
 * One character per 1.5 m cell:
 *  '#' rack (blocked; its aisle-side neighbours are pick faces)   '.' narrow aisle (robots and people, no forklifts)
 *  '=' forklift-rated aisle (everyone)                              'D' dock door (blocked; served from the S cell below it)
 *  'S' staging (everyone)                                           'P' pack station (blocked; served from a neighbour)
 *  'C' charger pocket (robots only, entered as a goal)              'K' parking (robots only, entered as a goal)
 *  'X' wall or column (blocked)                                     '> < ^ v' one-way hint on a '=' cell (one-brain guidance only)
 */
export type CellChar = '#' | '.' | '=' | 'D' | 'S' | 'P' | 'C' | 'K' | 'X' | '>' | '<' | '^' | 'v';

export interface LayoutZone {
  id: string;
  label: string;
  kind: 'storage' | 'pack' | 'dock' | 'charge' | 'park' | 'conveyor';
  /** Cell rectangle. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutFile {
  format: 'fp-layout';
  v: 1;
  id: string;
  name: string;
  cellMm: number;
  grid: string[];
  racks: { levels: number; heightMm: number };
  zones: LayoutZone[];
  /** Number of picking aisles (for labels and the UI). */
  aisles: number;
  notes?: string;
}

// ───────────────────────────── §4 Scenario ─────────────────────────────
export type TrafficMode = 'central' | 'siloed' | 'shared-status';
export type VendorShare = { id: string; pct: number };

export type ScenarioEvent =
  | { type: 'breakdown'; atMin: number; agent: string; forMin: number }
  | { type: 'personInAisle'; atMin: number; cell: [number, number]; forMin: number }
  | { type: 'chargers'; atMin: number; count: number }
  | { type: 'orderSurge'; atMin: number; factorPct: number; forMin: number };

export interface GoldenExpect {
  oph?: [number, number];
  capacityOph?: [number, number];
  deadlocks?: [number, number];
  keepsUp?: boolean;
  backlogGrows?: boolean;
  pickerUplift?: [number, number];
  robotCostUsd?: number;
}

export interface Scenario {
  format: 'fp-scenario';
  v: 1;
  id: string;
  name: string;
  layout: string;
  seed: number;
  run: { warmupMin: number; measureMin: number; batterySpread: boolean };
  shift: { hoursPerShift: number; shiftsPerDay: number; daysPerYear: number };
  orders: {
    /** 'demand': orders arrive at perHour. 'saturate': the queue is always full (measures capacity). */
    mode: 'demand' | 'saturate';
    perHour: number;
    /** Integer weights for 1, 2, 3, ... lines per order. */
    linesWeights: number[];
    /** ABC skew: aPct of pick faces get aPicksPct of the picks. */
    sku: { aPct: number; aPicksPct: number };
  };
  /** Forklift work: one replenishment pallet per N picked lines, plus inbound pallets per hour (dock → rack). */
  pallets: { linesPerReplenish: number; inboundPerHour: number };
  /** Packing: stations staffed by packers (same labor in every option), seconds per order. */
  pack: { stations: number; secPerOrder: number };
  fleet: Record<AgentTypeId, number>;
  vendors: Partial<Record<RobotTypeId, VendorShare[]>>;
  traffic: {
    mode: TrafficMode;
    /** Many-brains recovery ladder knobs ("how smart are the vendors' robots"). */
    silo: { sensorCells: number; waitTicks: number; resetMin: number };
  };
  economics: {
    financing: 'buy' | 'raas';
    /** 'auto' = smallest all-human crew that keeps up, on the same orders. */
    baseline: 'auto' | { picker: number; driver: number };
  };
  events: ScenarioEvent[];
  expect?: GoldenExpect;
}

// ───────────────────────────── §5 Sim API ─────────────────────────────
export type AgentState = 'idle' | 'travel' | 'work' | 'wait' | 'blocked' | 'charge' | 'broken';
export const AGENT_STATES: readonly AgentState[] = ['idle', 'travel', 'work', 'wait', 'blocked', 'charge', 'broken'];
export type Cargo = 'none' | 'tote' | 'pallet' | 'cart';
export type Heading = 0 | 1 | 2 | 3; // 0 = +x (east), 1 = +y (south), 2 = -x (west), 3 = -y (north)

export interface AgentView {
  id: number;
  name: string;
  type: AgentTypeId;
  vendor: string;
  model: string;
  /** Cell index (y * width + x). */
  cell: number;
  /** Cell it is moving to, or -1. While moving it holds both cells. */
  to: number;
  moveStart: number;
  moveEnd: number;
  heading: Heading;
  state: AgentState;
  /** Current goal cell or -1. */
  goal: number;
  /** Next cells toward the goal (up to 12), for route ribbons. */
  route: number[];
  taskId: number;
  cargo: Cargo;
  /** 0..100. Humans report 100. */
  batteryPct: number;
  blockedTicks: number;
}

export type TaskKind = 'pick' | 'replenish' | 'inbound' | 'charge' | 'park';
export interface TaskView {
  id: number;
  kind: TaskKind;
  orderIds: number[];
  lines: number;
  stage: string;
  createdTick: number;
  agentIds: number[];
}

export interface Snapshot {
  tick: number;
  width: number;
  height: number;
  agents: AgentView[];
  tasks: TaskView[];
  stats: { ticksByState: Record<AgentTypeId, Record<AgentState, number>> };
  openOrders: number;
  shippedOrders: number;
  chargers: { cell: number; vendor: string; agentId: number }[];
  deadlocks: { ids: number[]; sinceTick: number }[];
  /** Blocked agent-ticks per cell since start (heatmap). */
  heat: number[];
}

export type SimEvent =
  | { t: 'orderArrived'; tick: number; order: number; lines: number }
  | { t: 'orderPacked'; tick: number; order: number }
  | { t: 'orderShipped'; tick: number; order: number; arrivedTick: number }
  | { t: 'taskAssigned'; tick: number; task: number; kind: TaskKind; agents: number[] }
  | { t: 'pickDone'; tick: number; agent: number; order: number; units: number }
  | { t: 'toteDelivered'; tick: number; agent: number; station: number }
  | { t: 'palletMoved'; tick: number; agent: number; kind: 'replenish' | 'inbound' }
  | { t: 'jamStart'; tick: number; jam: number; agents: number[]; cell: number }
  | { t: 'jamEnd'; tick: number; jam: number }
  | { t: 'deadlockStart'; tick: number; deadlock: number; agents: number[] }
  | { t: 'deadlockEnd'; tick: number; deadlock: number }
  | { t: 'manualReset'; tick: number; agent: number }
  | { t: 'chargeStart'; tick: number; agent: number; charger: number }
  | { t: 'chargeEnd'; tick: number; agent: number }
  | { t: 'breakdown'; tick: number; agent: number }
  | { t: 'repair'; tick: number; agent: number }
  | { t: 'personInAisle'; tick: number; cell: number; until: number };

export type Command =
  | { t: 'setFleet'; type: AgentTypeId; count: number; vendor?: string }
  | { t: 'setOrderRate'; perHour: number }
  | { t: 'setTraffic'; mode: TrafficMode }
  | { t: 'inject'; event: ScenarioEvent };

/** Cheap per-tick counters for the KPI recorder (no routes, no per-agent views). */
export interface SimStats {
  tick: number;
  openOrders: number;
  shippedOrders: number;
  ticksByState: Record<AgentTypeId, Record<AgentState, number>>;
  /** Units (lines) picked so far, per picking agent type. */
  unitsPicked: Partial<Record<AgentTypeId, number>>;
  /** Agent counts per type right now. */
  fleet: Record<AgentTypeId, number>;
}

export interface Sim {
  readonly tick: number;
  step(n?: number): void;
  stats(): SimStats;
  /** Applied at the start of the next tick and recorded in the command log with that tick. */
  command(c: Command): void;
  commandLog(): { tick: number; c: Command }[];
  snapshot(): Snapshot;
  /** Events since the last drain, in tick order. */
  drainEvents(): SimEvent[];
  /** FNV-1a over the canonical integer state. Throws if any state number is not an integer. */
  hash(): string;
}

// ───────────────────────────── §6 Runner and KPIs ─────────────────────────────
export interface StateShare {
  utilizationPct: number;
  idlePct: number;
  blockedPct: number;
  waitPct: number;
  chargingPct: number;
  brokenPct: number;
}

export interface Kpis {
  /** Orders shipped per hour in the measure window (capped by demand by definition). */
  oph: number;
  /** Orders per hour with an always-full queue (orders.mode 'saturate'), when measured. */
  capacityOph?: number;
  /** Robot utilization across all robots, % of non-broken time spent travelling to/with tasks or working. */
  robotUtilizationPct: number;
  jamsPerHour: number;
  deadlocksPerShift: number;
  avgOrderSec: number;
  p90OrderSec: number;
  backlogEnd: number;
  /** Change in open orders per hour over the window. */
  backlogTrendPerHour: number;
  keepsUp: boolean;
  /** Units per picker-hour divided by the people-only rate, both at capacity (when measured). */
  pickerUplift?: number;
  resetsPerHour: number;
  unitsPerPickerHour: number;
  byType: Partial<Record<AgentTypeId, StateShare>>;
}

export interface RunResult {
  scenarioId: string;
  settingsHash: string;
  kpis: Kpis;
  fleet: Record<AgentTypeId, number>;
  traffic: TrafficMode;
  /** Sim state hash at the end of the run. */
  hash: string;
  ticks: number;
  /** Wall time the run took (not part of determinism). */
  simMs: number;
}

/** Turns a run into KPIs (Track C implements it; the runner drives it, PROTOCOL §6). */
export interface KpiRecorder {
  /** Once, at the end of warm-up. */
  start(stats: SimStats): void;
  /** Every 60 ticks inside the window. */
  sample(stats: SimStats): void;
  /** Every event drained inside the window. */
  events(list: SimEvent[]): void;
  finish(stats: SimStats): Kpis;
}
export type KpiRecorderFactory = (s: Scenario, window: { warmupTick: number; endTick: number }) => KpiRecorder;

export interface SweepFile {
  format: 'fp-sweep';
  v: 1;
  axes: { type: AgentTypeId; values: number[] }[];
  base: string;
  results: RunResult[];
}

// ───────────────────────────── §7 Economics ─────────────────────────────
/** What the money panel needs (Track C computes it, Track F shows it, the host wires them). */
export interface MoneyInput {
  scenario: Scenario;
  agents: AgentsFile;
  candidate: RunResult;
  baseline: RunResult;
  baselineCrew: { picker: number; driver: number };
}

export interface MoneyLine {
  type: AgentTypeId;
  label: string;
  count: number;
  capex: Explained;
  opexYear: Explained;
}

export interface MoneyReport {
  financing: 'buy' | 'raas';
  hoursPerYear: number;
  lines: MoneyLine[];
  capex: Explained;
  robotOpexYear: Explained;
  laborYear: Explained;
  annualCost: Explained;
  baselineAnnualCost: Explained;
  savingsYear: Explained;
  paybackMonths: Explained;
  threeYearNet: Explained;
  costPerOrder: Explained;
  baselineCostPerOrder: Explained;
  baseline: { picker: number; driver: number; keepsUp: boolean };
}

export type ExplainFrom = `source:${string}` | 'estimate' | 'sim' | 'user';
export interface ExplainInput {
  label: string;
  value: number;
  unit: string;
  from: ExplainFrom;
  note?: string;
}
export interface Explained {
  value: number;
  unit: string;
  formula: string;
  inputs: ExplainInput[];
  note?: string;
  /** 'never' = savings ≤ 0; 'doesntKeepUp' = the option can't handle the orders. */
  flag?: 'never' | 'doesntKeepUp';
}
