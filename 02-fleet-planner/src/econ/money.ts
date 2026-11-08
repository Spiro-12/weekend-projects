// The money model (PROTOCOL §7, Track C). One pure function: settings + two runs → a MoneyReport in which every
// number is an Explained: a plain-English formula with the real numbers in it, the inputs with where each came
// from, and what isn't modeled.
//
// Arithmetic is in integer cents (one rounding per person-year or robot-year), so every total is an exact sum of its
// parts and the monotonic properties (more robots never cost less, a higher wage never lowers the savings) hold
// exactly, not just within float noise. Values come out in USD (cents ÷ 100).
//
// `lines` has one entry per agent type in AGENT_TYPES order (robots, then pickers and drivers), so:
//   Σ lines.capex = capex,  Σ robot lines.opexYear = robotOpexYear,
//   laborYear = picker line + driver line + packers + supervisor reset time.
//
// Two readings of §7 worth knowing (both in the final report):
//  - "plus drivers' equipment": only trucks for drivers beyond the people-only crew count as upfront cost. Today's
//    operation already owns its trucks, so charging for them again would bias every option against robots, and
//    "People only ⇒ $0" would fail. Trucks are bought whether the robots are bought or rented.
//  - A candidate (or a user-set baseline) that doesn't keep up gets `doesntKeepUp` on the payback AND the 3-year net:
//    its savings come from shipping fewer orders, so neither headline number would be honest.
import {
  AGENT_TYPES,
  ROBOT_TYPES,
  type AgentSpec,
  type AgentTypeId,
  type AgentsFile,
  type ExplainFrom,
  type ExplainInput,
  type Explained,
  type MoneyInput,
  type MoneyLine,
  type MoneyReport,
  type RobotTypeId,
  type RunResult,
  type Scenario,
  type Sourced,
} from '../contracts/types.ts';
import { count, fixed, num, price, usd, usd2 } from './format.ts';

/** In every money hover (PROTOCOL §7). */
export const NOT_MODELED = 'Not modeled: taxes, depreciation, discounting, interest, residual value, building changes.';
const SIMPLE_PAYBACK = 'Simple payback: upfront cost divided by monthly savings, with no discounting.';

const toCents = (usdValue: number) => Math.round(usdValue * 100);
const noteOf = (...parts: (string | undefined | false)[]) => [...parts.filter(Boolean), NOT_MODELED].join(' ');

function ex(cents: number, unit: string, formula: string, inputs: ExplainInput[], note?: string): Explained {
  return { value: cents / 100, unit, formula, inputs, note: noteOf(note) };
}
function flagged(flag: 'never' | 'doesntKeepUp', unit: string, formula: string, inputs: ExplainInput[], note?: string): Explained {
  return { value: null, unit, formula, inputs, note: noteOf(note), flag };
}

/** An input read from agents.json, citing its source (or 'estimate' with its reasoning). */
function sourced(label: string, v: Sourced | undefined, unit: string): ExplainInput {
  if (!v) return { label, value: 0, unit, from: 'estimate', note: 'Not given in agents.json, so counted as $0.' };
  const from: ExplainFrom = v.src === 'estimate' ? 'estimate' : `source:${v.src}`;
  return v.note ? { label, value: v.value, unit: v.unit, from, note: v.note } : { label, value: v.value, unit: v.unit, from };
}

