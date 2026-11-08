// KPI tiles (Track F, slot `kpi`): the run's headline numbers, each hovering to how it is measured (PROTOCOL §6).
// Numbers come from the runner (host.result) and the money report (cost per order), never from the live view.
import { ROBOT_TYPES } from '../../contracts/types.ts';
import type { Host } from '../../host/index.ts';
import type { ExplainContent } from '../explain/content.ts';
import { minutes, n1, num, usd } from '../explain/format.ts';
import { kpiContent, type KpiId } from '../explain/kpi.ts';
import { moneyContent } from '../explain/money.ts';
import { Num } from '../explain/num.tsx';
import { Explain } from '../explain/popover.tsx';
import { definePanel } from '../panel.ts';
import '../panels.css';

interface TileProps {
  id: string;
  label: string;
  short: string;
  value: number | null | undefined;
  format: (v: number) => string;
  unit?: string;
  note: string;
  pending: boolean;
  warn?: boolean;
  content: () => ExplainContent;
}

function Tile(p: TileProps) {
  return (
    <Explain id={`kpi-${p.id}`} class={`card kpi${p.pending ? ' pending' : ''}${p.warn ? ' warn' : ''}`} content={p.content}>
      <span class="kpi-label">
        <span class="long">{p.label}</span>
        <span class="short">{p.short}</span>
      </span>
      <span class="kpi-value">
        <Num value={p.value} format={p.format} />
        {p.unit && p.value !== null && p.value !== undefined && <span class="kpi-unit">{p.unit}</span>}
      </span>
      <span class="kpi-note" data-testid={`kpi-${p.id}-note`}>
        {p.pending ? 'recalculating…' : p.note}
      </span>
    </Explain>
  );
}

function KpiTiles({ host }: { host: Host }) {
  const r = host.result.value;
  const k = r?.kpis;
  const s = host.settings.value;
  const pending = host.pending.value;
  const m = host.money.value;
  const moneyPending = host.moneyPending.value;
  const behind = !!k && !k.keepsUp;
  const robots = r ? ROBOT_TYPES.reduce((a, t) => a + (r.fleet[t] ?? 0), 0) : 0;
  const kc = (id: KpiId) => () => kpiContent(id, host.result.value, host.settings.value, host.data.agents);
  const cpo = m?.costPerOrder;
  const baseCpo = m?.baselineCostPerOrder;
  const costContent = (): ExplainContent => {
    const mm = host.money.value;
    if (!mm) return { title: 'Cost per order', text: [host.moneyPending.value ? 'Working out the money for these settings…' : 'The money could not be worked out for these settings.'] };
    return moneyContent('costPerOrder', mm, {
      oph: host.result.value?.kpis.oph,
      baselineOph: host.baseline.value?.result.kpis.oph,
      demand: host.settings.value.orders.perHour,
      sources: host.data.sources.sources,
      demo: host.demoData,
    });
  };
  return (
    <>
      <div class="card brand">
        <h1>Fleet Planner</h1>
        <span class="sub">{s.name}</span>
        {host.demoData && (
          <span class="badge" title="These numbers come from a placeholder model while the real simulator is being built.">
            demo data
          </span>
        )}
      </div>
      <div class="kpis">
        <Tile
          id="oph"
          label="Orders / hour"
          short="Orders/h"
          value={k?.oph}
          format={(v) => (v >= 100 ? num(v) : n1(v))}
          note={behind ? 'backlog growing' : `demand ${num(s.orders.perHour)}`}
          warn={behind}
          pending={pending}
          content={kc('oph')}
        />
        <Tile
          id="util"
          label="Robot utilization"
          short="Utilization"
          value={k && robots > 0 ? k.robotUtilizationPct : null}
          format={(v) => num(v)}
          unit="%"
          note={k && robots === 0 ? 'no robots' : 'busy time'}
          pending={pending}
          content={kc('util')}
        />
        <Tile
          id="jams"
          label="Jams"
          short="Jams/h"
          value={k?.jamsPerHour}
          format={(v) => num(v, 1)}
          unit="/h"
          note={k ? `${n1(k.deadlocksPerShift)} deadlocks/shift` : 'deadlocks/shift'}
          pending={pending}
          content={kc('jams')}
        />
        <Tile
          id="order-time"
          label="Avg order time"
          short="Order time"
          value={k ? k.avgOrderSec / 60 : undefined}
          format={(v) => minutes(v * 60)}
          unit="min"
          note={k ? `90% within ${minutes(k.p90OrderSec)} min` : 'arrive → ship'}
          pending={pending}
          content={kc('order-time')}
        />
        <Tile
          id="cost"
          label="Cost per order"
          short="Cost/order"
          value={cpo && !cpo.flag ? cpo.value : null}
          format={(v) => usd(v)}
          note={
            cpo?.flag
              ? 'not available'
              : baseCpo && baseCpo.value !== null && !baseCpo.flag
                ? `people only ${usd(baseCpo.value)}`
                : !m && !moneyPending
                  ? 'not available'
                  : 'people only —'
          }
          pending={pending || moneyPending}
          content={costContent}
        />
      </div>
    </>
  );
}

export default definePanel({ id: 'kpi', slot: 'kpi', order: 0, title: 'KPIs', Component: KpiTiles });
