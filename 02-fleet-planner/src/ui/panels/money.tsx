// Money panel (Track F, slot `right`): when do the robots pay back, compared with doing it with people only.
// Every number hovers (taps on phones) to its formula with the real numbers, its inputs and their sources.
// Flags are words, never numbers. While the money is recalculating the numbers dim; after a failure none are shown.
import { ROBOT_TYPES, type Explained, type MoneyLine, type MoneyReport } from '../../contracts/types.ts';
import type { Host } from '../../host/index.ts';
import { FLAG_WORDS, runLine, typeCount, type ExplainContent } from '../explain/content.ts';
import { monthsShort, num, plural, usd, usdShort, yearsFromMonths } from '../explain/format.ts';
import { lineContent, moneyContent, type MoneyCtx, type MoneyKey } from '../explain/money.ts';
import { Num } from '../explain/num.tsx';
import { Explain } from '../explain/popover.tsx';
import { definePanel } from '../panel.ts';
import '../panels.css';

const ok = (e: Explained | undefined): number | null => (e && !e.flag && e.value !== null ? e.value : null);

/** A money number: flag words when flagged (never a number), a dash when hidden or missing, else the tweened value. */
function MoneyNum({ e, format, hide }: { e: Explained | undefined; format: (v: number) => string; hide?: boolean }) {
  if (e?.flag) return <span class="flag-words small">{FLAG_WORDS[e.flag]}</span>;
  if (hide) return <>—</>;
  return <Num value={ok(e)} format={format} />;
}

function MoneyPanel({ host }: { host: Host }) {
  const m = host.money.value;
  const pending = host.moneyPending.value;
  const s = host.settings.value;
  const r = host.result.value;
  const runPending = host.pending.value;
  const financing = s.economics.financing;
  const ctx = (): MoneyCtx => ({
    oph: host.result.value?.kpis.oph,
    baselineOph: host.baseline.value?.result.kpis.oph,
    demand: host.settings.value.orders.perHour,
    sources: host.data.sources.sources,
    demo: host.demoData,
  });
  const waiting = (title: string): ExplainContent => ({
    title,
    text: [host.moneyPending.value ? 'Working out the money for these settings…' : 'The money could not be worked out for these settings. Change a setting to try again.'],
  });
  const explain = (key: MoneyKey, title: string) => () => {
    const mm = host.money.value;
    if (!mm) return waiting(title);
    const c = moneyContent(key, mm, ctx());
    const k = host.result.value?.kpis;
    if ((key === 'threeYearNet' || key === 'savingsYear') && !mm[key].flag && (k?.keepsUp === false || mm.paybackMonths.flag === 'doesntKeepUp'))
      c.text = [
        'Not shown on the panel: this plan can’t keep up with the orders, so it looks cheaper only because it ships fewer of them. The math is below for reference.',
        ...(c.text ?? []),
      ];
    return c;
  };
  const explainLine = (type: MoneyLine['type'], part: 'capex' | 'opexYear') => () => {
    const line = host.money.value?.lines.find((l) => l.type === type);
    return line ? lineContent(line, part, ctx(), host.settings.value.economics.financing) : waiting('By type');
  };

  const pb = m?.paybackMonths;
  const pbValue = ok(pb);
  const net = ok(m?.threeYearNet);
  const keepsUp = r?.kpis.keepsUp ?? true;
  // A plan that can't keep up looks cheaper only because it ships fewer orders: its savings are not shown as numbers.
  const unfair = !keepsUp || pb?.flag === 'doesntKeepUp';
  const lines = (m?.lines ?? []).filter((l) => l.count > 0);
  const failed = !m && !pending;

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
        {pending ? (runPending || !m ? 'Working it out…' : 'Recalculating…') : failed ? 'Couldn’t work out the money for these settings. Change a setting to try again.' : ''}
      </div>
      {r && !keepsUp && !runPending && (
        <div class="money-flag" data-testid="money-keepsup">
          <b>{FLAG_WORDS.doesntKeepUp}.</b> This plan ships {num(r.kpis.oph)} of the {num(s.orders.perHour)} orders coming in each hour, so orders pile up.
        </div>
      )}

      <div class="hero">
        <div class="hero-item">
          <div class="hero-label">Pays back in</div>
          <Explain id="money-payback" class={`hero-num${pb?.flag ? ' flagged' : ''}`} content={explain('paybackMonths', 'Pays back in')}>
            {pb?.flag ? (
              <span class="flag-words">{FLAG_WORDS[pb.flag]}</span>
            ) : pb && pbValue === null ? (
              <span class="flag-words">No payback date</span>
            ) : (
              <>
                <Num value={pbValue} format={monthsShort} />
                <span class="hero-unit">{pbValue === 1 ? 'month' : 'months'}</span>
              </>
            )}
          </Explain>
          <div class="hero-sub">
            {pbValue !== null ? (
              <>
                {yearsFromMonths(pbValue)} · <span class={pbValue <= 36 ? 'good' : 'warn'}>{pbValue <= 36 ? 'within' : 'over'} the 3 years most buyers want</span>
              </>
            ) : pb?.flag === 'never' ? (
              'it costs more each year than people only'
            ) : pb?.flag === 'doesntKeepUp' ? (
              'add robots or people until it keeps up'
            ) : (
              ' '
            )}
          </div>
        </div>
        <div class="hero-item">
          <div class="hero-label">Net savings, 3 years</div>
          <Explain
            id="money-3yr"
            class={`hero-num${m?.threeYearNet.flag ? ' flagged' : unfair ? ' unfair' : net !== null && net < 0 ? ' neg' : ''}`}
            content={explain('threeYearNet', 'Net savings over 3 years')}
          >
            {m?.threeYearNet.flag ? <span class="flag-words">{FLAG_WORDS[m.threeYearNet.flag]}</span> : unfair ? '—' : <Num value={net} format={usdShort} />}
          </Explain>
          <div class="hero-sub">
            {m?.threeYearNet.flag === 'doesntKeepUp' || unfair
              ? 'shown once the plan keeps up'
              : m?.threeYearNet.flag === 'never'
                ? 'it costs more each year than people only'
                : net !== null && net < 0
                  ? 'you lose money over 3 years'
                  : 'after paying for the robots'}
          </div>
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
        <MoneyRow label="Savings per year" id="money-savings" e={m?.savingsYear} content={explain('savingsYear', 'Savings per year')} tone hide={unfair} />
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
            <Explain id={`money-line-${l.type}-capex`} class="mval" content={explainLine(l.type, 'capex')}>
              <MoneyNum e={l.capex} format={usdShort} />
            </Explain>
            <Explain id={`money-line-${l.type}-opex`} class="mval" content={explainLine(l.type, 'opexYear')}>
              <MoneyNum e={l.opexYear} format={usdShort} />
            </Explain>
          </div>
        ))}
      </div>

      <Baseline host={host} m={m} />
    </div>
  );
}

