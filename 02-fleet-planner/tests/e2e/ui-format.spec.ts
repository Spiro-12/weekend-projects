// Track F, no browser page: number words and the money hovers' worked formulas (pure functions).
import { expect, test } from '@playwright/test';
import agentsJson from '../../data/agents.json' with { type: 'json' };
import sourcesJson from '../../data/sources.json' with { type: 'json' };
import scenarioJson from '../../data/scenarios/default.json' with { type: 'json' };
import econFixture from '../../fixtures/econ.json' with { type: 'json' };
import type { AgentsFile, Explained, Scenario, SourcesFile } from '../../src/contracts/types.ts';
import { fakeEcon } from '../../src/host/econ-port.ts';
import { fakeEvaluate } from '../../src/host/runner/fake.ts';
import { peopleOnly } from '../../src/host/settings.ts';
import { agentContent, cleanNote, FLAG_WORDS, fromExplained, headlineIsEstimate } from '../../src/ui/explain/content.ts';
import { clock, duration, minutes, n1, usd, usdShort, withUnit } from '../../src/ui/explain/format.ts';
import { moneyContent, workedLine } from '../../src/ui/explain/money.ts';

const agents = agentsJson as AgentsFile;
const sources = (sourcesJson as SourcesFile).sources;
const scenario = scenarioJson as Scenario;

test('money and units in plain words', () => {
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

function report(s: Scenario) {
  const candidate = fakeEvaluate(s);
  const crew = { picker: 18, driver: 3 };
  const base = { ...peopleOnly(s), fleet: { ...peopleOnly(s).fleet, ...crew } };
  return { m: fakeEcon.computeMoney({ scenario: s, agents, candidate, baseline: fakeEvaluate(base), baselineCrew: crew }), candidate, baseOph: fakeEvaluate(base).kpis.oph };
}

test('worked formulas reproduce the reported values, and are dropped when they would not', () => {
  const { m, candidate, baseOph } = report(scenario);
  const ctx = { oph: candidate.kpis.oph, baselineOph: baseOph, demand: scenario.orders.perHour, sources };
  expect(workedLine('threeYearNet', m, ctx)).toMatch(/^3 × \$[\d,]+ − \$[\d,]+ = −?\$[\d,]+$/);
  expect(workedLine('capex', m, ctx)).toContain('(24 cart robots)');
  expect(workedLine('savingsYear', m, ctx)).toMatch(/ a year$/);
  expect(workedLine('costPerOrder', m, ctx)).toContain('orders an hour × 4,160 hours');
  // A report whose numbers don't add up gets no worked line (never show sums that are wrong).
  const broken = { ...m, threeYearNet: { ...m.threeYearNet, value: (m.threeYearNet.value ?? 0) + 50_000 } };
  expect(workedLine('threeYearNet', broken, ctx)).toBeUndefined();
  // Payback with savings > 0.
  const good = { ...m, savingsYear: { ...m.savingsYear, value: 600_000 }, paybackMonths: { ...m.paybackMonths, value: (m.capex.value! / 600_000) * 12, flag: undefined } };
  expect(workedLine('paybackMonths', good, ctx)).toMatch(/÷ \(\$600,000 ÷ 12 months\) = [\d.]+ months$/);
});

test('flags are words and never numbers; every money hover lists what is left out', () => {
  const never = econFixture.econ.paybackNever as Explained;
  const c = fromExplained('Pays back in', never, sources);
  expect(c.value).toBeUndefined();
  expect(c.flag).toBe(FLAG_WORDS.never);
  expect(c.notModeled).toBe(true);
  const { m, candidate, baseOph } = report(peopleOnly(scenario));
  expect(m.capex.value).toBe(0);
  const pb = moneyContent('paybackMonths', m, { oph: candidate.kpis.oph, baselineOph: baseOph, demand: scenario.orders.perHour, sources });
  expect(pb.value).toBeUndefined();
  expect([FLAG_WORDS.never, FLAG_WORDS.doesntKeepUp]).toContain(pb.flag);
  // The Explained note's own "Not modeled" sentence is replaced by the plain-words line.
  expect(cleanNote('Demo data: toy. Not modeled: taxes, depreciation, discounting, interest, residual value, building changes.')).toBe('Demo data: toy.');
  // Sourced inputs resolve to their sources.json entry.
  const labor = fromExplained('People', econFixture.econ.laborPerYear as Explained, sources);
  const wage = labor.inputs!.find((r) => r.label === 'Picker wage')!;
  expect(wage.source?.url).toBe(sources.find((s) => s.id === 'bls-hand-laborers')!.url);
});

test('fleet hovers: based-on products and every spec number with its origin', () => {
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
