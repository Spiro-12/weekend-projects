// Money panel (Track F, slot `right`): when do the robots pay back, compared with doing it with people only.
// Every number hovers (taps on phones) to its formula with the real numbers, its inputs and their sources.
// Flags are words, never numbers, and they blame the right side: this plan, or the people-only crew it is compared
// with. The panel reads one consistent snapshot (money/view.ts); while it recalculates the numbers dim; after a
// failure none are shown.
import { ROBOT_TYPES, type Explained, type MoneyLine, type MoneyReport } from '../../contracts/types.ts';
import type { Host } from '../../host/index.ts';
import { FLAG_WORDS, runLine, sourceById, typeCount, type ExplainContent } from '../explain/content.ts';
import { monthsShort, num, plural, usd, usdShort, yearsFromMonths } from '../explain/format.ts';
import { BEHIND_WORDS, lineContent, moneyContent, NOT_COMPARABLE, type Behind, type MoneyKey } from '../explain/money.ts';
import { Num } from '../explain/num.tsx';
import { Explain } from '../explain/popover.tsx';
import { definePanel } from '../panel.ts';
import '../panels.css';
import { moneyCtx, moneyView, type MoneyView } from './money/view.ts';

const ok = (e: Explained | undefined): number | null => (e && !e.flag && e.value !== null ? e.value : null);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** A money number: flag words when flagged (never a number), words when not comparable, else the tweened value. */
function MoneyNum({ e, format, words, lower }: { e: Explained | undefined; format: (v: number) => string; words?: string; lower?: boolean }) {
  const w = words ?? (e?.flag ? FLAG_WORDS[e.flag] : undefined);
  if (w) return <span class="flag-words small">{lower ? lowerFirst(w) : w}</span>;
  return <Num value={ok(e)} format={format} />;
}

/** The same value as plain text, for screen readers. */
function spoken(e: Explained | undefined, format: (v: number) => string, words?: string): string {
  if (words) return words;
  if (e?.flag) return FLAG_WORDS[e.flag];
  const v = ok(e);
  return v === null ? 'not available' : format(v);
}

