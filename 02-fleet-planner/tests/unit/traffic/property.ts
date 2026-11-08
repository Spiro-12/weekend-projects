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

/** Even seeds draw work goals (faces, stations, pockets), odd seeds any cell (robots dwell in cross aisles too). */
export function propertyRun(seed: number): PropertyResult {
  const h = new Harness({ seed, robots: mix(60), pickers: 14, drivers: 2, checks: true, pocketGoalPct: 10, goals: seed % 2 === 0 ? 'work' : 'any' });
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

export const NO_VIOLATIONS: Violations = { overlap: 0, occMismatch: 0, intoHeld: 0, intoPerson: 0, intoVacating: 0, conflict: 0, swap: 0, forkliftOnNarrow: 0, pocketNotGoal: 0, badMove: 0 };
