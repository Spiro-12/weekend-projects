// The money model against PROTOCOL §7: exact hand-checked numbers, an independent float re-implementation of every
// formula, the sanity properties from PLAN §9 (people only ⇒ $0 robots, flags, monotonic), and the trust layer
// (every input has an origin, every source exists, the formula strings carry the real numbers).
import { describe, expect, it } from 'vitest';
import { AGENT_TYPES, ROBOT_TYPES, type AgentsFile, type MoneyInput, type MoneyReport, type RobotTypeId, type RunResult, type Scenario } from '../../../src/contracts/types.ts';
import { computeMoney, NOT_MODELED } from '../../../src/econ/money.ts';
import { fixed, usd, usd2 } from '../../../src/econ/format.ts';
import { agents, allExplained, defaultScenario as base, editAgents, mkRun, sourceIds, withFleet } from './helpers.ts';

const H = 8 * 2 * 260; // default shift: 4,160 h a year
const crew = { picker: 18, driver: 3 };
const baselineRun = mkRun({}, { amr: 0, forklift: 0, humanoid: 0, ...crew });

function money(s: Scenario, opts: { cand?: RunResult; baseRun?: RunResult; crew?: { picker: number; driver: number }; agents?: AgentsFile } = {}): MoneyReport {
  const input: MoneyInput = { scenario: s, agents: opts.agents ?? agents, candidate: opts.cand ?? mkRun({}, s.fleet), baseline: opts.baseRun ?? baselineRun, baselineCrew: opts.crew ?? crew };
  return computeMoney(input);
}

/** PROTOCOL §7 written out again in plain floats, independently of src/econ (for cross-checking). */
function reference(s: Scenario, a: AgentsFile, cand: RunResult, b: RunResult, c: { picker: number; driver: number }) {
  const h = s.shift.hoursPerShift * s.shift.shiftsPerDay * s.shift.daysPerYear;
  const spec = (id: string) => a.agents.find((x) => x.id === id)!;
  const load = 1 + a.labor.laborLoad.value;
  const wage = (id: string) => spec(id).cost.wageUsdPerHour!.value;
  const packers = s.pack.stations * h * a.labor.packer.wageUsdPerHour.value * load;
  const resets = (rph: number) => (rph * h * a.labor.supervisor.minPerReset.value * a.labor.supervisor.wageUsdPerHour.value) / 60;
  const labor = (p: number, d: number, rph: number) => p * h * wage('picker') * load + d * h * wage('driver') * load + packers + resets(rph);
  let capex = Math.max(0, s.fleet.driver - c.driver) * spec('driver').cost.equipmentUsd!.value;
  let opex = 0;
  for (const t of ROBOT_TYPES) {
    const k = spec(t).cost;
    const n = s.fleet[t];
    if (s.economics.financing === 'buy') {
      capex += n * (k.buyUsd!.value + (k.integrationUsd?.value ?? 0));
      opex += n * (k.buyUsd!.value * ((k.maintPctPerYear?.value ?? 0) / 100) + (k.softwareUsdPerYear?.value ?? 0));
    } else {
      capex += n * (k.raasSetupUsd ?? k.integrationUsd)!.value;
      opex += n * k.raasUsdPerMonth!.value * 12;
    }
  }
  const laborC = labor(s.fleet.picker, s.fleet.driver, cand.kpis.resetsPerHour);
  const annual = laborC + opex;
  const baseAnnual = labor(c.picker, c.driver, b.kpis.resetsPerHour);
  const S = baseAnnual - annual;
  return { H: h, capex, opex, labor: laborC, annual, baseAnnual, S, payback: capex / (S / 12), net: 3 * S - capex, cpo: annual / (cand.kpis.oph * h), baseCpo: baseAnnual / (b.kpis.oph * h) };
}
const near = (a: number | null, b: number, tol = 1) => {
  expect(a).not.toBeNull();
  expect(Math.abs(a! - b), `${a} vs ${b}`).toBeLessThan(tol);
};