function MoneyPanel({ host }: { host: Host }) {
  const view = moneyView(host).value;
  const { m, behind, pending } = view;
  const s = host.settings.value;
  const financing = s.economics.financing;
  const current = () => moneyView(host).value;
  const waiting = (title: string): ExplainContent => ({
    title,
    text: [host.moneyPending.value ? 'Working out the money for these settings…' : 'The money could not be worked out for these settings. Change a setting to try again.'],
  });
  const explain = (key: MoneyKey, title: string) => () => {
    const v = current();
    return v.m ? moneyContent(key, v.m, moneyCtx(host, v)) : waiting(title);
  };
  const explainLine = (type: MoneyLine['type'], part: 'capex' | 'opexYear') => () => {
    const v = current();
    const line = v.m?.lines.find((l) => l.type === type);
    return line ? lineContent(line, part, moneyCtx(host, v), host.settings.value.economics.financing) : waiting('By type');
  };

  const pb = m?.paybackMonths;
  const pbValue = behind ? null : ok(pb);
  const net = ok(m?.threeYearNet);
  const S = ok(m?.savingsYear);
  const sameCost = S === 0;
  const lines = (m?.lines ?? []).filter((l) => l.count > 0);
  const failed = !m && !pending;

  // Payback: who is behind first, then the economics' own flag, then the number.
  const pbWords = behind ? BEHIND_WORDS[behind].payback : pb?.flag ? FLAG_WORDS[pb.flag] : pb && pb.value === null ? 'No payback date' : undefined;
  const pbSub = behind
    ? behind === 'people'
      ? 'so there’s no like-for-like payback'
      : 'add robots or people until it keeps up'
    : pb?.flag === 'never'
      ? sameCost
        ? 'it costs the same each year as people only'
        : 'it costs more each year than people only'
      : undefined;
  const netWords = behind ? NOT_COMPARABLE : m?.threeYearNet.flag ? FLAG_WORDS[m.threeYearNet.flag] : undefined;
  const netSub = behind
    ? BEHIND_WORDS[behind].why
    : m?.threeYearNet.flag === 'never'
      ? sameCost
        ? 'it costs the same each year as people only'
        : 'it costs more each year than people only'
      : net !== null && net < 0
        ? 'you lose money over 3 years'
        : 'after paying for the robots';

  return (
    <div class={`card money${pending ? ' pending' : ''}`} data-testid="money-panel">
      <div class="money-head">
        <h2>Money</h2>
        <div class="seg" role="group" aria-label="Buy or rent the robots">
          <button type="button" aria-pressed={financing === 'buy'} data-testid="financing-buy" onClick={() => host.setFinancing('buy')}>
            Buy
          </button>
          <button type="button" aria-pressed={financing === 'raas'} data-testid="financing-raas" onClick={() => host.setFinancing('raas')}>
            Rent
          </button>
        </div>
      </div>
      <p class="money-sub">
        {financing === 'raas' ? 'Renting: a monthly fee per robot, setup paid up front.' : 'Buying: pay for the robots up front, then upkeep each year.'}
      </p>
      <div class="money-status" data-testid="money-status" aria-live="polite">
        {pending ? (m ? 'Recalculating…' : 'Working it out…') : failed ? 'Couldn’t work out the money for these settings. Change a setting to try again.' : ''}
      </div>
      <Banner view={view} />

      <div class="hero">
        <div class="hero-item">
          <div class="hero-label">Pays back in</div>
          <Explain
            id="money-payback"
            class={`hero-num${pbWords ? ' flagged' : ''}`}
            label={`Pays back in: ${pbWords ?? (pbValue === null ? 'not available' : `${monthsShort(pbValue)} months`)}`}
            content={explain('paybackMonths', 'Pays back in')}
          >
            {pbWords ? (
              <span class="flag-words">{pbWords}</span>
            ) : (
              <>
                <Num value={pbValue} format={monthsShort} />
                {pbValue !== null && <span class="hero-unit">{pbValue === 1 ? 'month' : 'months'}</span>}
              </>
            )}
          </Explain>
          <div class="hero-sub">
            {pbValue !== null ? (
              <>
                {yearsFromMonths(pbValue)} ·{' '}
                <Explain id="money-3yr-mark" class={`mark ${pbValue <= 36 ? 'good' : 'warn'}`} content={() => markContent(host)}>
                  {pbValue <= 36 ? 'within' : 'over'} the 3 years most buyers want
                </Explain>
              </>
            ) : (
              (pbSub ?? ' ')
            )}
          </div>
        </div>
        <div class="hero-item">
          <div class="hero-label">Net savings, 3 years</div>
          <Explain
            id="money-3yr"
            class={`hero-num${netWords ? ' flagged' : net !== null && net < 0 ? ' neg' : ''}`}
            label={`Net savings over 3 years: ${netWords ?? (net === null ? 'not available' : usdShort(net))}`}
            content={explain('threeYearNet', 'Net savings over 3 years')}
          >
            {netWords ? <span class="flag-words">{netWords}</span> : <Num value={net} format={usdShort} />}
          </Explain>
          <div class="hero-sub">{netSub}</div>
        </div>
      </div>

      <div class="mrows">
        <MoneyRow label="Upfront cost" id="money-capex" e={m?.capex} content={explain('capex', 'Upfront cost')} />
        <MoneyRow
          label={financing === 'raas' ? 'Robot rent per year' : 'Robot upkeep per year'}
          id="money-robot-opex"
          e={m?.robotOpexYear}
          content={explain('robotOpexYear', 'Robot running cost per year')}
        />
        <MoneyRow
          label="People per year"
          id="money-labor"
          e={m?.laborYear}
          content={explain('laborYear', 'People cost per year')}
          base={{ id: 'money-labor-base', e: m?.baselineAnnualCost, content: explain('baselineAnnualCost', 'People cost per year (people only)') }}
        />
        <MoneyRow
          label="Cost per order"
          id="money-cpo"
          e={m?.costPerOrder}
          exact
          content={explain('costPerOrder', 'Cost per order')}
          base={{ id: 'money-cpo-base', e: m?.baselineCostPerOrder, content: explain('baselineCostPerOrder', 'Cost per order (people only)') }}
        />
        <MoneyRow
          label="Savings per year"
          id="money-savings"
          e={m?.savingsYear}
          content={explain('savingsYear', 'Savings per year')}
          tone
          words={behind ? lowerFirst(NOT_COMPARABLE) : undefined}
        />
      </div>

      <div class="msec">
        <div class="msec-h">
          <span>By type</span>
          <span>Upfront</span>
          <span>Per year</span>
        </div>
        {m && !lines.some((l) => (ROBOT_TYPES as readonly string[]).includes(l.type)) && <div class="mline-empty">No robots in this plan.</div>}
        {lines.map((l) => (
          <div class="mline" key={l.type} data-testid={`money-line-${l.type}`}>
            <span class="mline-name" title={l.label}>
              <b>{num(l.count)}</b> {typeCount(l.type, l.count, l.label).replace(/^\S+ /, '')}
            </span>
            <Explain id={`money-line-${l.type}-capex`} class="mval" label={`${typeCount(l.type, l.count, l.label)}, upfront: ${spoken(l.capex, usdShort)}`} content={explainLine(l.type, 'capex')}>
              <MoneyNum e={l.capex} format={usdShort} />
            </Explain>
            <Explain id={`money-line-${l.type}-opex`} class="mval" label={`${typeCount(l.type, l.count, l.label)}, per year: ${spoken(l.opexYear, usdShort)}`} content={explainLine(l.type, 'opexYear')}>
              <MoneyNum e={l.opexYear} format={usdShort} />
            </Explain>
          </div>
        ))}
      </div>

      <Baseline host={host} m={m} behind={behind} />
    </div>
  );
}

