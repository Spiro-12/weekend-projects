// Money hovers (Track F): the formula with the real numbers filled in, built from the MoneyReport's own fields.
// A worked line is only added when the model's own formula has no numbers in it (Track C's formulas carry them) and
// when it reproduces the reported value, so a hover never shows a sum twice or a sum that doesn't add up.
// Also decides who is behind when a comparison isn't like for like: this plan, the people-only crew, or both.
import { ROBOT_TYPES, type Explained, type MoneyLine, type MoneyReport, type SourceRef } from '../../contracts/types.ts';
import { capitalize, FLAG_WORDS, fromExplained, TYPE_NAMES, typeCount, type ExplainContent } from './content.ts';
import { close, num, plural, usd, withUnit } from './format.ts';

export type MoneyKey =
  | 'paybackMonths'
  | 'threeYearNet'
  | 'capex'
  | 'robotOpexYear'
  | 'laborYear'
  | 'annualCost'
  | 'baselineAnnualCost'
  | 'savingsYear'
  | 'costPerOrder'
  | 'baselineCostPerOrder';

export const MONEY_TITLES: Record<MoneyKey, string> = {
  paybackMonths: 'Pays back in',
  threeYearNet: 'Net savings over 3 years',
  capex: 'Upfront cost',
  robotOpexYear: 'Robot running cost per year',
  laborYear: 'People cost per year (this plan)',
  annualCost: 'Total cost per year (this plan)',
  baselineAnnualCost: 'People cost per year (people only)',
  savingsYear: 'Savings per year',
  costPerOrder: 'Cost per order (this plan)',
  baselineCostPerOrder: 'Cost per order (people only)',
};

/** Who can't keep up with the orders: this plan, the people-only crew, both, or nobody (null). */
export type Behind = 'plan' | 'people' | 'both' | null;

/**
 * From a money report and whether the run it was computed from keeps up. The economics flag payback (and the 3-year
 * net) `doesntKeepUp` when EITHER side falls behind, so the flag alone can't say whose fault it is.
 */
export function whoIsBehind(m: MoneyReport, planKeepsUp: boolean | undefined): Behind {
  const people = m.baseline.keepsUp === false;
  const plan = planKeepsUp === undefined ? m.paybackMonths.flag === 'doesntKeepUp' && !people : !planKeepsUp;
  return plan && people ? 'both' : plan ? 'plan' : people ? 'people' : null;
}

/** Short words for the panel, by who is behind. */
export const BEHIND_WORDS: Record<NonNullable<Behind>, { payback: string; why: string }> = {
  plan: { payback: FLAG_WORDS.doesntKeepUp, why: 'this plan falls behind the orders' },
  people: { payback: 'People only can’t keep up', why: 'people only falls behind the orders' },
  both: { payback: 'Neither keeps up with the orders', why: 'neither keeps up with the orders' },
};
export const NOT_COMPARABLE = 'Not comparable';

export interface MoneyCtx {
  /** Orders shipped per hour by this plan and by the people-only crew, from the runs this report was computed from. */
  oph?: number;
  baselineOph?: number;
  /** Orders coming in per hour, for those runs. */
  demand?: number;
  /** Whether this plan keeps up (same run as the report). */
  planKeepsUp?: boolean;
  sources: SourceRef[];
  demo?: boolean;
  /** The report is being recalculated: mark the popover. */
  stale?: boolean;
}

const val = (e: Explained | undefined) => (e && e.value !== null && !e.flag ? e.value : null);
const isRobot = (t: string) => (ROBOT_TYPES as readonly string[]).includes(t);

/** True when a formula already has the real numbers in it ("payback = $1,092,000 upfront ÷ …"). */
export const hasNumbers = (formula: string) => /\$\d|\d[.,]\d|\d{3,}/.test(formula);