describe('money: the default fleet, worked by hand', () => {
  const m = money(base);
  it('upfront cost = Σ robots × (price + setup)', () => {
    // 24 × (35,000 + 10,500) + 4 × (150,000 + 45,000) + 2 × (200,000 + 20,000)
    expect(m.capex.value).toBe(1_092_000 + 780_000 + 440_000);
    expect(m.lines.find((l) => l.type === 'amr')!.capex.value).toBe(1_092_000);
    expect(m.lines.find((l) => l.type === 'amr')!.capex.formula).toBe('upfront = 24 cart robots × ($35,000 price + $10,500 setup) = $1,092,000');
  });
  it('robot running cost = Σ robots × (price × maintenance % + software)', () => {
    // 24 × (4,200 + 4,800) + 4 × (18,000 + 4,800) + 2 × (36,000 + 36,000)
    expect(m.robotOpexYear.value).toBe(216_000 + 91_200 + 144_000);
    expect(m.lines.find((l) => l.type === 'humanoid')!.opexYear.formula).toBe(
      'running cost = 2 humanoid robots × ($200,000 × 18% maintenance + $36,000 software) = $144,000 a year',
    );
  });
  it('labor = people × H × wage × (1 + load), packers included; exact to the cent', () => {
    // pickers 14 × 4,160 × 17.95 × 1.46 = 1,526,295.68; drivers 2 × 4,160 × 22.32 × 1.46 = 271,125.50 (cents rounded
    // per person-year); packers 6 × 4,160 × 17.95 × 1.46 = 654,126.72
    expect(m.laborYear.value).toBe(2_451_547.9);
    expect(m.laborYear.formula).toBe(
      'labor = 14 pickers × 4,160 h × ($17.95/h × 1.46 with benefits) ($1,526,296) + 2 forklift drivers × 4,160 h × ($22.32/h × 1.46 with benefits) ($271,126) + 6 packers × 4,160 h × ($17.95/h × 1.46 with benefits) ($654,127) = $2,451,548 a year; no manual robot resets in the run',
    );
    expect(m.baselineAnnualCost.value).toBe(3_023_195.13);
  });
  it('savings, payback, 3-year net and cost per order follow, with the numbers in the formulas', () => {
    expect(m.annualCost.value).toBe(2_902_747.9);
    expect(m.savingsYear.value).toBe(120_447.23);
    expect(m.paybackMonths.value).toBeCloseTo((2_312_000 * 12) / 120_447.23, 9);
    expect(m.paybackMonths.formula).toBe('payback = $2,312,000 upfront ÷ ($120,447 saved a year ÷ 12) = 230.3 months (19.2 years)');
    expect(m.threeYearNet.value).toBe(-1_950_658.31);
    expect(m.threeYearNet.formula).toBe('3-year net = 3 × $120,447 savings a year − $2,312,000 upfront = −$1,950,658');
    expect(m.costPerOrder.formula).toBe('cost per order = $2,902,748 a year ÷ (600 orders/h × 4,160 h) = $1.16');
    expect(m.hoursPerYear).toBe(H);
    expect(m.baseline).toEqual({ picker: 18, driver: 3, keepsUp: true });
  });
  it('a cart-robot-only fleet: the payback string reads like the brief’s example', () => {
    const s = withFleet(base, { forklift: 0, humanoid: 0, driver: 3 });
    const r = money(s, { crew: { picker: 24, driver: 3 } });
    // savings = 10 pickers × 109,021.12 − 24 × 9,000 = 874,211.20; payback = 1,092,000 ÷ (874,211.20 ÷ 12)
    expect(r.savingsYear.value).toBe(874_211.2);
    expect(r.paybackMonths.formula).toBe('payback = $1,092,000 upfront ÷ ($874,211 saved a year ÷ 12) = 15.0 months');
  });
});

