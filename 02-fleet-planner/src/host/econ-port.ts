// The seam between the host and the economics code (lead-owned). Phase 0 uses the toy version below; Phase 1
// integration plugs in Track C's src/econ (computeMoney + findBaseline) with the same signatures.
import type { Explained, MoneyInput, MoneyReport, RunResult, Scenario, Sourced } from '../contracts/types.ts';
import type { Runner } from './runner/types.ts';
import { peopleOnly } from './settings.ts';

export interface EconPort {
  computeMoney(input: MoneyInput): MoneyReport;
  /** Smallest all-human crew that keeps up on the same orders (or the user's crew), with its RunResult. */
  findBaseline(s: Scenario, runner: Runner): Promise<{ crew: { picker: number; driver: number }; result: RunResult }>;
}

type Input = Explained['inputs'][number];
const ex = (value: number, unit: string, formula: string, inputs: Input[] = []): Explained => ({
  value,
  unit,
  formula,
  inputs: inputs.length ? inputs : [{ label: 'Toy numbers while the real cost model is built', value, unit, from: 'estimate', note: 'Phase 0 placeholder' }],
  note: 'Demo data: placeholder economics until the real cost model lands. Not modeled: taxes, depreciation, discounting, interest, residual value, building changes.',
});
/** An input taken from agents.json, citing its source (or 'estimate' with its note). */
const sourced = (label: string, v: Sourced | undefined): Input => ({
  label,
  value: v?.value ?? 0,
  unit: v?.unit ?? '',
  from: !v ? 'estimate' : v.src === 'estimate' ? 'estimate' : (`source:${v.src}` as const),
  note: v?.note,
});

