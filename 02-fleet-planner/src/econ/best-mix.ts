// Best mix (PROTOCOL §7): the option with the highest 3-year net savings among those that keep up. Never ranked by
// payback: renting "pays back" almost at once while often losing money over three years. Track J uses it (Phase 2).
import type { MoneyReport, RunResult, Scenario } from '../contracts/types.ts';
import { ROBOT_TYPES } from '../contracts/types.ts';

export interface MixOption {
  scenario: Scenario;
  result: RunResult;
  money: MoneyReport;
}

const robots = (o: MixOption) => ROBOT_TYPES.reduce((a, t) => a + o.scenario.fleet[t], 0);

/** Options that keep up (and so have a 3-year net), best first: highest 3-year net, then lower upfront cost, then
 *  fewer robots, then input order. Deterministic for the same input. */
export function rankMixes<T extends MixOption>(options: readonly T[]): T[] {
  return options
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.result.kpis.keepsUp && o.money.threeYearNet.value !== null)
    .sort(
      (a, b) =>
        b.o.money.threeYearNet.value! - a.o.money.threeYearNet.value! ||
        (a.o.money.capex.value ?? 0) - (b.o.money.capex.value ?? 0) ||
        robots(a.o) - robots(b.o) ||
        a.i - b.i,
    )
    .map(({ o }) => o);
}

/** The highest 3-year net savings among options that keep up, or null when none keeps up. */
export function bestMix<T extends MixOption>(options: readonly T[]): T | null {
  return rankMixes(options)[0] ?? null;
}
