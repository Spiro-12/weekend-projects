// The money model (PROTOCOL §7, Track C). One pure function: settings + two runs → a MoneyReport in which every
// number is an Explained: a plain-English formula with the real numbers in it, the inputs with where each came
// from, and what isn't modeled.
//
// Rounding: each part (one group of people, one robot type, the trucks) is computed exactly in integer cents and
// rounded once to whole dollars, which is what its formula shows. Every total is the sum of those whole-dollar parts,
// and every difference is taken between whole-dollar totals, so the arithmetic in every formula string adds up to
// the dollar and each value is exactly the number shown. The monotonic properties hold for any change of at least one
// cent per hour or one dollar: more robots never cost less; a higher robot price never raises the savings; a higher
// wage for a role never lowers a robot option's savings when the people-only crew has at least as many of that role
// (an option with MORE pickers than the people-only crew rightly loses savings when pickers cost more).
//
// `lines` has one entry per agent type in AGENT_TYPES order (robots, then pickers and drivers), so:
//   Σ lines.capex = capex,  Σ robot lines.opexYear = robotOpexYear,
//   laborYear = picker line + driver line + packers + supervisor reset time.
//
// Readings of §7 agreed with the lead:
//  - "plus drivers' equipment": only trucks for drivers beyond the people-only crew count as upfront cost (today's
//    operation already owns its trucks), in both buy and rent.
//  - A candidate (or a baseline) that doesn't keep up gets `doesntKeepUp` on the payback AND the 3-year net: its
//    savings come from shipping fewer orders, so neither headline number would be honest.
//
// Inputs: a computed total used inside another number (upfront cost inside the payback, …) is listed as one input,
// and the published sources behind it are listed after it as separate inputs, so every money hover links its sources.
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
const TURNOVER_LABEL = 'Staff turnover (context only, not in the math)';

const toCents = (usdValue: number) => Math.round(usdValue * 100);
const noteOf = (...parts: (string | undefined | false)[]) => [...parts.filter(Boolean), NOT_MODELED].join(' ');

