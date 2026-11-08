// Minimal KPI recorder (lead, Phase 0) so the runner works end to end before Track C's recorder lands.
// Only orders/hour, backlog trend and keeps-up are real here; the rest are zeros. Replaced at Phase 1 integration.
import { keepsUpAt } from '../../kpi/index.ts';
import type { KpiRecorderFactory, Kpis, SimStats } from '../../contracts/types.ts';
import { TICKS_PER_HOUR } from '../../contracts/types.ts';

export const basicRecorder: KpiRecorderFactory = (s, w) => {
  let first: SimStats | null = null;
  const samples: { t: number; open: number }[] = [];
  const waits: number[] = [];
  return {
    start(stats) {
      first = stats;
      samples.push({ t: stats.tick, open: stats.openOrders });
    },
    sample(stats) {
      samples.push({ t: stats.tick, open: stats.openOrders });
    },
    events(list) {
      for (const e of list) if (e.t === 'orderShipped') waits.push(e.tick - e.arrivedTick);
    },
    finish(stats): Kpis {
      const hours = (w.endTick - w.warmupTick) / TICKS_PER_HOUR;
      const shipped = stats.shippedOrders - (first?.shippedOrders ?? 0);
      const n = samples.length;
      const mt = samples.reduce((a, x) => a + x.t, 0) / n;
      const mo = samples.reduce((a, x) => a + x.open, 0) / n;
      const cov = samples.reduce((a, x) => a + (x.t - mt) * (x.open - mo), 0);
      const varT = samples.reduce((a, x) => a + (x.t - mt) * (x.t - mt), 0) || 1;
      const trend = (cov / varT) * TICKS_PER_HOUR;
      const sorted = [...waits].sort((a, b) => a - b);
      const avg = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length / 2 : 0;
      return {
        oph: shipped / hours,
        robotUtilizationPct: 0,
        jamsPerHour: 0,
        deadlocksPerShift: 0,
        avgOrderSec: avg,
        p90OrderSec: sorted.length ? sorted[Math.floor(sorted.length * 0.9)] / 2 : 0,
        backlogEnd: stats.openOrders,
        backlogTrendPerHour: trend,
        keepsUp: keepsUpAt(trend, s.orders.perHour),
        resetsPerHour: 0,
        retasksPerHour: 0,
        deadlocksOver2MinPerShift: 0,
        unitsPerPickerHour: 0,
        byType: {},
      };
    },
  };
};