/** Who is behind, in plain words, from the same snapshot as the numbers. */
function Banner({ view }: { view: MoneyView }) {
  const { behind, r, b, m, demand } = view;
  if (!behind || !m) return null;
  if (behind === 'people')
    return (
      <div class="money-flag info" data-testid="money-people-behind">
        <b>This plan keeps up; people only can’t.</b> The people-only crew ({plural(m.baseline.picker, 'picker')} + {plural(m.baseline.driver, 'driver')})
        {b ? ` ships ${num(b.result.kpis.oph)} of the ${num(demand)} orders coming in each hour` : ' falls behind the orders'}, so there’s no like-for-like payback.
      </div>
    );
  return (
    <div class="money-flag" data-testid="money-keepsup">
      <b>{FLAG_WORDS.doesntKeepUp}.</b> This plan {r ? `ships ${num(r.kpis.oph)} of the ${num(demand)} orders coming in each hour` : 'falls behind the orders'}, so orders pile up.
      {behind === 'both' && ' The people-only crew can’t keep up either.'}
    </div>
  );
}

function markContent(host: Host): ExplainContent {
  const from = 'source:interact-buyers-survey' as const;
  return {
    title: 'The 3-year mark',
    text: ['In a survey of 300 mobile robot buyers, 80% expected their money back within 3 years. That is the bar most buyers use.'],
    inputs: [{ label: 'Buyers who expect payback within 3 years', value: '80%', from, source: sourceById(host.data.sources.sources, from) }],
  };
}

function MoneyRow(p: {
  label: string;
  id: string;
  e: Explained | undefined;
  content: () => ExplainContent;
  exact?: boolean;
  tone?: boolean;
  /** Words instead of the number (the hover still has the math, for reference). */
  words?: string;
  base?: { id: string; e: Explained | undefined; content: () => ExplainContent };
}) {
  const fmt = p.exact ? usd : usdShort;
  const v = ok(p.e);
  const tone = p.words ? ' unfair' : p.tone && v !== null ? (v > 0 ? ' good' : v < 0 ? ' bad' : '') : '';
  return (
    <div class="mrow">
      <span class="mrow-label">{p.label}</span>
      <span class="mrow-vals">
        <Explain id={p.id} class={`mval${tone}`} label={`${p.label}: ${spoken(p.e, fmt, p.words)}`} content={p.content}>
          <MoneyNum e={p.e} format={fmt} words={p.words} />
        </Explain>
        {p.base && (
          <Explain id={p.base.id} class="mval base" label={`${p.label}, people only: ${spoken(p.base.e, fmt)}`} content={p.base.content}>
            people only{p.base.e?.flag ? ': ' : ' '}
            <MoneyNum e={p.base.e} format={fmt} lower />
          </Explain>
        )}
      </span>
    </div>
  );
}

function Baseline({ host, m, behind }: { host: Host; m: MoneyReport | null; behind: Behind }) {
  const b = m?.baseline;
  const auto = host.settings.value.economics.baseline === 'auto';
  const behindWords = behind === 'both' ? 'This crew can’t keep up either.' : 'This crew can’t keep up with these orders.';
  const content = (): ExplainContent => {
    const v = moneyView(host).value;
    const s = host.settings.value;
    const mm = v.m;
    return {
      title: 'Compared with people only',
      text: [
        s.economics.baseline === 'auto'
          ? 'Your warehouse today, without robots: the smallest crew of pickers and forklift drivers that keeps up with the same orders, in the same building.'
          : 'The people-only crew you set, running the same orders in the same building.',
        'Both plans see exactly the same orders (same seed), so the only difference is the fleet.',
        ...(mm && !mm.baseline.keepsUp
          ? [
              v.behind === 'both'
                ? 'This crew can’t keep up either, so the two can’t be compared.'
                : s.economics.baseline === 'auto'
                  ? 'Even the biggest people-only crew tried can’t keep up with these orders, so there’s no like-for-like payback. This plan keeps up.'
                  : 'The crew you set can’t keep up with these orders, so there’s no like-for-like payback. This plan keeps up.',
            ]
          : []),
      ],
      inputs: mm
        ? [
            { label: 'Pickers', value: plural(mm.baseline.picker, 'person', 'people') + ' per shift', from: s.economics.baseline === 'auto' ? 'sim' : 'user' },
            { label: 'Forklift drivers', value: plural(mm.baseline.driver, 'person', 'people') + ' per shift', from: s.economics.baseline === 'auto' ? 'sim' : 'user' },
            ...(v.b ? [{ label: 'Orders shipped by this crew', value: `${num(v.b.result.kpis.oph)} an hour`, from: 'sim' as const }] : []),
          ]
        : [],
      run: runLine(s),
      stale: v.pending,
    };
  };
  return (
    <Explain id="money-baseline" class="baseline" content={content}>
      {b ? (
        <>
          <span class="muted">Compared with:</span> {plural(b.picker, 'picker')} + {plural(b.driver, 'driver')}, people only{' '}
          <span class="muted">({auto ? 'sized to keep up with the same orders' : 'your crew'})</span>
          {!b.keepsUp && <span class="warn"> {behindWords}</span>}
        </>
      ) : (
        <span class="muted">Compared with: people only (sized to keep up with the same orders)</span>
      )}
    </Explain>
  );
}

export default definePanel({ id: 'money', slot: 'right', order: 0, title: 'Money', Component: MoneyPanel });