describe('money: matches an independent float re-implementation of PROTOCOL §7', () => {
  const fleets = [base.fleet, { ...base.fleet, amr: 60, humanoid: 0 }, { ...base.fleet, amr: 0, forklift: 0, humanoid: 0 }, { amr: 10, forklift: 1, humanoid: 5, picker: 6, driver: 5 }];
  for (const fin of ['buy', 'raas'] as const) {
    for (const [i, fleet] of fleets.entries()) {
      it(`${fin} fleet #${i}`, () => {
        const s = withFleet(base, fleet, fin);
        const cand = mkRun({ resetsPerHour: 2.5, oph: 590 }, fleet);
        const b = mkRun({ oph: 600 }, { amr: 0, forklift: 0, humanoid: 0, ...crew });
        const m = money(s, { cand, baseRun: b });
        const r = reference(s, agents, cand, b, crew);
        near(m.capex.value, r.capex);
        near(m.robotOpexYear.value, r.opex);
        near(m.laborYear.value, r.labor);
        near(m.annualCost.value, r.annual);
        near(m.baselineAnnualCost.value, r.baseAnnual);
        near(m.savingsYear.value, r.S);
        if (r.S > 0) near(m.paybackMonths.value, r.payback, 0.001);
        near(m.threeYearNet.value, r.net, 3);
        near(m.costPerOrder.value, r.cpo, 1e-6);
        near(m.baselineCostPerOrder.value, r.baseCpo, 1e-6);
      });
    }
  }
});

describe('money: the parts add up exactly', () => {
  for (const fin of ['buy', 'raas'] as const) {
    it(`${fin}: lines sum to the totals; annual, savings, 3-year net and cost per order are exact`, () => {
      const s = withFleet(base, { driver: 5 }, fin);
      const cand = mkRun({ resetsPerHour: 1.25, oph: 597.5 }, s.fleet);
      const m = money(s, { cand });
      const c = (v: number | null) => Math.round(v! * 100); // compare in cents
      const lines = (k: 'capex' | 'opexYear', types: readonly string[]) => m.lines.filter((l) => types.includes(l.type)).reduce((a, l) => a + c(l[k].value), 0);
      expect(m.lines.map((l) => l.type)).toEqual(AGENT_TYPES);
      expect(lines('capex', AGENT_TYPES)).toBe(c(m.capex.value));
      expect(lines('opexYear', ROBOT_TYPES)).toBe(c(m.robotOpexYear.value));
      // labor = picker line + driver line + packers + supervisor reset time (1.25 × 4,160 × 10 ÷ 60 × $30 = $26,000)
      const packers = 6 * Math.round(H * 1795 * 1.46);
      expect(lines('opexYear', ['picker', 'driver']) + packers + 2_600_000).toBe(c(m.laborYear.value));
      expect(c(m.annualCost.value)).toBe(c(m.laborYear.value) + c(m.robotOpexYear.value));
      expect(c(m.savingsYear.value)).toBe(c(m.baselineAnnualCost.value) - c(m.annualCost.value));
      expect(c(m.threeYearNet.value)).toBe(3 * c(m.savingsYear.value) - c(m.capex.value));
      expect(m.costPerOrder.value).toBeCloseTo(m.annualCost.value! / (597.5 * H), 12);
    });
  }
  it('supervisor reset time is in the labor formula with its numbers', () => {
    const m = money(base, { cand: mkRun({ resetsPerHour: 3 }) });
    // 3 × 4,160 × 10 ÷ 60 × 30 = 62,400
    expect(m.laborYear.formula).toContain('3 robot resets/h × 4,160 h × 10 min ÷ 60 × $30/h supervisor time ($62,400)');
    expect(m.laborYear.inputs.find((i) => i.label === 'Manual robot resets')).toMatchObject({ value: 3, from: 'sim' });
  });
});

