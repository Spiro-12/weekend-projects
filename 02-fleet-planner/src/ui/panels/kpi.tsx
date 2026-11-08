// KPI tiles. Phase 0 (lead) version on the fake runner; Track F replaces this file in Phase 1.
import type { Host } from '../../host/index.ts';
import { definePanel } from '../panel.ts';

function fmt(n: number | undefined, digits = 0): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function KpiTiles({ host }: { host: Host }) {
  const r = host.result.value;
  const k = r?.kpis;
  const s = host.settings.value;
  const pending = host.pending.value;
  const tiles = [
    { id: 'oph', label: 'Orders / hour', value: fmt(k?.oph), unit: '', note: `demand ${fmt(s.orders.perHour)}` },
    { id: 'util', label: 'Robot utilization', value: fmt(k?.robotUtilizationPct), unit: '%', note: 'busy time' },
    { id: 'jams', label: 'Jams', value: fmt(k?.jamsPerHour, 1), unit: '/h', note: `${fmt(k?.deadlocksPerShift)} deadlocks / shift` },
    { id: 'order-time', label: 'Avg order time', value: k ? fmt(k.avgOrderSec / 60, 1) : '—', unit: 'min', note: k?.keepsUp === false ? 'backlog growing' : 'arrive → ship' },
  ];
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
      <div class="tiles">
        {tiles.map((t) => (
          <div key={t.id} class={`card tile${pending ? ' pending' : ''}`} data-testid={`kpi-${t.id}`}>
            <div class="label">{t.label}</div>
            <div class="value">
              {t.value}
              <span class="unit">{t.unit}</span>
            </div>
            <div class="note">{t.note}</div>
          </div>
        ))}
      </div>
    </>
  );
}

export default definePanel({ id: 'kpi', slot: 'kpi', order: 0, title: 'KPIs', Component: KpiTiles });