/** The weakest origin among the inputs behind a derived number: an estimate anywhere makes it an estimate. */
function weakest(inputs: ExplainInput[]): ExplainFrom {
  if (inputs.some((i) => i.from === 'estimate')) return 'estimate';
  if (inputs.some((i) => i.from === 'sim')) return 'sim';
  return inputs.find((i) => i.from.startsWith('source:'))?.from ?? 'user';
}
/** A computed total used as an input of another number (e.g. the upfront cost inside the payback). */
function derived(label: string, e: Explained, note: string): ExplainInput {
  const from = weakest(e.inputs);
  const sources = new Set(e.inputs.filter((i) => i.from.startsWith('source:')).map((i) => i.from));
  const several = from.startsWith('source:') && sources.size > 1 ? ` Built from ${sources.size} published sources.` : '';
  return { label, value: e.value ?? 0, unit: e.unit, from, note: note + several };
}
/** Unique inputs (the same wage can feed several parts). */
function uniq(inputs: ExplainInput[]): ExplainInput[] {
  const seen = new Set<string>();
  return inputs.filter((i) => (seen.has(i.label) ? false : (seen.add(i.label), true)));
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const paren = (s: string) => `(${s})`;
/** Money that may be negative, bracketed so "3 × (−$12,000)" reads right. */
const signedUsd = (v: number) => (v < 0 ? paren(usd(v)) : usd(v));

interface Part {
  cents: number;
  text: string;
}
/** "a (x) + b (y) = total", or "a = total" for one part, or the empty sentence. */
function sum(prefix: string, parts: Part[], totalCents: number, suffix: string, empty: string): string {
  if (parts.length === 0) return `${prefix} = ${empty}`;
  if (parts.length === 1) return `${prefix} = ${parts[0].text} = ${usd(totalCents / 100)}${suffix}`;
  return `${prefix} = ${parts.map((p) => `${p.text} ${paren(usd(p.cents / 100))}`).join(' + ')} = ${usd(totalCents / 100)}${suffix}`;
}

interface Ctx {
  s: Scenario;
  agents: AgentsFile;
  H: number;
  load: number;
  hoursIn: ExplainInput;
  loadIn: ExplainInput;
  spec(t: AgentTypeId): AgentSpec;
  /** ["cart robot", "cart robots"], from the agents.json label without its bracket. */
  nouns(t: AgentTypeId): [string, string];
  baselineFrom: ExplainFrom;
  baselineNote: string;
}

function context(s: Scenario, agents: AgentsFile): Ctx {
  const sh = s.shift;
  const H = sh.hoursPerShift * sh.shiftsPerDay * sh.daysPerYear;
  const byId = new Map(agents.agents.map((a) => [a.id, a]));
  const spec = (t: AgentTypeId) => {
    const a = byId.get(t);
    if (!a) throw new Error(`agents.json has no '${t}' spec`);
    return a;
  };
  const auto = s.economics.baseline === 'auto';
  return {
    s,
    agents,
    H,
    load: agents.labor.laborLoad.value,
    hoursIn: { label: 'Hours per year', value: H, unit: 'h', from: 'user', note: `${num(sh.hoursPerShift)} h a shift × ${num(sh.shiftsPerDay)} shifts a day × ${num(sh.daysPerYear)} days a year` },
    loadIn: sourced('Benefits and payroll taxes on top of the wage', agents.labor.laborLoad, 'x'),
    spec,
    nouns(t) {
      const one = spec(t).label.replace(/\s*\(.*\)\s*$/, '').toLowerCase();
      return [one, `${one}s`];
    },
    baselineFrom: auto ? 'sim' : 'user',
    baselineNote: auto ? 'The smallest people-only crew that keeps up with the same orders, found by simulation.' : 'The people-only crew you set.',
  };
}

// ───────────────────────────── labor ─────────────────────────────

/** One position staffed every operating hour of the year, in cents: H × wage × (1 + load), rounded once. */
const positionYearCents = (c: Ctx, wageUsd: number) => Math.round(c.H * toCents(wageUsd) * (1 + c.load));
const loadedWageText = (c: Ctx, wageUsd: number) => `(${price(wageUsd)}/h × ${num(1 + c.load)} with benefits)`;

interface LaborGroup {
  n: number;
  nouns: [string, string];
  wage: Sourced | undefined;
  countIn: ExplainInput;
  wageIn: ExplainInput;
}
function groupPart(c: Ctx, g: LaborGroup): Part {
  const w = g.wage?.value ?? 0;
  return { cents: g.n * positionYearCents(c, w), text: `${count(g.n, g.nouns[0], g.nouns[1])} × ${num(c.H)} h × ${loadedWageText(c, w)}` };
}

interface Labor {
  cents: number;
  picker: Part;
  driver: Part;
  packer: Part;
  resets: Part;
  formula: string;
  inputs: ExplainInput[];
}

function laborOf(c: Ctx, crew: { picker: number; driver: number }, run: RunResult, who: 'candidate' | 'baseline', hasRobots: boolean, prefix: string): Labor {
  const { s, agents } = c;
  const pickerSpec = c.spec('picker');
  const driverSpec = c.spec('driver');
  const isBase = who === 'baseline';
  const countLabel = (what: string) => (isBase ? `People-only crew: ${what}` : cap(what));
  const groups: Record<'picker' | 'driver' | 'packer', LaborGroup> = {
    picker: {
      n: crew.picker,
      nouns: c.nouns('picker'),
      wage: pickerSpec.cost.wageUsdPerHour,
      countIn: isBase
        ? { label: countLabel('pickers'), value: crew.picker, unit: 'people per shift', from: c.baselineFrom, note: c.baselineNote }
        : { label: 'Pickers', value: crew.picker, unit: 'people per shift', from: 'user' },
      wageIn: sourced('Picker wage', pickerSpec.cost.wageUsdPerHour, 'USD/h'),
    },
    driver: {
      n: crew.driver,
      nouns: c.nouns('driver'),
      wage: driverSpec.cost.wageUsdPerHour,
      countIn: isBase
        ? { label: countLabel('forklift drivers'), value: crew.driver, unit: 'people per shift', from: c.baselineFrom, note: c.baselineNote }
        : { label: 'Forklift drivers', value: crew.driver, unit: 'people per shift', from: 'user' },
      wageIn: sourced('Forklift driver wage', driverSpec.cost.wageUsdPerHour, 'USD/h'),
    },
    packer: {
      n: s.pack.stations,
      nouns: ['packer', 'packers'],
      wage: agents.labor.packer.wageUsdPerHour,
      countIn: { label: 'Packers', value: s.pack.stations, unit: 'people per shift', from: 'user', note: 'One per pack station on every shift. The same in every option, so they never change the payback.' },
      wageIn: sourced('Packer wage', agents.labor.packer.wageUsdPerHour, 'USD/h'),
    },
  };
  const picker = groupPart(c, groups.picker);
  const driver = groupPart(c, groups.driver);
  const packer = groupPart(c, groups.packer);

  // Supervisor time for manual robot resets (many brains): resets/h × H × minutes per reset ÷ 60 × supervisor wage.
  const rph = run.kpis.resetsPerHour;
  const sup = agents.labor.supervisor;
  const supWage = sup.wageUsdPerHour.value;
  const minPer = sup.minPerReset.value;
  const resets: Part = {
    cents: Math.round((rph * c.H * minPer * toCents(supWage)) / 60),
    text: `${num(rph, 2)} robot resets/h × ${num(c.H)} h × ${num(minPer)} min ÷ 60 × ${price(supWage)}/h supervisor time`,
  };

  const parts: Part[] = [];
  const inputs: ExplainInput[] = [];
  for (const k of ['picker', 'driver', 'packer'] as const) {
    if (groups[k].n <= 0) continue;
    parts.push({ picker, driver, packer }[k]);
    inputs.push(groups[k].countIn);
  }
  inputs.push(c.hoursIn);
  for (const k of ['picker', 'driver', 'packer'] as const) if (groups[k].n > 0) inputs.push(groups[k].wageIn);
  if (parts.length) inputs.push(c.loadIn);
  const resetsIn: ExplainInput = { label: isBase ? 'People-only crew: manual robot resets' : 'Manual robot resets', value: rph, unit: 'resets/h', from: 'sim', note: 'A person walks over and restarts a stuck robot (many brains).' };
  if (rph > 0) {
    parts.push(resets);
    inputs.push(resetsIn, sourced('Supervisor minutes per reset', sup.minPerReset, 'min'), sourced('Supervisor wage', sup.wageUsdPerHour, 'USD/h'));
  } else if (hasRobots) inputs.push(resetsIn); // "no manual robot resets in the run" is a simulated fact too
  const cents = parts.reduce((a, p) => a + p.cents, 0);
  let formula = sum(prefix, parts, cents, isBase ? ' a year (no robots)' : ' a year', '$0 a year (no people)');
  if (hasRobots && rph <= 0) formula += '; no manual robot resets in the run';
  if (!isBase && agents.labor.turnoverPctPerYear) {
    inputs.push(sourced('Staff turnover (context only, not in the math)', agents.labor.turnoverPctPerYear, '%/yr'));
  }
  return { cents, picker, driver, packer, resets, formula, inputs: uniq(inputs) };
}

function laborNote(c: Ctx, l: Labor): string {
  return [
    `Packers (${usd(l.packer.cents / 100)} a year) are the same in every option, so they cancel out of the savings and never change the payback.`,
    'Each count is people per shift; hours per year cover every shift.',
    l.resets.cents > 0 ? 'Supervisor reset time is costed at the plain wage.' : '',
    c.agents.labor.turnoverPctPerYear ? `Turnover (about ${num(c.agents.labor.turnoverPctPerYear.value)}% a year) is context only: hiring and training costs are not in the math.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

// ───────────────────────────── robots ─────────────────────────────

interface RobotCost {
  type: RobotTypeId;
  n: number;
  capex: Part;
  opex: Part;
  capexInputs: ExplainInput[];
  opexInputs: ExplainInput[];
}

function robotCost(c: Ctx, t: RobotTypeId, n: number, financing: 'buy' | 'raas'): RobotCost {
  const sp = c.spec(t);
  const k = sp.cost;
  const [one, many] = c.nouns(t);
  const who = count(n, one, many);
  const countIn: ExplainInput = { label: cap(many), value: n, unit: 'robots', from: 'user' };
  if (financing === 'buy') {
    const buy = k.buyUsd?.value ?? 0;
    const integ = k.integrationUsd?.value ?? 0;
    const maint = k.maintPctPerYear?.value ?? 0;
    const sw = k.softwareUsdPerYear?.value ?? 0;
    const priceIn = sourced(`${cap(one)} price`, k.buyUsd, 'USD');
    // Integer cents: maintenance is a % of the price, rounded once per robot-year.
    const perOpex = Math.round((toCents(buy) * maint) / 100) + toCents(sw);
    return {
      type: t,
      n,
      capex: { cents: n * (toCents(buy) + toCents(integ)), text: `${who} × (${price(buy)} price + ${price(integ)} setup)` },
      opex: { cents: n * perOpex, text: `${who} × (${price(buy)} × ${num(maint)}% maintenance + ${price(sw)} software)` },
      capexInputs: [countIn, priceIn, sourced(`${cap(one)} setup (deployment and integration)`, k.integrationUsd, 'USD')],
      opexInputs: [countIn, priceIn, sourced(`${cap(one)} maintenance`, k.maintPctPerYear, '%/yr'), sourced(`${cap(one)} fleet software`, k.softwareUsdPerYear, 'USD/yr')],
    };
  }
  // Rent (RaaS): setup = the rental setup fee if the spec has one, else integration; rent = monthly × 12.
  const rentalSetup = k.raasSetupUsd !== undefined;
  const setup = (rentalSetup ? k.raasSetupUsd : k.integrationUsd)?.value ?? 0;
  const monthly = k.raasUsdPerMonth?.value ?? 0;
  const setupWord = rentalSetup ? 'rental setup' : 'setup';
  return {
    type: t,
    n,
    capex: { cents: n * toCents(setup), text: `${who} × ${price(setup)} ${setupWord}` },
    opex: { cents: n * toCents(monthly) * 12, text: `${who} × ${price(monthly)} a month × 12` },
    capexInputs: [
      countIn,
      sourced(rentalSetup ? `${cap(one)} rental setup` : `${cap(one)} setup (deployment and integration)`, rentalSetup ? k.raasSetupUsd : k.integrationUsd, 'USD'),
    ],
    opexInputs: [countIn, sourced(`${cap(one)} rent`, k.raasUsdPerMonth, 'USD/month')],
  };
}

const CAPEX_NOTE = {
  buy: 'Buy: each robot’s price plus deployment and integration.',
  raas: 'Rent: only the setup per robot is paid upfront (the rental setup fee where the vendor has one, else integration); the monthly rent is in the yearly cost.',
};
const OPEX_NOTE = {
  buy: 'Buy: maintenance is a yearly share of the robot price, plus fleet software per robot.',
  raas: 'Rent: the monthly fee includes maintenance and fleet software.',
};
const TRUCK_NOTE = 'Forklift trucks count only for drivers beyond the people-only crew, which already has its trucks; they are bought either way.';

// ───────────────────────────── the report ─────────────────────────────

function keepUpWords(r: RunResult, s: Scenario): string {
  const k = r.kpis;
  return (
    `it ships ${num(k.oph, 1)} orders/h of the ${num(s.orders.perHour)} ordered and its backlog grows by ${num(k.backlogTrendPerHour, 1)} orders an hour ` +
    `(keeping up allows at most ${num((s.orders.perHour * 2) / 100, 1)}, 2% of demand)`
  );
}
function keepUpInputs(r: RunResult, s: Scenario, who: string): ExplainInput[] {
  return [
    { label: `${who}: orders shipped per hour`, value: r.kpis.oph, unit: 'orders/h', from: 'sim' },
    { label: 'Orders per hour (demand)', value: s.orders.perHour, unit: 'orders/h', from: 'user' },
    { label: `${who}: backlog growth`, value: r.kpis.backlogTrendPerHour, unit: 'orders/h', from: 'sim', note: 'Least-squares slope of open orders over the 2 h measured window.' },
  ];
}
const crewWords = (c: Ctx, crew: { picker: number; driver: number }) =>
  `${count(crew.picker, ...c.nouns('picker'))} + ${count(crew.driver, ...c.nouns('driver'))}`;

function costPerOrder(c: Ctx, annualCents: number, r: RunResult, who: 'this option' | 'people only', annualIn: ExplainInput): Explained {
  const oph = r.kpis.oph;
  const ordersIn: ExplainInput = { label: who === 'this option' ? 'Orders shipped per hour' : 'People-only crew: orders shipped per hour', value: oph, unit: 'orders/h', from: 'sim', note: 'Measured over the 2 h window; never above demand.' };
  const inputs = [annualIn, ordersIn, c.hoursIn];
  const note = 'Includes packers and every other cost in the yearly total.';
  if (!(oph > 0) || !(c.H > 0)) {
    return flagged('doesntKeepUp', 'USD/order', `no cost per order: ${who === 'this option' ? 'this option' : 'the people-only crew'} shipped no orders in the run`, inputs, note);
  }
  const v = annualCents / 100 / (oph * c.H);
  return {
    value: v,
    unit: 'USD/order',
    formula: `cost per order = ${usd(annualCents / 100)} a year ÷ (${num(oph, 1)} orders/h × ${num(c.H)} h) = ${usd2(v)}`,
    inputs,
    note: noteOf(note),
  };
}

export function computeMoney(input: MoneyInput): MoneyReport {
  const { scenario: s, agents, candidate, baseline, baselineCrew } = input;
  const c = context(s, agents);
  const fin = s.economics.financing;
  const fleet = s.fleet;
  const hasRobots = ROBOT_TYPES.some((t) => fleet[t] > 0);

  // Robots.
  const robots = ROBOT_TYPES.map((t) => robotCost(c, t, fleet[t], fin));
  // Trucks for drivers beyond the people-only crew (bought in both financing modes).
  const driverSpec = c.spec('driver');
  const truckUsd = driverSpec.cost.equipmentUsd?.value ?? 0;
  const extraDrivers = Math.max(0, fleet.driver - baselineCrew.driver);
  const truckIn = sourced('Forklift truck per driver', driverSpec.cost.equipmentUsd, 'USD');
  const extraIn: ExplainInput = { label: 'Extra forklift drivers vs the people-only crew', value: extraDrivers, unit: 'people per shift', from: c.baselineFrom, note: `${num(fleet.driver)} here vs ${num(baselineCrew.driver)} in the people-only crew. ${c.baselineNote}` };
  const [dOne, dMany] = c.nouns('driver');
  const trucks: Part = {
    cents: extraDrivers * toCents(truckUsd),
    text: `${count(extraDrivers, `extra ${dOne}`, `extra ${dMany}`)} × ${price(truckUsd)} truck`,
  };

  // Labor, this option and people only.
  const labor = laborOf(c, { picker: fleet.picker, driver: fleet.driver }, candidate, 'candidate', hasRobots, 'labor');
  const baseLabor = laborOf(c, baselineCrew, baseline, 'baseline', false, 'people-only cost');

  // Per-type lines.
  const lines: MoneyLine[] = AGENT_TYPES.map((t): MoneyLine => {
    const sp = c.spec(t);
    const [one, many] = c.nouns(t);
    const r = robots.find((x) => x.type === t);
    if (r) {
      const none = `no ${many} = $0`;
      return {
        type: t,
        label: sp.label,
        count: r.n,
        capex: ex(r.capex.cents, 'USD', r.n > 0 ? `upfront = ${r.capex.text} = ${usd(r.capex.cents / 100)}` : `upfront = ${none}`, r.capexInputs, CAPEX_NOTE[fin]),
        opexYear: ex(r.opex.cents, 'USD/yr', r.n > 0 ? `running cost = ${r.opex.text} = ${usd(r.opex.cents / 100)} a year` : `running cost = ${none} a year`, r.opexInputs, OPEX_NOTE[fin]),
      };
    }
    const n = fleet[t];
    const part = t === 'picker' ? labor.picker : labor.driver;
    const g = t === 'picker' ? sp.cost.wageUsdPerHour : driverSpec.cost.wageUsdPerHour;
    const countIn: ExplainInput = { label: cap(many), value: n, unit: 'people per shift', from: 'user' };
    const laborInputs = [countIn, c.hoursIn, sourced(`${cap(one)} wage`, g, 'USD/h'), c.loadIn];
    const opexYear = ex(part.cents, 'USD/yr', n > 0 ? `labor = ${part.text} = ${usd(part.cents / 100)} a year` : `labor = no ${many} = $0 a year`, laborInputs, 'People per shift; hours per year cover every shift.');
    const capex =
      t === 'picker'
        ? ex(0, 'USD', 'upfront = $0 (no equipment is counted for pickers)', [countIn], 'Carts and hand scanners are not modeled.')
        : ex(
            trucks.cents,
            'USD',
            extraDrivers > 0
              ? `trucks = ${trucks.text} = ${usd(trucks.cents / 100)}`
              : `trucks = $0 (${count(n, one, many)} here, ${count(baselineCrew.driver, one, many)} in the people-only crew, which already has its trucks)`,
            [countIn, extraIn, truckIn],
            TRUCK_NOTE,
          );
    return { type: t, label: sp.label, count: n, capex, opexYear };
  });

  // Upfront cost.
  const capexParts: Part[] = robots.filter((r) => r.n > 0).map((r) => r.capex);
  const capexInputs: ExplainInput[] = robots.filter((r) => r.n > 0).flatMap((r) => r.capexInputs);
  if (extraDrivers > 0) {
    capexParts.push(trucks);
    capexInputs.push(extraIn, truckIn);
  }
  const capexCents = capexParts.reduce((a, p) => a + p.cents, 0);
  const capex = ex(
    capexCents,
    'USD',
    sum('upfront', capexParts, capexCents, '', fin === 'buy' ? '$0 (no robots to buy or set up)' : '$0 (no robots to set up)'),
    capexInputs.length ? uniq(capexInputs) : [{ label: 'Robots', value: 0, unit: 'robots', from: 'user' }],
    [CAPEX_NOTE[fin], TRUCK_NOTE].join(' '),
  );

  // Robot running cost.
  const opexParts = robots.filter((r) => r.n > 0).map((r) => r.opex);
  const opexCents = opexParts.reduce((a, p) => a + p.cents, 0);
  const robotOpexYear = ex(
    opexCents,
    'USD/yr',
    sum('robot running cost', opexParts, opexCents, ' a year', '$0 a year (no robots)'),
    hasRobots ? uniq(robots.filter((r) => r.n > 0).flatMap((r) => r.opexInputs)) : [{ label: 'Robots', value: 0, unit: 'robots', from: 'user' }],
    OPEX_NOTE[fin],
  );

  // Labor and yearly totals.
  const laborYear = ex(labor.cents, 'USD/yr', labor.formula, labor.inputs, laborNote(c, labor));
  const annualCents = labor.cents + opexCents;
  const laborDer = derived('Labor', laborYear, 'Pickers, drivers, packers and supervisor time; see Labor.');
  const opexDer = derived('Robot running cost', robotOpexYear, 'See Robot running cost.');
  const annualCost = ex(
    annualCents,
    'USD/yr',
    `annual cost = ${usd(labor.cents / 100)} labor + ${usd(opexCents / 100)} robot running cost = ${usd(annualCents / 100)} a year`,
    [laborDer, opexDer],
  );
  const baseCents = baseLabor.cents; // people only: no robots, so no robot running cost
  const baselineAnnualCost = ex(
    baseCents,
    'USD/yr',
    baseLabor.formula,
    baseLabor.inputs,
    `${laborNote(c, baseLabor)} The people-only crew: ${crewWords(c, baselineCrew)}. ${c.baselineNote}`,
  );

  // Savings.
  const S = baseCents - annualCents;
  const keeps = candidate.kpis.keepsUp;
  const baseKeeps = baseline.kpis.keepsUp;
  const baseDer = derived('People-only cost per year', baselineAnnualCost, `${crewWords(c, baselineCrew)} + packers; see People-only cost.`);
  const annualDer = derived('This option’s cost per year', annualCost, 'Labor plus robot running cost; see Annual cost.');
  const savingsYear = ex(
    S,
    'USD/yr',
    `savings = ${usd(baseCents / 100)} people-only cost − ${usd(annualCents / 100)} this option = ${usd(S / 100)} a year`,
    [baseDer, annualDer],
    [
      'Both sides handle the same orders (same seed, same order stream).',
      !keeps ? 'This option does not keep up with the orders, so this is not a like-for-like saving.' : '',
      !baseKeeps ? 'The people-only crew does not keep up with the orders, so this is not a like-for-like saving.' : '',
    ]
      .filter(Boolean)
      .join(' '),
  );

  // Payback.
  const capexDer = derived('Upfront cost', capex, 'Robots and setup, plus trucks for extra drivers; see Upfront cost.');
  const savingsDer = derived('Yearly savings vs people only', savingsYear, 'People-only cost minus this option’s cost; see Yearly savings.');
  let paybackMonths: Explained;
  if (!keeps) {
    paybackMonths = flagged('doesntKeepUp', 'months', `no payback: this option can't keep up with the orders: ${keepUpWords(candidate, s)}`, keepUpInputs(candidate, s, 'This option'), SIMPLE_PAYBACK);
  } else if (!baseKeeps) {
    paybackMonths = flagged(
      'doesntKeepUp',
      'months',
      `no payback: the people-only crew (${crewWords(c, baselineCrew)}) can't keep up with the orders, so there is no fair comparison: ${keepUpWords(baseline, s)}`,
      keepUpInputs(baseline, s, 'People-only crew'),
      SIMPLE_PAYBACK,
    );
  } else if (S <= 0) {
    const why = S === 0 ? 'this option costs the same per year as people only' : `this option costs ${usd(-S / 100)} a year more than people only (${usd(annualCents / 100)} vs ${usd(baseCents / 100)})`;
    paybackMonths = flagged('never', 'months', `never pays back: ${why}, so the ${usd(capexCents / 100)} upfront is never earned back`, [capexDer, savingsDer, baseDer, annualDer], SIMPLE_PAYBACK);
  } else {
    const months = (capexCents * 12) / S;
    const years = months >= 24 ? ` (${fixed(months / 12, 1)} years)` : '';
    paybackMonths = {
      value: months,
      unit: 'months',
      formula: `payback = ${usd(capexCents / 100)} upfront ÷ (${usd(S / 100)} saved a year ÷ 12) = ${fixed(months, 1)} months${years}`,
      inputs: [capexDer, savingsDer],
      note: noteOf(SIMPLE_PAYBACK, capexCents === 0 ? 'Nothing is paid upfront, so it pays back at once.' : undefined),
    };
  }

  // 3-year net.
  const netCents = 3 * S - capexCents;
  const threeYearNet = !keeps
    ? flagged('doesntKeepUp', 'USD', `no 3-year net: this option can't keep up with the orders: ${keepUpWords(candidate, s)}`, keepUpInputs(candidate, s, 'This option'))
    : !baseKeeps
      ? flagged('doesntKeepUp', 'USD', `no 3-year net: the people-only crew (${crewWords(c, baselineCrew)}) can't keep up with the orders: ${keepUpWords(baseline, s)}`, keepUpInputs(baseline, s, 'People-only crew'))
      : ex(netCents, 'USD', `3-year net = 3 × ${signedUsd(S / 100)} savings a year − ${usd(capexCents / 100)} upfront = ${usd(netCents / 100)}`, [savingsDer, capexDer], 'Three years of savings minus the upfront cost, with no discounting.');

  return {
    financing: fin,
    hoursPerYear: c.H,
    lines,
    capex,
    robotOpexYear,
    laborYear,
    annualCost,
    baselineAnnualCost,
    savingsYear,
    paybackMonths,
    threeYearNet,
    costPerOrder: costPerOrder(c, annualCents, candidate, 'this option', annualDer),
    baselineCostPerOrder: costPerOrder(c, baseCents, baseline, 'people only', baseDer),
    baseline: { picker: baselineCrew.picker, driver: baselineCrew.driver, keepsUp: baseKeeps },
  };
}