function ex(value: number, unit: string, formula: string, inputs: ExplainInput[], note?: string): Explained {
  return { value, unit, formula, inputs, note: noteOf(note) };
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

const isSource = (i: ExplainInput) => i.from.startsWith('source:');
/** Unique inputs by label (the same wage can feed several parts). */
function uniq(inputs: ExplainInput[]): ExplainInput[] {
  const seen = new Set<string>();
  return inputs.filter((i) => (seen.has(i.label) ? false : (seen.add(i.label), true)));
}
/** Inputs shown for context only (not in the math): turnover, reference prices, the labor a number is compared with. */
const isContext = (i: ExplainInput) =>
  i.label === TURNOVER_LABEL || i.label.startsWith('For reference') || i.label.startsWith('Compared with') || i.label.startsWith('Behind the costs');
/** The prices, wages and rates behind some numbers, published or our estimates (with their notes), unique; settings,
 *  simulated values and context-only inputs left out. Listing both kinds keeps a hover from looking more sourced than
 *  it is. */
const leavesOf = (...es: Explained[]) => uniq(es.flatMap((e) => e.inputs).filter((i) => (isSource(i) || i.from === 'estimate') && !isContext(i)));
/** The same, labeled as context, for a flagged number that has no value for them to feed. */
const asContext = (inputs: ExplainInput[]) => inputs.map((i) => ({ ...i, label: `Behind the costs (context): ${i.label}` }));

/** A computed total used as an input of another number. Its origin is the weakest behind it: an estimate anywhere
 *  makes it an estimate; a simulated number makes it simulated; a single published source is cited; several
 *  published sources make it a model calculation ('sim'), and those sources are listed as separate inputs. */
function derived(label: string, e: Explained, note: string): ExplainInput {
  const used = e.inputs.filter((i) => !isContext(i));
  const srcs = new Set(used.filter(isSource).map((i) => i.from));
  let from: ExplainFrom;
  if (used.some((i) => i.from === 'estimate')) from = 'estimate';
  else if (used.some((i) => i.from === 'sim')) from = 'sim';
  else if (srcs.size === 1) from = [...srcs][0];
  else from = srcs.size > 1 ? 'sim' : 'user';
  const listed = srcs.size > 0 ? ' Its published sources are listed as separate inputs.' : '';
  return { label, value: e.value ?? 0, unit: e.unit, from, note: note + listed };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const paren = (s: string) => `(${s})`;
/** Money that may be negative, bracketed so "3 × (−$12,000)" reads right. */
const signedUsd = (v: number) => (v < 0 ? paren(usd(v)) : usd(v));

/** One part of a total: exact in cents, rounded once to whole dollars (the number its formula shows). */
interface Part {
  usd: number;
  text: string;
}
const part = (cents: number, text: string): Part => ({ usd: Math.round(cents / 100), text });
const total = (parts: Part[]) => parts.reduce((a, p) => a + p.usd, 0);
/** "a (x) + b (y) = total", or "a = total" for one part, or the empty sentence. The total is the sum of the parts. */
function sum(prefix: string, parts: Part[], suffix: string, empty: string): string {
  if (parts.length === 0) return `${prefix} = ${empty}`;
  if (parts.length === 1) return `${prefix} = ${parts[0].text} = ${usd(parts[0].usd)}${suffix}`;
  return `${prefix} = ${parts.map((p) => `${p.text} ${paren(usd(p.usd))}`).join(' + ')} = ${usd(total(parts))}${suffix}`;
}

interface Ctx {
  s: Scenario;
  agents: AgentsFile;
  H: number;
  load: number;
  hoursIn: ExplainInput;
  loadIn: ExplainInput;
  /** "2 h", from the scenario's measured minutes. */
  window: string;
  spec(t: AgentTypeId): AgentSpec;
  /** ["cart robot", "cart robots"], from the agents.json label without its bracket. */
  nouns(t: AgentTypeId): [string, string];
  auto: boolean;
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
    window: `${num(s.run.measureMin / 60, 2)} h`,
    spec,
    nouns(t) {
      const one = spec(t).label.replace(/\s*\(.*\)\s*$/, '').toLowerCase();
      return [one, `${one}s`];
    },
    auto,
    baselineFrom: auto ? 'sim' : 'user',
    baselineNote: auto ? 'The smallest people-only crew that keeps up with the same orders, found by simulation.' : 'The people-only crew you set.',
  };
}

// ───────────────────────────── labor ─────────────────────────────

/** One position staffed every operating hour of the year, in cents: H × wage × (1 + load). */
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
  return part(g.n * positionYearCents(c, w), `${count(g.n, g.nouns[0], g.nouns[1])} × ${num(c.H)} h × ${loadedWageText(c, w)}`);
}

