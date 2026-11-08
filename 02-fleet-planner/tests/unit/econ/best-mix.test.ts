import { describe, expect, it } from 'vitest';
import type { Scenario } from '../../../src/contracts/types.ts';
import { createFakeRunner } from '../../../src/host/runner/fake.ts';
import { findBaseline } from '../../../src/econ/baseline.ts';
import { bestMix, rankMixes, type MixOption } from '../../../src/econ/best-mix.ts';
import { computeMoney } from '../../../src/econ/money.ts';
import { agents, defaultScenario, mkRun, withFleet } from './helpers.ts';

const crew = { picker: 24, driver: 3 };
const baseline = mkRun({}, { amr: 0, forklift: 0, humanoid: 0, ...crew });
function option(s: Scenario, keepsUp = true): MixOption {
  const result = mkRun(keepsUp ? {} : { keepsUp: false, oph: 450, backlogTrendPerHour: 150 }, s.fleet);
  return { scenario: s, result, money: computeMoney({ scenario: s, agents, candidate: result, baseline, baselineCrew: crew }) };
}

describe('best mix', () => {
  it('the highest 3-year net among options that keep up', () => {
    const opts = [10, 20, 30, 40].map((amr) => option(withFleet(defaultScenario, { amr, forklift: 0, humanoid: 0, picker: 24 - amr / 4, driver: 3 })));
    const best = bestMix(opts)!;
    const nets = opts.map((o) => o.money.threeYearNet.value!);
    expect(best.money.threeYearNet.value).toBe(Math.max(...nets));
  });
  it('never an option that can’t keep up, however good its numbers look', () => {
    const keeps = option(withFleet(defaultScenario, { amr: 10, forklift: 0, humanoid: 0, picker: 20, driver: 3 }));
    const cheapButSlow = option(withFleet(defaultScenario, { amr: 10, forklift: 0, humanoid: 0, picker: 6, driver: 1 }), false);
    expect(cheapButSlow.money.savingsYear.value!).toBeGreaterThan(keeps.money.savingsYear.value!);
    expect(bestMix([cheapButSlow, keeps])).toBe(keeps);
    expect(bestMix([cheapButSlow])).toBeNull();
    expect(bestMix([])).toBeNull();
  });
  it('never ranked by payback: a small rented fleet pays back in months, a big bought one earns far more in 3 years', () => {
    // Rent 4 cart robots, 2 pickers fewer: payback 42,000 ÷ (146,042 ÷ 12) ≈ 3.5 months, 3-year net ≈ $396k.
    const quick = option(withFleet(defaultScenario, { amr: 4, forklift: 0, humanoid: 0, picker: 22, driver: 3 }, 'raas'));
    // Buy 40 cart robots, 12 pickers fewer: payback ≈ 23 months, 3-year net ≈ $1.02M.
    const big = option(withFleet(defaultScenario, { amr: 40, forklift: 0, humanoid: 0, picker: 12, driver: 3 }, 'buy'));
    expect(quick.money.paybackMonths.value!).toBeLessThan(4);
    expect(big.money.paybackMonths.value!).toBeGreaterThan(20);
    expect(big.money.threeYearNet.value!).toBeGreaterThan(2 * quick.money.threeYearNet.value!);
    expect(bestMix([quick, big])).toBe(big);
  });
  it('ties: lower upfront cost, then fewer robots, then input order', () => {
    const a = option(withFleet(defaultScenario, { amr: 10, forklift: 0, humanoid: 0, picker: 20 }));
    const fakeTie = (o: MixOption, net: number, capex: number): MixOption => ({
      ...o,
      money: { ...o.money, threeYearNet: { ...o.money.threeYearNet, value: net }, capex: { ...o.money.capex, value: capex } },
    });
    const x = fakeTie(a, 100, 50);
    const y = fakeTie(a, 100, 40);
    const z = fakeTie(a, 100, 40);
    expect(rankMixes([x, y, z])).toEqual([y, z, x]);
    expect(bestMix([z, y, x])).toBe(z);
  });
  it('end to end on the fake runner: a sweep of cart robots picks a keeper with the top 3-year net', async () => {
    const runner = createFakeRunner();
    const b = await findBaseline(defaultScenario, runner);
    const opts: MixOption[] = [];
    for (const amr of [0, 8, 16, 24, 32, 40, 60]) {
      const s = withFleet(defaultScenario, { amr });
      const result = await runner.evaluate(s);
      opts.push({ scenario: s, result, money: computeMoney({ scenario: s, agents, candidate: result, baseline: b.result, baselineCrew: b.crew }) });
    }
    const best = bestMix(opts);
    const keepers = opts.filter((o) => o.result.kpis.keepsUp);
    if (keepers.length === 0) expect(best).toBeNull();
    else expect(best!.money.threeYearNet.value).toBe(Math.max(...keepers.map((o) => o.money.threeYearNet.value!)));
  });
});
