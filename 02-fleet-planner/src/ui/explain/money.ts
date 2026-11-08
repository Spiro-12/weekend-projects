// Money hovers (Track F): the formula with the real numbers filled in, built from the MoneyReport's own fields.
// A worked line is only shown when it reproduces the reported value (so the hover can never show sums that don't
// add up, whichever economics module is plugged in). Otherwise the hover shows the formula and its inputs.
import { ROBOT_TYPES, type Explained, type MoneyLine, type MoneyReport, type SourceRef } from '../../contracts/types.ts';
import { capitalize, fromExplained, typeCount, type ExplainContent } from './content.ts';
import { close, num, usd, withUnit } from './format.ts';

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

export interface MoneyCtx {
  /** Orders shipped per hour by this plan and by the people-only crew (for cost per order). */
  oph?: number;
  baselineOph?: number;
  /** Orders coming in per hour (for the "can't keep up" explanation). */
  demand?: number;
  sources: SourceRef[];
  demo?: boolean;
}

const val = (e: Explained | undefined) => (e && e.value !== null && !e.flag ? e.value : null);

/** Sum of a field over the lines, written out ("$840,000 + $780,000 = $1,620,000"), if it matches the total. */
function sumLine(lines: MoneyLine[], pick: (l: MoneyLine) => Explained, total: number, unitWord = ''): string | undefined {
  const parts = lines.map((l) => ({ l, v: val(pick(l)) })).filter((p) => p.v !== null && p.v !== 0) as { l: MoneyLine; v: number }[];
  const sum = parts.reduce((a, p) => a + p.v, 0);
  if (!close(sum, total)) return undefined;
  if (parts.length === 0) return `No robots in this plan, so ${usd(0)}${unitWord}.`;
  const terms = parts.map((p) => `${usd(p.v)} (${typeCount(p.l.type, p.l.count, p.l.label)})`);
  return parts.length === 1 ? `${terms[0]} = ${usd(total)}${unitWord}` : `${terms.join(' + ')} = ${usd(total)}${unitWord}`;
}

export function workedLine(key: MoneyKey, m: MoneyReport, ctx: MoneyCtx): string | undefined {
  const capex = val(m.capex);
  const S = val(m.savingsYear);
  const annual = val(m.annualCost);
  const base = val(m.baselineAnnualCost);
  const labor = val(m.laborYear);
  const opex = val(m.robotOpexYear);
  const H = m.hoursPerYear;
  switch (key) {
    case 'paybackMonths': {
      const pb = m.paybackMonths;
      if (pb.flag === 'never' && capex !== null && S !== null)
        return `Savings per year: ${usd(S)}. With no savings, the ${usd(capex)} upfront cost never comes back.`;
      if (pb.flag === 'doesntKeepUp')
        return ctx.oph !== undefined && ctx.demand !== undefined
          ? `This plan ships ${num(ctx.oph)} of the ${num(ctx.demand)} orders coming in each hour, so orders pile up. A payback date would compare it with a crew that ships them all.`
          : 'This plan falls behind the orders coming in, so a payback date would not be a fair comparison.';
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
      return capex === null ? undefined : sumLine(m.lines, (l) => l.capex, capex);
    case 'robotOpexYear':
      // Robot running cost covers robot lines only (people lines carry pay in opexYear).
      return opex === null ? undefined : sumLine(m.lines.filter((l) => isRobot(l.type)), (l) => l.opexYear, opex, ' a year');
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
  const c = fromExplained(MONEY_TITLES[key], ex, ctx.sources, { worked: workedLine(key, m, ctx), demo: ctx.demo });
  if (key === 'paybackMonths' && c.value && ex.value !== null) c.value = `${num(ex.value, 1)} months`;
  return c;
}

const isRobot = (t: string) => (ROBOT_TYPES as readonly string[]).includes(t);

/** A breakdown cell. Robot lines: upfront price/setup and upkeep or rent. People lines: equipment (trucks) and pay. */
export function lineContent(line: MoneyLine, part: 'capex' | 'opexYear', ctx: MoneyCtx, financing: 'buy' | 'raas'): ExplainContent {
  const ex = line[part];
  const robot = isRobot(line.type);
  const what = part === 'capex' ? (robot ? 'upfront' : 'equipment upfront') : !robot ? 'pay per year' : financing === 'raas' ? 'rent per year' : 'upkeep per year';
  return fromExplained(`${capitalize(typeCount(line.type, line.count, line.label))}: ${what}`, ex, ctx.sources, { demo: ctx.demo, value: ex.value === null ? undefined : withUnit(ex.value, ex.unit) });
}