/** Toy economics: the right shape, rough numbers, clearly a placeholder ("demo data"). */
export const fakeEcon: EconPort = {
  computeMoney({ scenario: s, agents, candidate, baseline, baselineCrew }: MoneyInput): MoneyReport {
    const H = s.shift.hoursPerShift * s.shift.shiftsPerDay * s.shift.daysPerYear;
    const spec = (id: string) => agents.agents.find((a) => a.id === id)!;
    const load = 1 + agents.labor.laborLoad.value;
    const wage = (id: string) => (spec(id).cost.wageUsdPerHour?.value ?? 0) * load;
    const raas = s.economics.financing === 'raas';
    const lines = (['amr', 'forklift', 'humanoid'] as const).map((t) => {
      const c = spec(t).cost;
      const n = s.fleet[t];
      // PROTOCOL §7: rent capex = raasSetupUsd when the spec has one, else integrationUsd.
      const setup = c.raasSetupUsd ?? c.integrationUsd;
      const capex = n * (raas ? (setup?.value ?? 0) : (c.buyUsd?.value ?? 0) + (c.integrationUsd?.value ?? 0));
      const opex = n * (raas ? (c.raasUsdPerMonth?.value ?? 0) * 12 : (c.buyUsd?.value ?? 0) * ((c.maintPctPerYear?.value ?? 0) / 100) + (c.softwareUsdPerYear?.value ?? 0));
      const count: Input = { label: `${spec(t).label}s`, value: n, unit: 'robots', from: 'user' };
      const capIn = raas ? [count, sourced('Setup per robot', setup)] : [count, sourced('Price per robot', c.buyUsd), sourced('Setup per robot', c.integrationUsd)];
      const opIn = raas ? [count, sourced('Rent per robot per month', c.raasUsdPerMonth)] : [count, sourced('Maintenance per year', c.maintPctPerYear), sourced('Software per robot per year', c.softwareUsdPerYear)];
      return { type: t, label: spec(t).label, count: n, capex: ex(capex, 'USD', 'count × unit cost', capIn), opexYear: ex(opex, 'USD/yr', 'count × yearly cost', opIn) };
    });
    const capex = lines.reduce((a, l) => a + (l.capex.value ?? 0), 0);
    const opex = lines.reduce((a, l) => a + (l.opexYear.value ?? 0), 0);
    const labor = (s.fleet.picker * wage('picker') + s.fleet.driver * wage('driver')) * H;
    const baseLabor = (baselineCrew.picker * wage('picker') + baselineCrew.driver * wage('driver')) * H;
    const annual = labor + opex;
    const savings = baseLabor - annual;
    const keeps = candidate.kpis.keepsUp;
    const pbIn: Input[] = [
      { label: 'Upfront cost', value: capex, unit: 'USD', from: 'estimate', note: 'Sum of robot prices and setup (demo data)' },
      { label: 'Yearly savings vs people only', value: savings, unit: 'USD/yr', from: 'sim' },
      sourced('Picker wage', spec('picker').cost.wageUsdPerHour),
      sourced('Benefits load', agents.labor.laborLoad),
    ];
    const payback: Explained = !keeps
      ? { ...ex(0, 'months', 'payback = upfront ÷ (savings ÷ 12)', pbIn), value: null, flag: 'doesntKeepUp' }
      : savings <= 0
        ? { ...ex(0, 'months', 'payback = upfront ÷ (savings ÷ 12)', pbIn), value: null, flag: 'never' }
        : ex(capex / (savings / 12), 'months', 'payback = upfront ÷ (savings ÷ 12)', pbIn);
    const oph = Math.max(1e-9, candidate.kpis.oph);
    return {
      financing: s.economics.financing,
      hoursPerYear: H,
      lines,
      capex: ex(capex, 'USD', 'Σ robots × (price + setup)'),
      robotOpexYear: ex(opex, 'USD/yr', 'Σ robots × yearly cost'),
      laborYear: ex(labor, 'USD/yr', 'people × hours × loaded wage', [
        { label: 'Pickers + drivers', value: s.fleet.picker + s.fleet.driver, unit: 'people/shift', from: 'user' },
        { label: 'Hours per year', value: H, unit: 'h', from: 'user' },
        sourced('Picker wage', spec('picker').cost.wageUsdPerHour),
        sourced('Driver wage', spec('driver').cost.wageUsdPerHour),
        sourced('Benefits load', agents.labor.laborLoad),
      ]),
      annualCost: ex(annual, 'USD/yr', 'labor + robot running cost'),
      baselineAnnualCost: ex(baseLabor, 'USD/yr', 'people-only crew × hours × loaded wage'),
      savingsYear: ex(savings, 'USD/yr', 'people-only cost − this option'),
      paybackMonths: payback,
      threeYearNet: ex(3 * savings - capex, 'USD', '3 × yearly savings − upfront'),
      costPerOrder: ex(annual / (oph * H), 'USD/order', 'annual cost ÷ orders per year'),
      baselineCostPerOrder: ex(baseLabor / (Math.max(1e-9, baseline.kpis.oph) * H), 'USD/order', 'annual cost ÷ orders per year'),
      baseline: { ...baselineCrew, keepsUp: baseline.kpis.keepsUp },
    };
  },
  async findBaseline(s, runner) {
    if (s.economics.baseline !== 'auto') {
      const crew = s.economics.baseline;
      const result = await runner.evaluate({ ...peopleOnly(s), fleet: { ...peopleOnly(s).fleet, picker: crew.picker, driver: crew.driver } });
      return { crew, result };
    }
    for (let picker = 4; picker <= 200; picker += 2) {
      const driver = Math.max(1, Math.ceil(picker / 6));
      const trial = { ...peopleOnly(s), fleet: { ...peopleOnly(s).fleet, picker, driver } };
      const result = await runner.evaluate(trial);
      if (result.kpis.keepsUp) return { crew: { picker, driver }, result };
    }
    const crew = { picker: 200, driver: 34 };
    return { crew, result: await runner.evaluate({ ...peopleOnly(s), fleet: { ...peopleOnly(s).fleet, ...crew } }) };
  },
};

