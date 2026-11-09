// The KPI recorder (PROTOCOL §6, Track C): turns one run's stats and events into Kpis. The runner drives it:
// step to warm-up → start(stats) → loop { step 60 ticks, events(drained), sample(stats) } → finish(stats).
//
// Sim purity (PROTOCOL §8): plain arithmetic only. Counts and sums are integers; the one least-squares slope uses
// integer sums and a single division, so the same run gives the same Kpis in every JS engine.
//
// Definitions (each is what the KPI hover says):
//  - window hours = (finish tick − start tick) ÷ 7,200
//  - oph = orders shipped in the window ÷ window hours; in demand mode never above the order rate (a window can
//    ship a little more than its own arrivals by clearing warm-up backlog; that is not extra capacity)
//  - robotUtilizationPct = Σ robot (travel + work) ticks ÷ Σ robot ticks that are not 'broken'
//  - byType = each state's share of that type's agent-ticks in the window (sums to 100)
//  - jamsPerHour, resetsPerHour, retasksPerHour = event count ÷ window hours
//  - deadlocksPerShift = deadlock starts ÷ window hours × hours per shift
//  - deadlocksOver2MinPerShift = deadlocks that lasted ≥ 240 ticks (2 min) in total and were stuck at some point in
//    the window, per shift: ended ≥ 240 ticks after they started, or still open at the end and started ≥ 240 ticks
//    before it. Right after start() the runner passes the deadlockStart events from warm-up that never ended (their
//    tick is before the window); they count here from their real start tick, but not in deadlocksPerShift. A
//    deadlockEnd whose start was never seen counts if it ends ≥ 240 ticks into the window.
//  - avgOrderSec, p90OrderSec = (ship tick − arrival tick) × 0.5 s for every order shipped in the window, any
//    arrival time; p90 is the nearest-rank 90th percentile (at least 90% of orders took no longer)
//  - backlogEnd = open orders at the end; backlogTrendPerHour = least-squares slope of the open-order samples
//    (start, every sample, end); keepsUp here = trend ≤ KEEPS_UP_PCT (5%) of the order rate per hour; the runner also requires capacity ≥ demand. On saturate (capacity) runs the
//    queue is kept full by design, so keepsUp means nothing there; only demand runs say whether an option keeps up.
//  - events before the window (tick < start tick) only tell the recorder about deadlocks still open; the rest are
//    ignored
//  - unitsPerPickerHour = lines picked by pickers in the window ÷ picker-hours (picker count × time, per interval)
//  - capacityOph is set by the runner on saturate runs; pickerUplift comes from two capacity runs (./uplift.ts)
import {
  AGENT_STATES,
  AGENT_TYPES,
  ROBOT_TYPES,
  TICK_MS,
  TICKS_PER_HOUR,
  type AgentState,
  type AgentTypeId,
  type KpiRecorder,
  type KpiRecorderFactory,
  type Kpis,
  type Scenario,
  type SimEvent,
  type SimStats,
  type StateShare,
} from '../contracts/types.ts';

/** A deadlock counts as "over 2 minutes" when it lasts at least this many ticks (2 min at 0.5 s per tick). */
export const LONG_DEADLOCK_TICKS = 240;
/** Backlog part of "keeps up" (PROTOCOL §6): the 2-hour backlog trend ≤ this share of the order rate per hour (5 ⇒ 5%).
 *  The main test is capacity ≥ demand, which the runner adds from the capacity run (src/host/runner/capacity.ts): every
 *  fleet sees the same orders at one seed, but how they bunch up within the window still moves a healthy fleet's trend
 *  (measured +15.4/h on seed 99 with 12% spare capacity), so the trend alone can't tell short from unlucky. */
export const KEEPS_UP_PCT = 5;

/** Least-squares slope of y over x, times `scale`, from integer sums and one division (0 with fewer than 2 distinct x). */
export function leastSquaresSlope(xs: readonly number[], ys: readonly number[], scale = 1): number {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const den = n * sxx - sx * sx;
  return den > 0 ? ((n * sxy - sx * sy) * scale) / den : 0;
}

/** Nearest-rank 90th percentile of a list (0 for an empty list). */
export function p90(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // ceil(0.9 n) − 1, in integers.
  return sorted[Math.floor((9 * sorted.length + 9) / 10) - 1];
}

/** The backlog half of keeps-up: trend ≤ KEEPS_UP_PCT (5%) of the order rate per hour (the runner adds capacity ≥ demand). Only meaningful on demand runs (a saturate run keeps its
 *  queue full on purpose). */
export function keepsUpAt(trendPerHour: number, perHour: number): boolean {
  return trendPerHour * 100 <= KEEPS_UP_PCT * perHour;
}

type StateTicks = SimStats['ticksByState'];
const ticksOf = (t: StateTicks, type: AgentTypeId, state: AgentState) => t?.[type]?.[state] ?? 0;

function shares(start: StateTicks, end: StateTicks): { byType: Partial<Record<AgentTypeId, StateShare>>; robotUtilizationPct: number } {
  const byType: Partial<Record<AgentTypeId, StateShare>> = {};
  let robotBusy = 0;
  let robotUp = 0;
  for (const type of AGENT_TYPES) {
    const d = {} as Record<AgentState, number>;
    let total = 0;
    for (const st of AGENT_STATES) {
      d[st] = ticksOf(end, type, st) - ticksOf(start, type, st);
      total += d[st];
    }
    if ((ROBOT_TYPES as readonly AgentTypeId[]).includes(type)) {
      robotBusy += d.travel + d.work;
      robotUp += total - d.broken;
    }
    if (total <= 0) continue;
    const pct = (n: number) => (n * 100) / total;
    byType[type] = {
      utilizationPct: pct(d.travel + d.work),
      idlePct: pct(d.idle),
      blockedPct: pct(d.blocked),
      waitPct: pct(d.wait),
      chargingPct: pct(d.charge),
      brokenPct: pct(d.broken),
    };
  }
  return { byType, robotUtilizationPct: robotUp > 0 ? (robotBusy * 100) / robotUp : 0 };
}