/** What a line's upfront cost is for: robots' price and setup, pickers' equipment, trucks for extra drivers. */
function capexWhat(l: MoneyLine): string {
  if (isRobot(l.type)) return typeCount(l.type, l.count, l.label);
  if (l.type === 'driver') return 'trucks for extra drivers';
  return `${TYPE_NAMES[l.type as 'picker']?.[0] ?? l.label} equipment`;
}

/** Sum of a field over the lines, written out ("$840,000 (24 cart robots) + …"), if it matches the total. */
function sumLine(lines: MoneyLine[], pick: (l: MoneyLine) => Explained, total: number, what: (l: MoneyLine) => string, unitWord = ''): string | undefined {
  const parts = lines.map((l) => ({ l, v: val(pick(l)) })).filter((p) => p.v !== null && p.v !== 0) as { l: MoneyLine; v: number }[];
  const sum = parts.reduce((a, p) => a + p.v, 0);
  if (!close(sum, total)) return undefined;
  if (parts.length === 0) return `No robots in this plan, so ${usd(0)}${unitWord}.`;
  const terms = parts.map((p) => `${usd(p.v)} (${what(p.l)})`);
  return parts.length === 1 ? `${terms[0]} = ${usd(total)}${unitWord}` : `${terms.join(' + ')} = ${usd(total)}${unitWord}`;
}

function crew(m: MoneyReport): string {
  return `${plural(m.baseline.picker, 'picker')} + ${plural(m.baseline.driver, 'driver')}`;
}

export function workedLine(key: MoneyKey, m: MoneyReport, ctx: MoneyCtx): string | undefined {
  const capex = val(m.capex);
  const S = val(m.savingsYear);
  const annual = val(m.annualCost);
  const base = val(m.baselineAnnualCost);
  const labor = val(m.laborYear);
  const opex = val(m.robotOpexYear);
  const H = m.hoursPerYear;
  const behind = whoIsBehind(m, ctx.planKeepsUp);
  switch (key) {
    case 'paybackMonths': {
      const pb = m.paybackMonths;
      if (behind === 'people')
        return ctx.baselineOph !== undefined && ctx.demand !== undefined
          ? `The people-only crew (${crew(m)}) ships ${num(ctx.baselineOph)} of the ${num(ctx.demand)} orders coming in each hour, so it falls behind. This plan keeps up, so there is no like-for-like payback.`
          : 'The people-only crew can’t keep up with these orders, so there is no like-for-like payback.';
      if (behind === 'plan' || behind === 'both' || pb.flag === 'doesntKeepUp')
        return ctx.oph !== undefined && ctx.demand !== undefined
          ? `This plan ships ${num(ctx.oph)} of the ${num(ctx.demand)} orders coming in each hour, so orders pile up. A payback date would compare it with a crew that ships them all.`
          : 'This plan falls behind the orders coming in, so a payback date would not be a fair comparison.';
      if (pb.flag === 'never' && capex !== null && S !== null)
        return S === 0
          ? `Savings per year: ${usd(0)}. This plan costs the same each year as people only, so the ${usd(capex)} upfront cost never comes back.`
          : `Savings per year: ${usd(S)}. This plan costs more each year than people only, so the ${usd(capex)} upfront cost never comes back.`;
      const v = val(pb);
      if (v === null || capex === null || S === null || S <= 0 || !close(capex / (S / 12), v)) return undefined;
      return `${usd(capex)} ÷ (${usd(S)} ÷ 12 months) = ${num(v, 1)} months`;
    }
    case 'threeYearNet': {
      const v = val(m.threeYearNet);
      if (v === null || capex === null || S === null || !close(3 * S - capex, v)) return undefined;
      return `3 × ${usd(S)} − ${usd(capex)} = ${usd(v)}`;
    }
    case 'savingsYear':
      if (S === null || base === null || annual === null || !close(base - annual, S)) return undefined;
      return `${usd(base)} − ${usd(annual)} = ${usd(S)} a year`;
    case 'annualCost':
      if (annual === null || labor === null || opex === null || !close(labor + opex, annual)) return undefined;
      return `${usd(labor)} people + ${usd(opex)} robots = ${usd(annual)} a year`;
    case 'capex':
      return capex === null ? undefined : sumLine(m.lines, (l) => l.capex, capex, capexWhat);
    case 'robotOpexYear':
      // Robot running cost covers robot lines only (people lines carry pay in opexYear).
      return opex === null ? undefined : sumLine(m.lines.filter((l) => isRobot(l.type)), (l) => l.opexYear, opex, (l) => typeCount(l.type, l.count, l.label), ' a year');
    case 'costPerOrder':
    case 'baselineCostPerOrder': {
      const v = val(key === 'costPerOrder' ? m.costPerOrder : m.baselineCostPerOrder);
      const yearly = key === 'costPerOrder' ? annual : base;
      const oph = key === 'costPerOrder' ? ctx.oph : ctx.baselineOph;
      if (v === null || yearly === null || !oph || !close(yearly / (oph * H), v)) return undefined;
      return `${usd(yearly)} a year ÷ (${num(oph, Math.round(oph) === oph ? 0 : 1)} orders an hour × ${num(H)} hours) = ${usd(v)} per order`;
    }
    default:
      return undefined;
  }
}