interface Labor {
  usd: number;
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
  const groups: Record<'picker' | 'driver' | 'packer', LaborGroup> = {
    picker: {
      n: crew.picker,
      nouns: c.nouns('picker'),
      wage: pickerSpec.cost.wageUsdPerHour,
      countIn: isBase
        ? { label: 'People-only crew: pickers', value: crew.picker, unit: 'people per shift', from: c.baselineFrom, note: c.baselineNote }
        : { label: 'Pickers', value: crew.picker, unit: 'people per shift', from: 'user' },
      wageIn: sourced('Picker wage', pickerSpec.cost.wageUsdPerHour, 'USD/h'),
    },
    driver: {
      n: crew.driver,
      nouns: c.nouns('driver'),
      wage: driverSpec.cost.wageUsdPerHour,
      countIn: isBase
        ? { label: 'People-only crew: forklift drivers', value: crew.driver, unit: 'people per shift', from: c.baselineFrom, note: c.baselineNote }
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
  const resets = part((rph * c.H * minPer * toCents(supWage)) / 60, `${num(rph, 2)} robot resets/h × ${num(c.H)} h × ${num(minPer)} min ÷ 60 × ${price(supWage)}/h supervisor time`);

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
  let formula = sum(prefix, parts, isBase ? ' a year (no robots)' : ' a year', '$0 a year (no people)');
  if (hasRobots && rph <= 0) formula += '; no manual robot resets in the run';
  if (!isBase && agents.labor.turnoverPctPerYear) inputs.push(sourced(TURNOVER_LABEL, agents.labor.turnoverPctPerYear, '%/yr'));
  return { usd: total(parts), picker, driver, packer, resets, formula, inputs: uniq(inputs) };
}

function laborNote(c: Ctx, l: Labor): string {
  return [
    `Packers (${usd(l.packer.usd)} a year) are the same in every option, so they cancel out of the savings and never change the payback.`,
    'Each count is people per shift; hours per year cover every shift.',
    l.resets.usd > 0 ? 'Supervisor reset time is costed at the plain wage.' : '',
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
    // Integer cents per robot-year: maintenance is a % of the price.
    const perOpex = Math.round((toCents(buy) * maint) / 100) + toCents(sw);
    return {
      type: t,
      n,
      capex: part(n * (toCents(buy) + toCents(integ)), `${who} × (${price(buy)} price + ${price(integ)} setup)`),
      opex: part(n * perOpex, `${who} × (${price(buy)} × ${num(maint)}% maintenance + ${price(sw)} software)`),
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
    capex: part(n * toCents(setup), `${who} × ${price(setup)} ${setupWord}`),
    opex: part(n * toCents(monthly) * 12, `${who} × ${price(monthly)} a month × 12`),
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
function keepUpInputs(c: Ctx, r: RunResult, who: string): ExplainInput[] {
  return [
    { label: `${who}: orders shipped per hour`, value: r.kpis.oph, unit: 'orders/h', from: 'sim' },
    { label: 'Orders per hour (demand)', value: c.s.orders.perHour, unit: 'orders/h', from: 'user' },
    { label: `${who}: backlog growth`, value: r.kpis.backlogTrendPerHour, unit: 'orders/h', from: 'sim', note: `Least-squares slope of open orders over the ${c.window} measured window.` },
  ];
}
const crewWords = (c: Ctx, crew: { picker: number; driver: number }) =>
  `${count(crew.picker, ...c.nouns('picker'))} + ${count(crew.driver, ...c.nouns('driver'))}`;
/** Why the people-only side can't be compared: the user's crew can't keep up, or the search found no crew that does. */
const baselineShort = (c: Ctx, crew: { picker: number; driver: number }) =>
  c.auto
    ? `no people-only crew we tried keeps up with these orders (the biggest, ${crewWords(c, crew)})`
    : `the people-only crew you set (${crewWords(c, crew)}) can't keep up with the orders`;

function costPerOrder(c: Ctx, annualUsd: number, r: RunResult, who: 'this option' | 'people only', inputsBefore: ExplainInput, sources: ExplainInput[]): Explained {
  const oph = r.kpis.oph;
  const ordersIn: ExplainInput = {
    label: who === 'this option' ? 'Orders shipped per hour' : 'People-only crew: orders shipped per hour',
    value: oph,
    unit: 'orders/h',
    from: 'sim',
    note: `Measured over the ${c.window} window; never above demand.`,
  };
  const inputs = [inputsBefore, ordersIn, c.hoursIn, ...sources];
  const note = 'Includes packers and every other cost in the yearly total.';
  if (c.s.orders.perHour <= 0) {
    // No orders at all: nothing failed to keep up, there is just nothing to divide by. Shown as $0 (no flag fits).
    return ex(0, 'USD/order', `cost per order = $0.00: there are no orders (0 orders/h), so the ${usd(annualUsd)} a year is not spread over any`, inputs, note);
  }
  if (!(oph > 0) || !(c.H > 0)) {
    const whoWords = who === 'this option' ? 'this option' : 'the people-only crew';
    return flagged('doesntKeepUp', 'USD/order', `no cost per order: ${whoWords} shipped ${num(oph, 1)} orders/h of the ${num(c.s.orders.perHour)} ordered in the run`, inputs, note);
  }
  const v = annualUsd / (oph * c.H);
  return ex(v, 'USD/order', `cost per order = ${usd(annualUsd)} a year ÷ (${num(oph, 1)} orders/h × ${num(c.H)} h) = ${usd2(v)}`, inputs, note);
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
  const trucks = part(extraDrivers * toCents(truckUsd), `${count(extraDrivers, `extra ${dOne}`, `extra ${dMany}`)} × ${price(truckUsd)} truck`);

  // Labor, this option and people only.
  const labor = laborOf(c, { picker: fleet.picker, driver: fleet.driver }, candidate, 'candidate', hasRobots, 'labor');
  const baseLabor = laborOf(c, baselineCrew, baseline, 'baseline', false, 'people-only cost');

  // Per-type lines (the same whole-dollar parts the totals add up).
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
        capex: ex(r.capex.usd, 'USD', r.n > 0 ? `upfront = ${r.capex.text} = ${usd(r.capex.usd)}` : `upfront = ${none}`, r.capexInputs, CAPEX_NOTE[fin]),
        opexYear: ex(r.opex.usd, 'USD/yr', r.n > 0 ? `running cost = ${r.opex.text} = ${usd(r.opex.usd)} a year` : `running cost = ${none} a year`, r.opexInputs, OPEX_NOTE[fin]),
      };
    }
    const n = fleet[t];
    const p = t === 'picker' ? labor.picker : labor.driver;
    const g = t === 'picker' ? sp.cost.wageUsdPerHour : driverSpec.cost.wageUsdPerHour;
    const countIn: ExplainInput = { label: cap(many), value: n, unit: 'people per shift', from: 'user' };
    const laborInputs = [countIn, c.hoursIn, sourced(`${cap(one)} wage`, g, 'USD/h'), c.loadIn];
    const opexYear = ex(p.usd, 'USD/yr', n > 0 ? `labor = ${p.text} = ${usd(p.usd)} a year` : `labor = no ${many} = $0 a year`, laborInputs, 'People per shift; hours per year cover every shift.');
    const capex =
      t === 'picker'
        ? ex(0, 'USD', 'upfront = $0 (no equipment is counted for pickers)', [countIn], 'Carts and hand scanners are not modeled.')
        : ex(
            trucks.usd,
            'USD',
            extraDrivers > 0
              ? `trucks = ${trucks.text} = ${usd(trucks.usd)}`
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
  const capexUsd = total(capexParts);
  // No robots in the plan: show what each robot type would cost, citing its sources, so the $0 is traceable too.
  const noRobotsIn: ExplainInput = { label: 'Robots in this plan', value: 0, unit: 'robots', from: 'user' };
  const forReference = (inputs: ExplainInput[]) =>
    uniq(inputs.filter((i) => i.unit !== 'robots')).map((i) => ({ ...i, label: `For reference (none in this plan): ${i.label}`, note: ['No robots in this plan; what one would cost.', i.note].filter(Boolean).join(' ') }));
  const capex = ex(
    capexUsd,
    'USD',
    sum('upfront', capexParts, '', fin === 'buy' ? '$0 (no robots to buy or set up)' : '$0 (no robots to set up)'),
    capexInputs.length ? uniq(capexInputs) : [noRobotsIn, ...forReference(robots.flatMap((r) => r.capexInputs))],
    [CAPEX_NOTE[fin], TRUCK_NOTE].join(' '),
  );

  // Robot running cost.
  const opexParts = robots.filter((r) => r.n > 0).map((r) => r.opex);
  const opexUsd = total(opexParts);
  const robotOpexYear = ex(
    opexUsd,
    'USD/yr',
    sum('robot running cost', opexParts, ' a year', '$0 a year (no robots)'),
    hasRobots ? uniq(robots.filter((r) => r.n > 0).flatMap((r) => r.opexInputs)) : [noRobotsIn, ...forReference(robots.flatMap((r) => r.opexInputs))],
    OPEX_NOTE[fin],
  );

  // Labor and yearly totals.
  const laborYear = ex(labor.usd, 'USD/yr', labor.formula, labor.inputs, laborNote(c, labor));
  const annualUsd = labor.usd + opexUsd;
  const laborDer = derived('Labor', laborYear, 'Pickers, drivers, packers and supervisor time; see Labor.');
  const opexDer = derived('Robot running cost', robotOpexYear, 'Robot maintenance and software, or rent; see Robot running cost.');
  const annualSources = leavesOf(laborYear, robotOpexYear);
  const annualCost = ex(
    annualUsd,
    'USD/yr',
    `annual cost = ${usd(labor.usd)} labor + ${usd(opexUsd)} robot running cost = ${usd(annualUsd)} a year`,
    [laborDer, opexDer, ...annualSources],
  );
  const baseUsd = baseLabor.usd; // people only: no robots, so no robot running cost
  const baselineAnnualCost = ex(
    baseUsd,
    'USD/yr',
    baseLabor.formula,
    baseLabor.inputs,
    `${laborNote(c, baseLabor)} The people-only crew: ${crewWords(c, baselineCrew)}. ${c.baselineNote}`,
  );

  // Savings.
  const S = baseUsd - annualUsd;
  const keeps = candidate.kpis.keepsUp;
  const baseKeeps = baseline.kpis.keepsUp;
  const baseDer = derived('People-only cost per year', baselineAnnualCost, `${crewWords(c, baselineCrew)} + packers; see People-only cost.`);
  const annualDer = derived('This option’s cost per year', annualCost, 'Labor plus robot running cost; see Annual cost.');
  const savingsSources = leavesOf(baselineAnnualCost, laborYear, robotOpexYear);
  const savingsYear = ex(
    S,
    'USD/yr',
    `savings = ${usd(baseUsd)} people-only cost − ${usd(annualUsd)} this option = ${usd(S)} a year`,
    [baseDer, annualDer, ...savingsSources],
    [
      'Both sides handle the same orders (same seed, same order stream).',
      !keeps ? 'This option does not keep up with the orders, so this is not a like-for-like saving.' : '',
      !baseKeeps ? 'The people-only crew does not keep up with the orders, so this is not a like-for-like saving.' : '',
    ]
      .filter(Boolean)
      .join(' '),
  );

  // Payback and 3-year net. Every branch lists the prices and wages behind the upfront cost and both yearly costs,
  // published and estimated alike, and says how much of the upfront rests on our estimates.
  const keySources = leavesOf(capex, laborYear, robotOpexYear, baselineAnnualCost);
  const estParts = robots.filter((r) => r.n > 0 && r.capexInputs.some((i) => i.from === 'estimate'));
  const estUsd = estParts.reduce((a, r) => a + r.capex.usd, 0) + (extraDrivers > 0 && truckIn.from === 'estimate' ? trucks.usd : 0);
  const estNames = [...estParts.map((r) => c.nouns(r.type)[0]), ...(extraDrivers > 0 && truckIn.from === 'estimate' ? ['forklift truck'] : [])];
  const estNote =
    estUsd > 0
      ? `${estUsd === capexUsd ? 'All' : usd(estUsd)} of the ${usd(capexUsd)} upfront rests on our estimates (${estNames.join(', ')} prices); see each robot's hover.`
      : undefined;
  const capexDer = derived('Upfront cost', capex, ['Robots and setup, plus trucks for extra drivers; see Upfront cost.', estNote].filter(Boolean).join(' '));
  const FLAG_CONTEXT = 'No number here, so the prices and wages behind the costs are listed for context only.';
  const savingsDer = derived('Yearly savings vs people only', savingsYear, 'People-only cost minus this option’s cost; see Yearly savings.');
  const candShort = `this option can't keep up with the orders: ${keepUpWords(candidate, s)}`;
  const baseShort = `${baselineShort(c, baselineCrew)}, so there is no fair comparison: ${keepUpWords(baseline, s)}`;
  let paybackMonths: Explained;
  if (!keeps) {
    paybackMonths = flagged('doesntKeepUp', 'months', `no payback: ${candShort}`, [...keepUpInputs(c, candidate, 'This option'), ...asContext(keySources)], `${SIMPLE_PAYBACK} ${FLAG_CONTEXT}`);
  } else if (!baseKeeps) {
    paybackMonths = flagged('doesntKeepUp', 'months', `no payback: ${baseShort}`, [...keepUpInputs(c, baseline, 'People-only crew'), ...asContext(keySources)], `${SIMPLE_PAYBACK} ${FLAG_CONTEXT}`);
  } else if (S <= 0) {
    const why = S === 0 ? 'this option costs the same per year as people only' : `this option costs ${usd(-S)} a year more than people only (${usd(annualUsd)} vs ${usd(baseUsd)})`;
    paybackMonths = flagged('never', 'months', `never pays back: ${why}, so the ${usd(capexUsd)} upfront is never earned back`, [capexDer, savingsDer, baseDer, annualDer, ...keySources], [SIMPLE_PAYBACK, estNote].filter(Boolean).join(' '));
  } else {
    const months = (capexUsd * 12) / S;
    const years = months >= 24 ? ` (${fixed(months / 12, 1)} years)` : '';
    paybackMonths = {
      value: months,
      unit: 'months',
      formula: `payback = ${usd(capexUsd)} upfront ÷ (${usd(S)} saved a year ÷ 12) = ${fixed(months, 1)} months${years}`,
      inputs: [capexDer, savingsDer, ...keySources],
      note: noteOf(SIMPLE_PAYBACK, estNote, capexUsd === 0 ? 'Nothing is paid upfront, so it pays back at once.' : undefined),
    };
  }

  const netUsd = 3 * S - capexUsd;
  const threeYearNet = !keeps
    ? flagged('doesntKeepUp', 'USD', `no 3-year net: ${candShort}`, [...keepUpInputs(c, candidate, 'This option'), ...asContext(keySources)], FLAG_CONTEXT)
    : !baseKeeps
      ? flagged('doesntKeepUp', 'USD', `no 3-year net: ${baseShort}`, [...keepUpInputs(c, baseline, 'People-only crew'), ...asContext(keySources)], FLAG_CONTEXT)
      : ex(netUsd, 'USD', `3-year net = 3 × ${signedUsd(S)} savings a year − ${usd(capexUsd)} upfront = ${usd(netUsd)}`, [savingsDer, capexDer, ...keySources], ['Three years of savings minus the upfront cost, with no discounting.', estNote].filter(Boolean).join(' '));

  // Every money hover links at least one published source (PROTOCOL §7). A number whose own inputs are only settings
  // and estimates (the cart-robot prices are all estimates) also lists the published labor cost it is weighed
  // against: the wage of the people that kind of robot replaces (forklifts → drivers; cart robots, humanoids → pickers).
  const comparedWith = (role: 'picker' | 'driver'): ExplainInput[] =>
    [sourced(role === 'picker' ? 'Picker wage' : 'Forklift driver wage', c.spec(role).cost.wageUsdPerHour, 'USD/h'), c.loadIn]
      .filter(isSource)
      .map((i) => ({ ...i, label: `Compared with (context): ${i.label}`, note: ['Its own inputs are settings or estimates; this is the published labor cost it is weighed against.', i.note].filter(Boolean).join(' ') }));
  const ROLE: Record<AgentTypeId, 'picker' | 'driver'> = { amr: 'picker', humanoid: 'picker', picker: 'picker', forklift: 'driver', driver: 'driver' };
  const cite = (e: Explained, role: 'picker' | 'driver' = 'picker'): Explained => (e.inputs.some(isSource) ? e : { ...e, inputs: [...e.inputs, ...comparedWith(role)] });

  return {
    financing: fin,
    hoursPerYear: c.H,
    lines: lines.map((l) => ({ ...l, capex: cite(l.capex, ROLE[l.type]), opexYear: cite(l.opexYear, ROLE[l.type]) })),
    capex: cite(capex),
    robotOpexYear: cite(robotOpexYear),
    laborYear: cite(laborYear),
    annualCost: cite(annualCost),
    baselineAnnualCost: cite(baselineAnnualCost),
    savingsYear: cite(savingsYear),
    paybackMonths: cite(paybackMonths),
    threeYearNet: cite(threeYearNet),
    costPerOrder: cite(costPerOrder(c, annualUsd, candidate, 'this option', annualDer, annualSources)),
    baselineCostPerOrder: cite(costPerOrder(c, baseUsd, baseline, 'people only', baseDer, leavesOf(baselineAnnualCost))),
    baseline: { picker: baselineCrew.picker, driver: baselineCrew.driver, keepsUp: baseKeeps },
  };
}