// The window ({warmupTick, endTick}) is not needed: rates use the ticks between start() and finish(), which the
// runner makes equal to it.
export const createKpiRecorder: KpiRecorderFactory = (s: Scenario): KpiRecorder => {
  let first: SimStats | null = null;
  // Open-order samples (tick relative to the start, open orders) for the backlog trend.
  const sampleX: number[] = [];
  const sampleY: number[] = [];
  let lastTick = 0;
  let lastPickers = 0;
  let pickerTicks = 0;
  const waits: number[] = [];
  let jams = 0;
  let deadlocks = 0;
  let longDeadlocks = 0;
  const openDeadlocks = new Map<number, number>(); // deadlock id → its real start tick (warm-up starts included)
  let resets = 0;
  let retasks = 0;

  const addSample = (stats: SimStats) => {
    if (!first) throw new Error('KPI recorder: sample() or finish() before start()');
    if (sampleX.length && stats.tick <= first.tick + sampleX[sampleX.length - 1]) return; // same tick twice (last sample + finish)
    // Picker-hours: the picker count at the end of each interval × its length (exact when the fleet doesn't change).
    pickerTicks += (stats.tick - lastTick) * (stats.fleet?.picker ?? lastPickers);
    lastTick = stats.tick;
    lastPickers = stats.fleet?.picker ?? lastPickers;
    sampleX.push(stats.tick - first.tick);
    sampleY.push(stats.openOrders);
  };

  return {
    start(stats) {
      if (first) throw new Error('KPI recorder: start() called twice');
      // A copy: the window is measured as finish − start, so a sim that reuses one stats object must not move start.
      first = JSON.parse(JSON.stringify(stats)) as SimStats;
      lastTick = stats.tick;
      lastPickers = stats.fleet?.picker ?? 0;
      sampleX.push(0);
      sampleY.push(stats.openOrders);
    },
    sample(stats) {
      addSample(stats);
    },
    events(list: SimEvent[]) {
      if (!first) throw new Error('KPI recorder: events() before start()');
      const from = first.tick;
      for (const e of list) {
        if (e.tick < from) {
          // Before the window: only a deadlock still open matters (it may last past 2 minutes inside the window).
          if (e.t === 'deadlockStart') openDeadlocks.set(e.deadlock, e.tick);
          else if (e.t === 'deadlockEnd') openDeadlocks.delete(e.deadlock);
          continue;
        }
        switch (e.t) {
          case 'orderShipped':
            waits.push(e.tick - e.arrivedTick);
            break;
          case 'jamStart':
            jams++;
            break;
          case 'deadlockStart':
            deadlocks++;
            openDeadlocks.set(e.deadlock, e.tick);
            break;
          case 'deadlockEnd': {
            // A start never seen means it began before the window, so it lasted at least this far into it.
            const since = openDeadlocks.get(e.deadlock) ?? from;
            if (e.tick - since >= LONG_DEADLOCK_TICKS) longDeadlocks++;
            openDeadlocks.delete(e.deadlock);
            break;
          }
          case 'manualReset':
            resets++;
            break;
          case 'retask':
            retasks++;
            break;
          default:
            break;
        }
      }
    },
    finish(stats): Kpis {
      addSample(stats);
      const start = first!;
      const ticks = stats.tick - start.tick;
      const hours = ticks / TICKS_PER_HOUR;
      const perHour = (n: number) => (hours > 0 ? n / hours : 0);
      const shift = s.shift.hoursPerShift;

      const shipped = stats.shippedOrders - start.shippedOrders;
      let oph = perHour(shipped);
      if (s.orders.mode === 'demand' && oph > s.orders.perHour) oph = s.orders.perHour;

      const trend = leastSquaresSlope(sampleX, sampleY, TICKS_PER_HOUR);
      const sec = (t: number) => (t * TICK_MS) / 1000;
      const waitSum = waits.reduce((a, b) => a + b, 0);

      const picked = (stats.unitsPicked?.picker ?? 0) - (start.unitsPicked?.picker ?? 0);
      const pickerHours = pickerTicks / TICKS_PER_HOUR;
      const { byType, robotUtilizationPct } = shares(start.ticksByState, stats.ticksByState);
      let longOpen = 0; // still open at the end: only those already stuck for 2 minutes
      for (const since of openDeadlocks.values()) if (stats.tick - since >= LONG_DEADLOCK_TICKS) longOpen++;

      return {
        oph,
        robotUtilizationPct,
        jamsPerHour: perHour(jams),
        deadlocksPerShift: perHour(deadlocks) * shift,
        avgOrderSec: waits.length ? sec(waitSum) / waits.length : 0,
        p90OrderSec: sec(p90(waits)),
        backlogEnd: stats.openOrders,
        backlogTrendPerHour: trend,
        keepsUp: keepsUpAt(trend, s.orders.perHour),
        resetsPerHour: perHour(resets),
        retasksPerHour: perHour(retasks),
        deadlocksOver2MinPerShift: perHour(longDeadlocks + longOpen) * shift,
        unitsPerPickerHour: pickerHours > 0 ? picked / pickerHours : 0,
        byType,
      };
    },
  };
};

export { pickerUplift, explainPickerUplift } from './uplift.ts';