export function moneyContent(key: MoneyKey, m: MoneyReport, ctx: MoneyCtx): ExplainContent {
  const ex = m[key];
  const worked = hasNumbers(ex.formula) ? undefined : workedLine(key, m, ctx);
  const c = fromExplained(MONEY_TITLES[key], ex, ctx.sources, { worked, demo: ctx.demo });
  c.stale = ctx.stale;
  if (key === 'paybackMonths' && c.value && ex.value !== null) c.value = `${num(ex.value, 1)} months`;
  const behind = whoIsBehind(m, ctx.planKeepsUp);
  if (!behind) return c;
  // Not like for like: the flag says who is behind, and a saving is never the headline.
  if (key === 'paybackMonths' && ex.flag === 'doesntKeepUp') {
    c.flag = behind === 'people' ? 'The people-only crew can’t keep up with these orders, so there’s no like-for-like payback' : BEHIND_WORDS[behind].payback;
  }
  if (key === 'threeYearNet' || key === 'savingsYear') {
    const v = val(ex);
    c.flag = `${NOT_COMPARABLE}: ${BEHIND_WORDS[behind].why}`;
    c.value = undefined;
    if (v !== null) c.reference = `For reference only: ${withUnit(v, ex.unit)}`;
    c.text = [
      behind === 'people'
        ? 'The people-only crew can’t ship all the orders, so its cost isn’t a fair yardstick for this plan.'
        : behind === 'plan'
          ? 'This plan ships fewer orders than come in, so it only looks cheaper. Not shown on the panel.'
          : 'Neither this plan nor the people-only crew ships all the orders, so the two can’t be compared.',
      ...(c.text ?? []),
    ];
  }
  return c;
}

/** A breakdown cell. Robot lines: upfront price/setup and upkeep or rent. People lines: equipment (trucks) and pay. */
export function lineContent(line: MoneyLine, part: 'capex' | 'opexYear', ctx: MoneyCtx, financing: 'buy' | 'raas'): ExplainContent {
  const ex = line[part];
  const robot = isRobot(line.type);
  const who = capitalize(typeCount(line.type, line.count, line.label));
  const title =
    part === 'capex'
      ? robot
        ? `${who}: upfront`
        : line.type === 'driver'
          ? 'Forklift drivers: trucks for extra drivers'
          : `${capitalize(TYPE_NAMES[line.type as 'picker']?.[1] ?? line.label)}: equipment upfront`
      : !robot
        ? `${who}: pay per year`
        : `${who}: ${financing === 'raas' ? 'rent' : 'upkeep'} per year`;
  const c = fromExplained(title, ex, ctx.sources, { demo: ctx.demo, value: ex.value === null ? undefined : withUnit(ex.value, ex.unit) });
  c.stale = ctx.stale;
  return c;
}
