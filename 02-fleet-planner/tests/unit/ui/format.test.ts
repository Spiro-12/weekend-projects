// Track F pure functions: number words, the money hovers' worked formulas, who is behind when a comparison isn't
// like for like, and the fleet hovers. Runs against the fake economics and against reports shaped like Track C's.
import { describe, expect, it } from 'vitest';
import agentsJson from '../../../data/agents.json';
import sourcesJson from '../../../data/sources.json';
import scenarioJson from '../../../data/scenarios/default.json';
import econFixture from '../../../fixtures/econ.json';
import type { AgentsFile, Explained, MoneyReport, Scenario, SourcesFile } from '../../../src/contracts/types.ts';
import { fakeEcon } from '../../../src/host/econ-port.ts';
import { fakeEvaluate } from '../../../src/host/runner/fake.ts';
import { peopleOnly } from '../../../src/host/settings.ts';
import { agentContent, cleanNote, FLAG_WORDS, fromExplained, headlineIsEstimate } from '../../../src/ui/explain/content.ts';
import { clock, duration, minutes, n1, usd, usdShort, withUnit, yearsFromMonths } from '../../../src/ui/explain/format.ts';
import { hasNumbers, lineContent, moneyContent, whoIsBehind, workedLine } from '../../../src/ui/explain/money.ts';

const agents = agentsJson as AgentsFile;
const sources = (sourcesJson as SourcesFile).sources;
const scenario = scenarioJson as Scenario;

function report(s: Scenario) {
  const candidate = fakeEvaluate(s);
  const crew = { picker: 18, driver: 3 };
  const base = { ...peopleOnly(s), fleet: { ...peopleOnly(s).fleet, ...crew } };
  const baseline = fakeEvaluate(base);
  const m = fakeEcon.computeMoney({ scenario: s, agents, candidate, baseline, baselineCrew: crew });
  const ctx = { oph: candidate.kpis.oph, baselineOph: baseline.kpis.oph, demand: s.orders.perHour, planKeepsUp: candidate.kpis.keepsUp, sources };
  return { m, candidate, ctx };
}
const ex = (value: number | null, unit: string, formula: string, flag?: Explained['flag']): Explained => ({ value, unit, formula, inputs: [], ...(flag ? { flag } : {}) });

describe('number words', () => {
  it('money, units and edge words', () => {
    expect(usd(1_092_000)).toBe('$1,092,000');
    expect(usd(17.95)).toBe('$17.95');
    expect(usd(-12_000)).toBe('−$12,000');
    expect(usd(0)).toBe('$0');
    expect(usdShort(2_312_000)).toBe('$2.31M');
    expect(usdShort(675_000)).toBe('$675k');
    expect(usdShort(35_500)).toBe('$35.5k');
    expect(usdShort(1_234)).toBe('$1,234');
    expect(usdShort(0.9)).toBe('$0.90');
    expect(usdShort(-1_950_658)).toBe('−$1.95M');
    expect(usdShort(0)).toBe('$0');
    expect(withUnit(120_447, 'USD/yr')).toBe('$120,447 a year');
    expect(withUnit(1_500, 'USD/month')).toBe('$1,500 a month');
    expect(withUnit(17.95, 'USD/h')).toBe('$17.95 an hour');
    expect(withUnit(12, '%/yr')).toBe('12% a year');
    expect(withUnit(0.46, 'x')).toBe('+46%');
    expect(withUnit(4160, 'h')).toBe('4,160 hours');
    expect(withUnit(16, 'people/shift')).toBe('16 people per shift');
    expect(withUnit(1, 'robots')).toBe('1 robot');
    expect(n1(600)).toBe('600');
    expect(n1(1.66)).toBe('1.7');
    expect(minutes(688)).toBe('11');
    expect(minutes(300)).toBe('5');
    expect(duration(130)).toBe('2 min 10 s');
    expect(clock(7200 + 120 * 5)).toBe('01:05');
  });
  it('years under the payback never say "0 years"', () => {
    expect(yearsFromMonths(0.5)).toBe('under a year');
    expect(yearsFromMonths(11.9)).toBe('under a year');
    expect(yearsFromMonths(12)).toBe('1 year');
    expect(yearsFromMonths(19.4)).toBe('1.6 years');
    expect(yearsFromMonths(230)).toBe('19 years');
  });
});

