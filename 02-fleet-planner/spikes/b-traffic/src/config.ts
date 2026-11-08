// Spike b config: agent specs for the traffic model, many-brains knobs, fleet scaling. Integers only.
import type { AgentTypeId, PassClass, Scenario } from '../../../src/contracts/types.ts';

export const CELL_MM = 1500;
export const TICKS_PER_MIN = 120;
export const TICKS_PER_HOUR = 7200;

export const T_AMR = 0;
export const T_FORK = 1;
export const T_HUM = 2;
export const T_PICKER = 3;
export const T_DRIVER = 4;
export const TYPE_IDS: readonly AgentTypeId[] = ['amr', 'forklift', 'humanoid', 'picker', 'driver'];

export interface TypeSpec {
  id: AgentTypeId;
  robot: boolean;
  cls: PassClass;
  /** Speed in shared aisles, mm per 0.5 s tick. */
  mmPerTick: number;
  /** Extra ticks per 90 degree turn. */
  turnTicks: number;
  /** Cells kept clear ahead while moving. */
  safetyCells: number;
  /** Full battery in ticks of run time, and ticks of run time gained per tick on a charger. */
  batteryTicks: number;
  chargePerTick: number;
  work: 'pick' | 'pallet';
}

export const SPECS: readonly TypeSpec[] = [
  { id: 'amr', robot: true, cls: 'small', mmPerTick: 500, turnTicks: 1, safetyCells: 0, batteryTicks: 10 * TICKS_PER_HOUR, chargePerTick: 10, work: 'pick' },
  { id: 'forklift', robot: true, cls: 'forklift', mmPerTick: 500, turnTicks: 2, safetyCells: 1, batteryTicks: 6 * TICKS_PER_HOUR, chargePerTick: 6, work: 'pallet' },
  { id: 'humanoid', robot: true, cls: 'small', mmPerTick: 400, turnTicks: 0, safetyCells: 0, batteryTicks: 2 * TICKS_PER_HOUR, chargePerTick: 2, work: 'pick' },
  { id: 'picker', robot: false, cls: 'human', mmPerTick: 500, turnTicks: 0, safetyCells: 0, batteryTicks: 0, chargePerTick: 0, work: 'pick' },
  { id: 'driver', robot: false, cls: 'human', mmPerTick: 670, turnTicks: 0, safetyCells: 0, batteryTicks: 0, chargePerTick: 0, work: 'pallet' },
];

/** Many-brains knobs. The first three are the scenario's `traffic.silo`; the rest are spike extras. */
export interface SiloKnobs {
  /** Foreign robots within this Manhattan range are walls for a detour. */
  sensorCells: number;
  /** Rung 1 (detour) every waitTicks blocked ticks; rung 2 (random step aside) every 4 x waitTicks. */
  waitTicks: number;
  /** Rung 3: stuck this many minutes without progress -> manual reset. Also the one-brain safety net. */
  resetMin: number;
  /** Fleet-manager job timeout: no progress for this many minutes -> another station or job (0 = off). Both modes. */
  retaskMin: number;
  /** Detour search window (Manhattan radius around the robot). */
  detourRadius: number;
  /** After a random step aside the robot waits 1..backoffMax ticks. */
  backoffMax: number;
  /** Random 0..waitTicks-1 extra ticks before each rung-1 detour (real robots are not in lockstep). */
  jitter: boolean;
  /** Per-vendor job pools (true) or one shared pool. */
  vendorQueues: boolean;
  /** Per-vendor chargers (true) or one shared pool. */
  vendorChargers: boolean;
}

export const DEFAULT_SILO: SiloKnobs = {
  sensorCells: 3,
  waitTicks: 5,
  resetMin: 5,
  retaskMin: 1.5,
  detourRadius: 6,
  backoffMax: 3,
  jitter: true,
  vendorQueues: true,
  vendorChargers: true,
};

export interface WorkSpec {
  /** Dwell ticks at a pick face, at a pack station, at a dock (load) and at a face (put away). */
  faceDwell: number;
  packDwell: number;
  dockDwell: number;
  putDwell: number;
  /** Go charge when battery is below this percent at the end of a task. */
  chargeAtPct: number;
  /** Open tasks per pool = poolFactor x agents in the pool (min 4): the always-full queue. */
  poolFactor: number;
  /** Battery at start: uniform in [minStartPct, 100]. */
  minStartPct: number;
  /** WMS sends each tote to the pack station with the fewest agents heading to it (else: random station). */
  balanceStations: boolean;
  /** Robots: while the goal cell is taken, wait 2 cells back instead of next to it (keeps the exit free). */
  goalHold: boolean;
  /** People: the same station manners (default on: people don't crowd a busy station). */
  peopleGoalHold: boolean;
  /** Pickers also walk totes to the pack stations (the brief's loop). false: pickers stay in the pick zone (face to face). */
  peoplePack: boolean;
  /** Many brains only: each pick vendor gets its own pack stations (segregation); people use all of them. */
  vendorStations: boolean;
}

export const DEFAULT_WORK: WorkSpec = {
  faceDwell: 10,
  packDwell: 4,
  dockDwell: 10,
  putDwell: 10,
  chargeAtPct: 20,
  poolFactor: 2,
  minStartPct: 30,
  balanceStations: true,
  goalHold: false,
  peopleGoalHold: true,
  peoplePack: true,
  vendorStations: false,
};

export type Mode = 'central' | 'siloed';
export type Fleet = Record<AgentTypeId, number>;
export type Vendors = Scenario['vendors'];

export interface RunOpts {
  mode: Mode;
  seed: number;
  fleet: Fleet;
  vendors: Vendors;
  silo: SiloKnobs;
  work: WorkSpec;
  /** Ticks excluded from the KPIs at the start. */
  warmupTicks: number;
  /** Check the no-overlap and robot-never-enters-a-person invariants every tick. */
  checks: boolean;
}

/** Largest-remainder split of `total` by integer weights (deterministic, ties to the lower index). */
export function splitByWeights(total: number, weights: readonly number[], minEach = 0): number[] {
  const n = weights.length;
  const out = new Array<number>(n).fill(minEach);
  let left = total - minEach * n;
  if (left < 0) throw new Error('splitByWeights: total below minimum');
  const wsum = weights.reduce((a, b) => a + b, 0);
  const rem: { i: number; r: number }[] = [];
  let used = 0;
  for (let i = 0; i < n; i++) {
    const q = Math.floor((left * weights[i]) / wsum);
    out[i] += q;
    used += q;
    rem.push({ i, r: (left * weights[i]) % wsum });
  }
  rem.sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; k < left - used; k++) out[rem[k].i] += 1;
  return out;
}

/** Scale the default fleet (30 robots) to about `robots` robots with the same mix; people scale too. */
export function scaleFleet(base: Fleet, robots: number): Fleet {
  const baseRobots = base.amr + base.forklift + base.humanoid;
  const r = (x: number) => Math.floor((x * robots * 2 + baseRobots) / (baseRobots * 2)); // round half up, integer only
  const amr = r(base.amr);
  const forklift = r(base.forklift);
  const humanoid = Math.max(0, robots - amr - forklift);
  return { amr, forklift, humanoid, picker: r(base.picker), driver: r(base.driver) };
}
