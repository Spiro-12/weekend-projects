// Shared by property-*.test.ts (split in two files so vitest runs them in parallel). Brief: 50 seeds x 10,000 ticks
// on the default layout, 60 robots (the default mix: 48 AMRs, 8 forklifts, 4 humanoids) + 16 moving people
// (14 pickers, 2 drivers), every planned move checked before it is applied.
import { Harness, mix, type Violations } from './harness.ts';

export const PROPERTY_TICKS = 10_000;

export interface PropertyResult {
  seed: number;
  violations: Violations;
  moves: number;
  goals: number;
  yields: number;
  detours: number;
  resets: number;
  personMoves: number;
}

/**
 * Variants across the seeds:
 * - even seeds: Track A's convention, robots parked at their goal are `ready` with goal = cell (pushable)
 * - seeds 0, 1 mod 4: work goals (faces, stations, pockets); 2, 3 mod 4: any cell (robots dwell in cross aisles)
 * - every third seed: breakdowns (a robot holds its cell 1 to 5 min) and fleet churn (robots leave, leaving null
 *   holes in `agents`, and new ones join with new ids: the fleet grows)
 */
export function propertyRun(seed: number): PropertyResult {
  const events = seed % 3 === 0;
  const h = new Harness({
    seed, robots: mix(60), pickers: 14, drivers: 2, checks: true, pocketGoalPct: 10,
    goals: seed % 4 < 2 ? 'work' : 'any',
    parkedReady: seed % 2 === 0,
    breakdownEvery: events ? 400 : 0,
    churnEvery: events ? 300 : 0,
  });
  h.run(PROPERTY_TICKS);
  return {
    seed,
    violations: { ...h.violations },
    moves: h.moves,
    goals: h.robots().reduce((s, a) => s + a.goals, 0),
    yields: h.events.yield,
    detours: h.events.detour,
    resets: h.resets,
    personMoves: h.personMoves,
  };
}

export const NO_VIOLATIONS: Violations = { overlap: 0, occMismatch: 0, intoHeld: 0, intoPerson: 0, intoVacating: 0, conflict: 0, swap: 0, forkliftOnNarrow: 0, pocketNotGoal: 0, badMove: 0, wantMissing: 0, wantNotMove: 0 };