describe('People only ⇒ $0 robot cost', () => {
  const people = withFleet(base, { amr: 0, forklift: 0, humanoid: 0 });
  for (const fin of ['buy', 'raas'] as const) {
    it(`${fin}: robot capex and robot opex exactly 0`, () => {
      const m = money({ ...people, economics: { ...people.economics, financing: fin } });
      for (const l of m.lines.filter((x) => (ROBOT_TYPES as readonly string[]).includes(x.type))) {
        expect(l.capex.value).toBe(0);
        expect(l.opexYear.value).toBe(0);
      }
      expect(m.robotOpexYear.value).toBe(0);
      expect(m.capex.value).toBe(0); // 2 drivers ≤ the people-only crew's 3: no trucks to buy
      expect(m.capex.formula).toMatch(/^upfront = \$0 \(no robots/);
    });
  }
  it('the people-only crew itself: savings exactly 0 ⇒ "never"', () => {
    const m = money(withFleet(people, crew), { cand: baselineRun });
    expect(m.savingsYear.value).toBe(0);
    expect(m.paybackMonths).toMatchObject({ value: null, flag: 'never' });
    expect(m.paybackMonths.formula).toContain('this option costs the same per year as people only');
    expect(m.threeYearNet.value).toBe(0);
  });
  it('a smaller people-only crew that can’t keep up ⇒ "doesntKeepUp"', () => {
    const m = money(people, { cand: mkRun({ keepsUp: false, oph: 470, backlogTrendPerHour: 130 }, people.fleet) });
    expect(m.paybackMonths).toMatchObject({ value: null, flag: 'doesntKeepUp' });
  });
  it('a bigger people-only crew ⇒ "never"', () => {
    const m = money(withFleet(people, { picker: 20 }));
    expect(m.savingsYear.value!).toBeLessThan(0);
    expect(m.paybackMonths).toMatchObject({ value: null, flag: 'never' });
  });
});

describe('Rent (RaaS)', () => {
  const m = money(withFleet(base, {}, 'raas'));
  it('capex = setup only: the rental setup fee where the spec has one, else integration', () => {
    // 24 × 10,500 (no rental setup for AMRs) + 4 × 45,000 + 2 × 25,000 (humanoid rental setup)
    expect(m.capex.value).toBe(252_000 + 180_000 + 50_000);
    expect(m.lines.find((l) => l.type === 'humanoid')!.capex.formula).toBe('upfront = 2 humanoid robots × $25,000 rental setup = $50,000');
  });
  it('opex = 12 × monthly × count, per type and in total', () => {
    for (const t of ROBOT_TYPES) {
      const line = m.lines.find((l) => l.type === t)!;
      expect(line.opexYear.value).toBe(12 * agents.agents.find((a) => a.id === t)!.cost.raasUsdPerMonth!.value * base.fleet[t]);
    }
    expect(m.robotOpexYear.value).toBe(12 * (24 * 1500 + 4 * 5000 + 2 * 8500));
    expect(m.lines.find((l) => l.type === 'amr')!.opexYear.formula).toBe('running cost = 24 cart robots × $1,500 a month × 12 = $432,000 a year');
  });
  it('buy and rent use the same labor and the same baseline', () => {
    const b = money(base);
    expect(m.laborYear.value).toBe(b.laborYear.value);
    expect(m.baselineAnnualCost.value).toBe(b.baselineAnnualCost.value);
    expect(m.financing).toBe('raas');
  });
});

describe('flags', () => {
  it('S < 0 ⇒ "never", value null, the formula says why', () => {
    const m = money(withFleet(base, {}, 'raas'));
    expect(m.savingsYear.value!).toBeLessThan(0);
    expect(m.paybackMonths).toMatchObject({ value: null, flag: 'never' });
    expect(m.paybackMonths.formula).toMatch(/^never pays back: this option costs \$[\d,]+ a year more than people only/);
    expect(m.threeYearNet.value!).toBeLessThan(0); // still a number
  });
  it('a candidate that doesn’t keep up ⇒ "doesntKeepUp" on payback and 3-year net, and no payback number', () => {
    const cand = mkRun({ keepsUp: false, oph: 540, backlogTrendPerHour: 61 }, base.fleet);
    const m = money(withFleet(base, { amr: 60, picker: 6 }), { cand });
    expect(m.savingsYear.value!).toBeGreaterThan(0); // fewer people looks cheap…
    expect(m.paybackMonths).toMatchObject({ value: null, flag: 'doesntKeepUp' }); // …but it isn't a fair comparison
    expect(m.threeYearNet).toMatchObject({ value: null, flag: 'doesntKeepUp' });
    expect(m.paybackMonths.formula).not.toMatch(/months/);
    expect(m.paybackMonths.formula).toBe(
      "no payback: this option can't keep up with the orders: it ships 540 orders/h of the 600 ordered and its backlog grows by 61 orders an hour (keeping up allows at most 12, 2% of demand)",
    );
    expect(m.savingsYear.note).toContain('not a like-for-like saving');
  });
  it('a user-set baseline that doesn’t keep up is flagged too', () => {
    const s: Scenario = { ...base, economics: { financing: 'buy', baseline: { picker: 8, driver: 1 } } };
    const m = money(s, { crew: { picker: 8, driver: 1 }, baseRun: mkRun({ keepsUp: false, oph: 300, backlogTrendPerHour: 300 }) });
    expect(m.paybackMonths).toMatchObject({ value: null, flag: 'doesntKeepUp' });
    expect(m.paybackMonths.formula).toContain('the people-only crew (8 pickers + 1 forklift driver) can\'t keep up');
    expect(m.threeYearNet.flag).toBe('doesntKeepUp');
    expect(m.baseline.keepsUp).toBe(false);
    expect(m.baselineAnnualCost.inputs.find((i) => i.label === 'People-only crew: pickers')!.from).toBe('user');
  });
  it('nothing shipped ⇒ no cost per order (flagged, never Infinity)', () => {
    const m = money(base, { cand: mkRun({ oph: 0, keepsUp: false }) });
    expect(m.costPerOrder).toMatchObject({ value: null, flag: 'doesntKeepUp' });
  });
  it('nothing to pay upfront and positive savings ⇒ pays back at once (0 months)', () => {
    const m = money(withFleet(base, { amr: 0, forklift: 0, humanoid: 0, picker: 18, driver: 3 }), { crew: { picker: 20, driver: 3 } });
    expect(m.paybackMonths.value).toBe(0);
    expect(m.paybackMonths.note).toContain('pays back at once');
  });
});

describe('trucks for drivers', () => {
  it('only drivers beyond the people-only crew need a truck, bought or rented', () => {
    for (const fin of ['buy', 'raas'] as const) {
      const extra = money(withFleet(base, { driver: 5 }, fin));
      const same = money(withFleet(base, { driver: 3 }, fin));
      expect(extra.capex.value! - same.capex.value!).toBe(2 * 35_000);
      expect(extra.lines.find((l) => l.type === 'driver')!.capex.formula).toBe('trucks = 2 extra forklift drivers × $35,000 truck = $70,000');
      expect(same.lines.find((l) => l.type === 'driver')!.capex.value).toBe(0);
    }
  });
});

describe('packers never change the payback', () => {
  it('more or fewer pack stations change labor, not savings or payback', () => {
    const ref = money(withFleet(base, { amr: 30, humanoid: 0, picker: 10 }));
    for (const stations of [1, 4, 9, 12]) {
      const s = withFleet({ ...base, pack: { ...base.pack, stations } }, { amr: 30, humanoid: 0, picker: 10 });
      const m = money(s);
      expect(m.savingsYear.value).toBe(ref.savingsYear.value);
      expect(m.paybackMonths.value).toBe(ref.paybackMonths.value);
      expect(m.laborYear.value).not.toBe(ref.laborYear.value);
      expect(m.laborYear.formula).toContain(`${stations} packer`);
      expect(m.laborYear.note).toContain('never change the payback');
    }
  });
});

describe('monotonic', () => {
  it('more robots never lowers robot capex or robot opex (every type, buy and rent)', () => {
    for (const fin of ['buy', 'raas'] as const) {
      for (const t of ROBOT_TYPES) {
        let prev = money(withFleet(base, { [t]: 0 }, fin));
        for (let n = 1; n <= 60; n++) {
          const m = money(withFleet(base, { [t]: n }, fin));
          const line = (x: MoneyReport) => x.lines.find((l) => l.type === t)!;
          expect(m.capex.value!).toBeGreaterThanOrEqual(prev.capex.value!);
          expect(m.robotOpexYear.value!).toBeGreaterThanOrEqual(prev.robotOpexYear.value!);
          expect(line(m).capex.value!).toBeGreaterThan(line(prev).capex.value!);
          expect(line(m).opexYear.value!).toBeGreaterThan(line(prev).opexYear.value!);
          prev = m;
        }
      }
    }
  });

  // Robot options with no more people than the people-only crew (robots replace people; with MORE people than the
  // baseline a higher wage would rightly cost the option more).
  const robotOptions: Scenario[] = [];
  for (const amr of [0, 8, 24, 48]) for (const humanoid of [0, 2]) for (const forklift of [0, 4]) for (const picker of [6, 12, 18]) for (const driver of [0, 2, 3]) {
    if (amr + humanoid + forklift > 0) robotOptions.push(withFleet(base, { amr, humanoid, forklift, picker, driver }));
  }

  it('a higher wage never lowers the savings of a robot option (picker, driver, packer wage and the benefits load)', () => {
    const edits: [string, (a: AgentsFile, v: number) => void, number[]][] = [
      ['picker wage', (a, v) => (a.agents.find((x) => x.id === 'picker')!.cost.wageUsdPerHour!.value = v), [10, 15, 17.95, 17.96, 22.5, 30, 45]],
      ['driver wage', (a, v) => (a.agents.find((x) => x.id === 'driver')!.cost.wageUsdPerHour!.value = v), [12, 18, 22.32, 22.33, 30, 50]],
      ['packer wage', (a, v) => (a.labor.packer.wageUsdPerHour.value = v), [10, 17.95, 30]],
      ['benefits load', (a, v) => (a.labor.laborLoad.value = v), [0, 0.2, 0.46, 0.461, 0.8]],
    ];
    for (const fin of ['buy', 'raas'] as const) {
      for (const option of robotOptions) {
        const s = { ...option, economics: { ...option.economics, financing: fin } };
        for (const [what, edit, values] of edits) {
          let prev = -Infinity;
          for (const v of values) {
            const m = money(s, { agents: editAgents((a) => edit(a, v)) });
            expect(m.savingsYear.value!, `${what} ${v}, ${fin}, ${JSON.stringify(s.fleet)}`).toBeGreaterThanOrEqual(prev);
            prev = m.savingsYear.value!;
          }
        }
      }
    }
  });

  it('a higher robot price never raises the savings, and never shortens the payback', () => {
    const prices: [string, RobotTypeId, (a: AgentsFile, t: RobotTypeId, v: number) => void, number[]][] = [];
    for (const t of ROBOT_TYPES) {
      prices.push(['buy price', t, (a, tt, v) => (a.agents.find((x) => x.id === tt)!.cost.buyUsd!.value = v), [10_000, 35_000, 35_001, 80_000, 250_000]]);
      prices.push(['monthly rent', t, (a, tt, v) => (a.agents.find((x) => x.id === tt)!.cost.raasUsdPerMonth!.value = v), [500, 1500, 1501, 5000, 9000]]);
      prices.push(['integration', t, (a, tt, v) => (a.agents.find((x) => x.id === tt)!.cost.integrationUsd!.value = v), [0, 10_500, 40_000]]);
      prices.push(['software', t, (a, tt, v) => (a.agents.find((x) => x.id === tt)!.cost.softwareUsdPerYear!.value = v), [0, 4800, 9600]]);
      prices.push(['maintenance', t, (a, tt, v) => (a.agents.find((x) => x.id === tt)!.cost.maintPctPerYear!.value = v), [0, 12, 18]]);
    }
    for (const fin of ['buy', 'raas'] as const) {
      for (const option of robotOptions.filter((_, i) => i % 3 === 0)) {
        const s = { ...option, economics: { ...option.economics, financing: fin } };
        for (const [what, t, edit, values] of prices) {
          let prevS = Infinity;
          let prevCapex = -Infinity;
          for (const v of values) {
            const m = money(s, { agents: editAgents((a) => edit(a, t, v)) });
            expect(m.savingsYear.value!, `${t} ${what} ${v}, ${fin}`).toBeLessThanOrEqual(prevS);
            expect(m.capex.value!, `${t} ${what} ${v}, ${fin}`).toBeGreaterThanOrEqual(prevCapex);
            prevS = m.savingsYear.value!;
            prevCapex = m.capex.value!;
          }
        }
      }
    }
  });
});

describe('trust: every Explained explains itself', () => {
  const reports: [string, MoneyReport][] = [];
  for (const fin of ['buy', 'raas'] as const) {
    reports.push([`default ${fin}`, money(withFleet(base, {}, fin))]);
    reports.push([`people only ${fin}`, money(withFleet(base, { amr: 0, forklift: 0, humanoid: 0 }, fin))]);
    reports.push([`resets + extra drivers ${fin}`, money(withFleet(base, { driver: 6 }, fin), { cand: mkRun({ resetsPerHour: 4.2 }) })]);
    reports.push([`doesn't keep up ${fin}`, money(withFleet(base, {}, fin), { cand: mkRun({ keepsUp: false, oph: 410, backlogTrendPerHour: 190 }) })]);
    reports.push([`user baseline ${fin}`, money({ ...withFleet(base, {}, fin), economics: { financing: fin, baseline: { picker: 30, driver: 4 } } }, { crew: { picker: 30, driver: 4 } })]);
  }

  it.each(reports)('%s: every input has a known origin; every source exists in sources.json', (_, m) => {
    for (const [name, e] of allExplained(m)) {
      expect(e.inputs.length, name).toBeGreaterThan(0);
      for (const i of e.inputs) {
        expect(i.from, `${name}: ${i.label}`).toMatch(/^(source:.+|estimate|sim|user)$/);
        if (i.from.startsWith('source:')) expect(sourceIds.has(i.from.slice(7)), `${name}: ${i.from}`).toBe(true);
        if (i.from === 'estimate') expect(i.note, `${name}: ${i.label} is an estimate without its reasoning`).toBeTruthy();
        expect(Number.isFinite(i.value), `${name}: ${i.label}`).toBe(true);
        expect(i.label.length).toBeGreaterThan(2);
        expect(i.unit.length).toBeGreaterThan(0);
      }
    }
  });
  it.each(reports)('%s: value is null exactly when flagged; never NaN or Infinity; survives JSON', (_, m) => {
    for (const [name, e] of allExplained(m)) {
      expect(e.value === null, name).toBe(e.flag !== undefined);
      if (e.value !== null) expect(Number.isFinite(e.value), name).toBe(true);
    }
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
  it.each(reports)('%s: every money hover lists what is not modeled', (_, m) => {
    for (const [name, e] of allExplained(m)) expect(e.note, name).toContain(NOT_MODELED);
  });
  it.each(reports)('%s: every formula carries its own result, written out', (_, m) => {
    for (const [name, e] of allExplained(m)) {
      expect(e.formula, name).toMatch(/\d/);
      if (e.value === null) continue;
      const shown = e.unit === 'months' ? `${fixed(e.value, 1)} months` : e.unit === 'USD/order' ? usd2(e.value) : usd(e.value);
      expect(e.formula, name).toContain(`= ${shown}`);
    }
  });
  it('the agents.json source of each price is the one cited', () => {
    const m = money(base);
    const humanoidPrice = m.capex.inputs.find((i) => i.label === 'Humanoid robot price')!;
    expect(humanoidPrice.from).toBe('source:dynamo-agility');
    const amrPrice = m.capex.inputs.find((i) => i.label === 'Cart robot price')!;
    expect(amrPrice).toMatchObject({ from: 'estimate', value: 35_000 });
    expect(amrPrice.note).toMatch(/Agility/);
    expect(m.laborYear.inputs.find((i) => i.label === 'Picker wage')!.from).toBe('source:bls-hand-laborers');
    expect(m.laborYear.inputs.find((i) => i.label.startsWith('Benefits'))!.from).toBe('source:bls-ecec');
    expect(m.baselineAnnualCost.inputs.find((i) => i.label === 'People-only crew: pickers')).toMatchObject({ value: 18, from: 'sim' });
  });
  it('a cost missing from agents.json counts as $0 and says so', () => {
    const a = editAgents((x) => delete x.agents.find((y) => y.id === 'amr')!.cost.softwareUsdPerYear);
    const m = money(base, { agents: a });
    const sw = m.robotOpexYear.inputs.find((i) => i.label === 'Cart robot fleet software')!;
    expect(sw).toMatchObject({ value: 0, from: 'estimate' });
    expect(sw.note).toMatch(/counted as \$0/);
  });
});