function MoneyRow(p: {
  label: string;
  id: string;
  e: Explained | undefined;
  content: () => ExplainContent;
  exact?: boolean;
  tone?: boolean;
  /** Show a dash instead of the number (the hover still has the math). */
  hide?: boolean;
  base?: { id: string; e: Explained | undefined; content: () => ExplainContent };
}) {
  const fmt = p.exact ? usd : usdShort;
  const v = ok(p.e);
  const tone = p.hide ? ' unfair' : p.tone && v !== null ? (v > 0 ? ' good' : v < 0 ? ' bad' : '') : '';
  return (
    <div class="mrow">
      <span class="mrow-label">{p.label}</span>
      <span class="mrow-vals">
        <Explain id={p.id} class={`mval${tone}`} content={p.content}>
          <MoneyNum e={p.e} format={fmt} hide={p.hide} />
        </Explain>
        {p.base && (
          <Explain id={p.base.id} class="mval base" content={p.base.content}>
            people only <MoneyNum e={p.base.e} format={fmt} />
          </Explain>
        )}
      </span>
    </div>
  );
}

function Baseline({ host, m }: { host: Host; m: MoneyReport | null }) {
  const b = m?.baseline;
  const auto = host.settings.value.economics.baseline === 'auto';
  const content = (): ExplainContent => {
    const mm = host.money.value;
    const base = host.baseline.value;
    const s = host.settings.value;
    return {
      title: 'Compared with people only',
      text: [
        s.economics.baseline === 'auto'
          ? 'Your warehouse today, without robots: the smallest crew of pickers and forklift drivers that keeps up with the same orders, in the same building.'
          : 'The people-only crew you set, running the same orders in the same building.',
        'Both plans see exactly the same orders (same seed), so the only difference is the fleet.',
        ...(mm && !mm.baseline.keepsUp ? ['This crew can’t keep up either, so the comparison is not fair.'] : []),
      ],
      inputs: mm
        ? [
            { label: 'Pickers', value: plural(mm.baseline.picker, 'person', 'people') + ' per shift', from: s.economics.baseline === 'auto' ? 'sim' : 'user' },
            { label: 'Forklift drivers', value: plural(mm.baseline.driver, 'person', 'people') + ' per shift', from: s.economics.baseline === 'auto' ? 'sim' : 'user' },
            ...(base ? [{ label: 'Orders shipped by this crew', value: `${num(base.result.kpis.oph)} an hour`, from: 'sim' as const }] : []),
          ]
        : [],
      run: runLine(s),
    };
  };
  return (
    <Explain id="money-baseline" class="baseline" content={content}>
      {b ? (
        <>
          <span class="muted">Compared with:</span> {plural(b.picker, 'picker')} + {plural(b.driver, 'driver')}, people only{' '}
          <span class="muted">({auto ? 'sized to keep up with the same orders' : 'your crew'})</span>
          {!b.keepsUp && <span class="warn"> This crew can’t keep up either.</span>}
        </>
      ) : (
        <span class="muted">Compared with: people only (sized to keep up with the same orders)</span>
      )}
    </Explain>
  );
}

export default definePanel({ id: 'money', slot: 'right', order: 0, title: 'Money', Component: MoneyPanel });