describe('worked formulas', () => {
  it('reproduce the reported values, and are dropped when they would not', () => {
    const { m, ctx } = report(scenario);
    expect(workedLine('threeYearNet', m, ctx)).toMatch(/^3 × \$[\d,]+ − \$[\d,]+ = −?\$[\d,]+$/);
    expect(workedLine('capex', m, ctx)).toContain('(24 cart robots)');
    expect(workedLine('savingsYear', m, ctx)).toMatch(/ a year$/);
    expect(workedLine('costPerOrder', m, ctx)).toContain('orders an hour × 4,160 hours');
    const broken = { ...m, threeYearNet: { ...m.threeYearNet, value: (m.threeYearNet.value ?? 0) + 50_000 } };
    expect(workedLine('threeYearNet', broken, ctx)).toBeUndefined();
    const good = { ...m, savingsYear: { ...m.savingsYear, value: 600_000 }, paybackMonths: { ...m.paybackMonths, value: (m.capex.value! / 600_000) * 12, flag: undefined } };
    expect(workedLine('paybackMonths', good, ctx)).toMatch(/÷ \(\$600,000 ÷ 12 months\) = [\d.]+ months$/);
  });
  it('are skipped when the model’s formula already has the numbers (Track C), so the sum is not shown twice', () => {
    const { m, ctx } = report(scenario);
    expect(hasNumbers('payback = upfront ÷ (savings ÷ 12)')).toBe(false);
    expect(hasNumbers('payback = $1,092,000 upfront ÷ ($675,000 saved a year ÷ 12) = 19.4 months')).toBe(true);
    expect(hasNumbers("no payback: this option can't keep up with the orders: it ships 469.0 orders/h")).toBe(true);
    expect(moneyContent('threeYearNet', m, ctx).worked).toBeDefined();
    const withNumbers = { ...m, threeYearNet: { ...m.threeYearNet, formula: '3-year net = 3 × $120,447 savings a year − $2,312,000 upfront = −$1,950,659' } };
    expect(moneyContent('threeYearNet', withNumbers, ctx).worked).toBeUndefined();
  });
  it('"never pays back" with exactly $0 savings says it costs the same, not more', () => {
    const { m, ctx } = report(scenario);
    const zero = { ...m, savingsYear: { ...m.savingsYear, value: 0 }, paybackMonths: ex(null, 'months', 'payback = upfront ÷ (savings ÷ 12)', 'never') };
    expect(workedLine('paybackMonths', zero, ctx)).toContain('costs the same each year');
    const neg = { ...zero, savingsYear: { ...m.savingsYear, value: -5_000 } };
    expect(workedLine('paybackMonths', neg, ctx)).toContain('costs more each year');
  });
});

describe('who is behind', () => {
  const { m } = report(scenario);
  const flagged = (base: MoneyReport, baseKeeps: boolean): MoneyReport => ({
    ...base,
    baseline: { ...base.baseline, keepsUp: baseKeeps },
    paybackMonths: ex(null, 'months', "no payback: the people-only crew can't keep up with the orders: it ships 1,400.0 orders/h", 'doesntKeepUp'),
    threeYearNet: ex(null, 'USD', "no 3-year net: the people-only crew can't keep up with the orders: it ships 1,400.0 orders/h", 'doesntKeepUp'),
  });
  it('tells the plan, the people-only crew and both apart', () => {
    expect(whoIsBehind(m, true)).toBeNull();
    expect(whoIsBehind(flagged(m, false), true)).toBe('people');
    expect(whoIsBehind(flagged(m, true), false)).toBe('plan');
    expect(whoIsBehind(flagged(m, false), false)).toBe('both');
    // Without the run, the flag plus the baseline decide.
    expect(whoIsBehind(flagged(m, true), undefined)).toBe('plan');
  });
  it('robots keep up, people only can’t: the blame goes to the people-only crew, not the plan', () => {
    const r = flagged(m, false);
    const ctx = { oph: 1500, baselineOph: 1400, demand: 1500, planKeepsUp: true, sources };
    const pb = moneyContent('paybackMonths', r, ctx);
    expect(pb.flag).toBe('The people-only crew can’t keep up with these orders, so there’s no like-for-like payback');
    expect(pb.flag).not.toContain(FLAG_WORDS.doesntKeepUp);
    expect(pb.value).toBeUndefined();
    const net = moneyContent('threeYearNet', r, ctx);
    expect(net.flag).toBe('Not comparable: people only falls behind the orders');
    // A saving that isn't like for like is never the headline; it is kept small, for reference.
    const sav = moneyContent('savingsYear', r, ctx);
    expect(sav.value).toBeUndefined();
    expect(sav.reference).toMatch(/^For reference only: −?\$[\d,]+ a year$/);
    expect(sav.text![0]).toContain('people-only crew can’t ship all the orders');
    // The fake economics' worked line (its formula has no numbers) explains the people-only side.
    const fakeShape = { ...r, paybackMonths: { ...r.paybackMonths, formula: 'payback = upfront ÷ (savings ÷ 12)' } };
    expect(moneyContent('paybackMonths', fakeShape, ctx).worked).toBe(
      'The people-only crew (18 pickers + 3 drivers) ships 1,400 of the 1,500 orders coming in each hour, so it falls behind. This plan keeps up, so there is no like-for-like payback.',
    );
  });
  it('the plan can’t keep up: its savings are words, the payback flag blames the plan', () => {
    const r = { ...m, paybackMonths: ex(null, 'months', 'payback = upfront ÷ (savings ÷ 12)', 'doesntKeepUp') };
    const ctx = { oph: 469, baselineOph: 600, demand: 600, planKeepsUp: false, sources };
    expect(moneyContent('paybackMonths', r, ctx).flag).toBe(FLAG_WORDS.doesntKeepUp);
    expect(moneyContent('paybackMonths', r, ctx).worked).toContain('This plan ships 469 of the 600 orders');
    const net = moneyContent('threeYearNet', r, ctx);
    expect(net.flag).toBe('Not comparable: this plan falls behind the orders');
    expect(net.reference).toMatch(/^For reference only: /);
  });
});

