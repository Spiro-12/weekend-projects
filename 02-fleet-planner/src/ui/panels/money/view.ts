// The money panel's view of the host (Track F): the money report together with the run, baseline and demand it was
// computed from. While the money is recalculating, the host already holds the NEW run result but still the OLD
// report; reading both would mix two different settings (e.g. "can't keep up" from the new run next to the old
// payback). So the view only moves forward once the report is settled, and says `pending` meanwhile.
import { computed, type ReadonlySignal } from '@preact/signals';
import type { MoneyReport, RunResult } from '../../../contracts/types.ts';
import type { Host } from '../../../host/index.ts';
import { whoIsBehind, type Behind, type MoneyCtx } from '../../explain/money.ts';

export interface MoneyView {
  m: MoneyReport | null;
  /** The candidate run the report was computed from. */
  r: RunResult | null;
  /** The people-only run and crew it compared against. */
  b: { crew: { picker: number; driver: number }; result: RunResult } | null;
  demand: number;
  behind: Behind;
  pending: boolean;
}

const views = new WeakMap<Host, ReadonlySignal<MoneyView>>();

export function moneyView(host: Host): ReadonlySignal<MoneyView> {
  let v = views.get(host);
  if (v) return v;
  let settled: Omit<MoneyView, 'pending'> = { m: null, r: null, b: null, demand: host.settings.peek().orders.perHour, behind: null };
  v = computed(() => {
    const pending = host.moneyPending.value;
    const m = host.money.value;
    const r = host.result.value;
    const b = host.baseline.value;
    const demand = host.settings.value.orders.perHour;
    if (!pending) settled = { m, r, b, demand, behind: m ? whoIsBehind(m, r?.kpis.keepsUp) : null };
    return { ...settled, pending };
  });
  views.set(host, v);
  return v;
}

/** Context for the money hovers, from the same consistent view. */
export function moneyCtx(host: Host, v: MoneyView): MoneyCtx {
  return {
    oph: v.r?.kpis.oph,
    baselineOph: v.b?.result.kpis.oph,
    demand: v.demand,
    planKeepsUp: v.r?.kpis.keepsUp,
    sources: host.data.sources.sources,
    demo: host.demoData,
    stale: v.pending,
  };
}