describe('money hovers', () => {
  it('flags are words and never numbers; every money hover lists what is left out', () => {
    const never = econFixture.econ.paybackNever as Explained;
    const c = fromExplained('Pays back in', never, sources);
    expect(c.value).toBeUndefined();
    expect(c.flag).toBe(FLAG_WORDS.never);
    expect(c.notModeled).toBe(true);
    const { m, ctx } = report(peopleOnly(scenario));
    expect(m.capex.value).toBe(0);
    const pb = moneyContent('paybackMonths', m, ctx);
    expect(pb.value).toBeUndefined();
    expect([FLAG_WORDS.never, FLAG_WORDS.doesntKeepUp]).toContain(pb.flag);
    expect(cleanNote('Demo data: toy. Not modeled: taxes, depreciation, discounting, interest, residual value, building changes.')).toBe('Demo data: toy.');
    const labor = fromExplained('People', econFixture.econ.laborPerYear as Explained, sources);
    expect(labor.inputs!.find((r) => r.label === 'Picker wage')!.source?.url).toBe(sources.find((s) => s.id === 'bls-hand-laborers')!.url);
  });
  it("Track C's lines: people lines carry pay and trucks for extra drivers", () => {
    const { m, ctx } = report(scenario);
    const withPeople = {
      ...m,
      lines: [
        ...m.lines,
        { type: 'picker' as const, label: 'Picker (person)', count: 14, capex: ex(0, 'USD', 'upfront = $0'), opexYear: ex(1_000_000, 'USD/yr', 'labor') },
        { type: 'driver' as const, label: 'Forklift driver (person)', count: 4, capex: ex(35_000, 'USD', 'trucks'), opexYear: ex(190_000, 'USD/yr', 'labor') },
      ],
      capex: { ...m.capex, value: m.capex.value! + 35_000 },
    };
    expect(workedLine('robotOpexYear', withPeople, ctx)).toMatch(/ a year$/);
    // Trucks are only for drivers beyond the people-only crew: never "(4 forklift drivers)".
    expect(workedLine('capex', withPeople, ctx)).toContain('$35,000 (trucks for extra drivers)');
    expect(workedLine('capex', withPeople, ctx)).not.toContain('forklift drivers)');
    expect(lineContent(withPeople.lines.at(-2)!, 'opexYear', ctx, 'buy').title).toBe('14 pickers: pay per year');
    expect(lineContent(withPeople.lines.at(-1)!, 'capex', ctx, 'buy').title).toBe('Forklift drivers: trucks for extra drivers');
    expect(lineContent(withPeople.lines[0], 'opexYear', ctx, 'raas').title).toBe('24 cart robots: rent per year');
  });
  it('a recalculating report marks its popovers', () => {
    const { m, ctx } = report(scenario);
    expect(moneyContent('capex', m, { ...ctx, stale: true }).stale).toBe(true);
    expect(moneyContent('capex', m, ctx).stale).toBeFalsy();
  });
});

describe('fleet hovers', () => {
  it('based-on products and every spec number with its origin', () => {
    const amr = agents.agents.find((a) => a.id === 'amr')!;
    const c = agentContent(amr, sources);
    expect(c.text![0]).toContain('Locus Origin');
    const price = c.inputs!.find((r) => r.label === 'Price to buy')!;
    expect(price.from).toBe('estimate');
    expect(price.note).toContain(amr.cost.buyUsd!.note!);
    expect(price.note).toContain('Range: $15,000 to $50,000');
    for (const r of c.inputs!) if (r.from.startsWith('source:')) expect(r.source, r.label).toBeDefined();
    expect(headlineIsEstimate(amr, 'buy')).toBe(true);
    expect(headlineIsEstimate(agents.agents.find((a) => a.id === 'humanoid')!, 'buy')).toBe(false);
  });
});
