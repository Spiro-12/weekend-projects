// The KPI recorder against PROTOCOL §6: a hand-built window with exact expected values, the boundaries (keeps up at
// +2%, deadlocks at 240 ticks, the demand cap), and an end-to-end run through the real runner loop on FakeSim.
import { describe, expect, it } from 'vitest';
import agentsJson from '../../../data/agents.json';
import layoutJson from '../../../data/layouts/default.json';
import scenarioJson from '../../../data/scenarios/default.json';
import {
  AGENT_STATES,
  AGENT_TYPES,
  type AgentState,
  type AgentTypeId,
  type AgentsFile,
  type LayoutFile,
  type Scenario,
  type SimEvent,
  type SimStats,
} from '../../../src/contracts/types.ts';
import { basicRecorder } from '../../../src/host/runner/basic-recorder.ts';
import { runScenario } from '../../../src/host/runner/run.ts';
import { createKpiRecorder, keepsUpAt, leastSquaresSlope, p90 } from '../../../src/kpi/index.ts';

const scenario = scenarioJson as Scenario;
const data = { agents: agentsJson as AgentsFile, layout: layoutJson as LayoutFile };
const WARMUP = 3600;
const END = WARMUP + 14_400; // 2 h window
const win = { warmupTick: WARMUP, endTick: END };

type Ticks = SimStats['ticksByState'];
const zeroTicks = (v = 0): Ticks => Object.fromEntries(AGENT_TYPES.map((t) => [t, Object.fromEntries(AGENT_STATES.map((s) => [s, v]))])) as Ticks;
function addTicks(start: Ticks, delta: Partial<Record<AgentTypeId, Partial<Record<AgentState, number>>>>): Ticks {
  const out = JSON.parse(JSON.stringify(start)) as Ticks;
  for (const [t, states] of Object.entries(delta)) for (const [st, n] of Object.entries(states!)) out[t as AgentTypeId][st as AgentState] += n!;
  return out;
}
function stats(tick: number, over: Partial<SimStats> = {}): SimStats {
  return { tick, openOrders: 0, shippedOrders: 0, ticksByState: zeroTicks(), unitsPicked: {}, fleet: { ...scenario.fleet }, ...over };
}

describe('KPI recorder: a hand-built 2 h window', () => {
  // Agent-ticks in the window per type (count × 14,400 ticks).
  const delta = {
    amr: { travel: 100_000, work: 50_000, wait: 40_000, idle: 60_000, blocked: 30_000, charge: 45_600, broken: 20_000 }, // 24 × 14,400
    forklift: { travel: 20_000, work: 10_000, idle: 20_000, blocked: 2_600, charge: 5_000 }, // 4 × 14,400
    humanoid: { travel: 5_000, work: 10_000, idle: 2_800, wait: 1_000, charge: 10_000 }, // 2 × 14,400
    picker: { travel: 80_000, work: 100_000, idle: 11_600, wait: 10_000 }, // 14 × 14,400
    driver: { travel: 10_000, work: 8_800, idle: 10_000 }, // 2 × 14,400
  };
  const startTicks = zeroTicks(1000); // whatever happened in warm-up must not count
  const events: SimEvent[] = [
    ...[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((w, i): SimEvent => ({ t: 'orderShipped', tick: 5000 + i, order: i, arrivedTick: 5000 + i - w })),
    { t: 'jamStart', tick: 4000, jam: 1, agents: [1, 2, 3], cell: 10 },
    { t: 'jamEnd', tick: 4100, jam: 1 },
    { t: 'jamStart', tick: 9000, jam: 2, agents: [4, 5, 6], cell: 20 },
    { t: 'jamStart', tick: 12000, jam: 3, agents: [7, 8, 9], cell: 30 },
    { t: 'deadlockEnd', tick: 3700, deadlock: 99 }, // started in warm-up: counts nowhere
    { t: 'deadlockStart', tick: 5000, deadlock: 1, agents: [1, 2] },
    { t: 'deadlockEnd', tick: 5240, deadlock: 1 }, // exactly 240 ticks: over 2 min
    { t: 'deadlockStart', tick: 6000, deadlock: 2, agents: [3, 4] },
    { t: 'deadlockEnd', tick: 6239, deadlock: 2 }, // 239 ticks: not over
    { t: 'deadlockStart', tick: 17_900, deadlock: 3, agents: [5, 6] }, // still open at the end: counted as over
    ...[1, 2, 3, 4].map((i): SimEvent => ({ t: 'manualReset', tick: 6000 + i, agent: i })),
    ...[1, 2, 3, 4, 5, 6].map((i): SimEvent => ({ t: 'retask', tick: 7000 + i, agent: i, goal: 5 })),
    { t: 'pickDone', tick: 7000, agent: 1, order: 1, units: 1 },
    { t: 'yield', tick: 7001, agent: 1, person: 2 },
  ];
  const rec = createKpiRecorder(scenario, win);
  rec.start(stats(WARMUP, { openOrders: 50, shippedOrders: 100, ticksByState: startTicks, unitsPicked: { picker: 1000, humanoid: 50 } }));
  rec.events(events.slice(0, 12));
  rec.sample(stats(WARMUP + 7200, { openOrders: 60, shippedOrders: 700 }));
  rec.events(events.slice(12));
  const end = stats(END, { openOrders: 70, shippedOrders: 1300, ticksByState: addTicks(startTicks, delta), unitsPicked: { picker: 1000 + 9450, humanoid: 500 } });
  rec.sample(end);
  const k = rec.finish(end); // the runner samples the last tick and then finishes with the same stats

  it('throughput and backlog', () => {
    expect(k.oph).toBe(600); // 1,200 shipped ÷ 2 h
    expect(k.backlogEnd).toBe(70);
    expect(k.backlogTrendPerHour).toBe(10); // 50 → 60 → 70 over 2 h; the repeated last tick is not a 4th point
    expect(k.keepsUp).toBe(true); // 10 ≤ 2% of 600
  });
  it('order times: mean and nearest-rank p90, in seconds', () => {
    expect(k.avgOrderSec).toBe(275); // mean 550 ticks × 0.5 s
    expect(k.p90OrderSec).toBe(450); // 9th of 10: 900 ticks
  });
  it('jams, deadlocks, resets and retasks per hour or per 8 h shift', () => {
    expect(k.jamsPerHour).toBe(1.5);
    expect(k.deadlocksPerShift).toBe(12); // 3 starts ÷ 2 h × 8
    expect(k.deadlocksOver2MinPerShift).toBe(8); // #1 (240 ticks) and #3 (still open) ÷ 2 h × 8
    expect(k.resetsPerHour).toBe(2);
    expect(k.retasksPerHour).toBe(3);
  });
  it('utilization from the ticksByState delta; broken time is not in the robot denominator', () => {
    // robots: (150,000 + 30,000 + 15,000) busy ÷ (345,600 − 20,000 broken + 57,600 + 28,800)
    expect(k.robotUtilizationPct).toBeCloseTo((195_000 * 100) / 412_000, 12);
    expect(k.byType.amr).toEqual({
      utilizationPct: (150_000 * 100) / 345_600,
      idlePct: (60_000 * 100) / 345_600,
      blockedPct: (30_000 * 100) / 345_600,
      waitPct: (40_000 * 100) / 345_600,
      chargingPct: (45_600 * 100) / 345_600,
      brokenPct: (20_000 * 100) / 345_600,
    });
    expect(k.byType.picker!.utilizationPct).toBe((180_000 * 100) / 201_600);
    for (const t of AGENT_TYPES) {
      const s = k.byType[t]!;
      expect(s.utilizationPct + s.idlePct + s.blockedPct + s.waitPct + s.chargingPct + s.brokenPct).toBeCloseTo(100, 10);
    }
  });
  it('units per picker-hour counts pickers only (not humanoids)', () => {
    expect(k.unitsPerPickerHour).toBe(9450 / 28); // 14 pickers × 2 h
  });
  it('leaves capacityOph and pickerUplift to the runner', () => {
    expect(k.capacityOph).toBeUndefined();
    expect(k.pickerUplift).toBeUndefined();
  });
});

describe('KPI recorder: boundaries', () => {
  const trendRun = (opens: number[], s: Scenario = scenario) => {
    const rec = createKpiRecorder(s, win);
    rec.start(stats(WARMUP, { openOrders: opens[0] }));
    opens.slice(1, -1).forEach((o, i) => rec.sample(stats(WARMUP + (i + 1) * 7200, { openOrders: o })));
    return rec.finish(stats(WARMUP + (opens.length - 1) * 7200, { openOrders: opens[opens.length - 1] }));
  };
  it('the trend is positive when open orders grow and exactly 0 when flat', () => {
    expect(trendRun([10, 40, 90]).backlogTrendPerHour).toBeGreaterThan(0);
    expect(trendRun([40, 40, 40]).backlogTrendPerHour).toBe(0);
    expect(trendRun([90, 40, 10]).backlogTrendPerHour).toBeLessThan(0);
  });
  it('keepsUp flips at +2% of demand per hour', () => {
    expect(trendRun([0, 12, 24]).backlogTrendPerHour).toBe(12);
    expect(trendRun([0, 12, 24]).keepsUp).toBe(true); // exactly 2% of 600
    expect(trendRun([0, 12, 25]).keepsUp).toBe(false); // 12.5
    expect(trendRun([0, 13, 26]).keepsUp).toBe(false);
    expect(trendRun([30, 20, 10]).keepsUp).toBe(true); // shrinking backlog
    const busy = { ...scenario, orders: { ...scenario.orders, perHour: 1000 } };
    expect(trendRun([0, 20, 40], busy).keepsUp).toBe(true);
    expect(trendRun([0, 20, 41], busy).keepsUp).toBe(false);
    expect(keepsUpAt(12, 600)).toBe(true);
    expect(keepsUpAt(12.000001, 600)).toBe(false);
    expect(keepsUpAt(0, 0)).toBe(true);
  });
  it('the least-squares slope is exact on integer samples', () => {
    expect(leastSquaresSlope([0, 1, 2, 3], [1, 3, 5, 7])).toBe(2);
    expect(leastSquaresSlope([0, 7200, 14400], [50, 60, 70], 7200)).toBe(10);
    expect(leastSquaresSlope([5], [5])).toBe(0);
    expect(leastSquaresSlope([], [])).toBe(0);
  });
  it('p90 is the nearest-rank 90th percentile', () => {
    expect(p90([])).toBe(0);
    expect(p90([7])).toBe(7);
    expect(p90([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toBe(9);
    expect(p90(Array.from({ length: 11 }, (_, i) => i + 1))).toBe(10);
    expect(p90(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(18);
    expect(p90(Array.from({ length: 1000 }, (_, i) => i + 1))).toBe(900);
  });
  it('oph is capped by demand in demand mode, not in saturate mode', () => {
    const run = (s: Scenario) => {
      const rec = createKpiRecorder(s, win);
      rec.start(stats(WARMUP, { shippedOrders: 0 }));
      return rec.finish(stats(END, { shippedOrders: 1300 })); // 650/h shipped (warm-up backlog cleared)
    };
    expect(run(scenario).oph).toBe(600);
    expect(run({ ...scenario, orders: { ...scenario.orders, mode: 'saturate' } }).oph).toBe(650);
  });
  it('deadlocks per shift use the scenario’s shift length', () => {
    const rec = createKpiRecorder({ ...scenario, shift: { ...scenario.shift, hoursPerShift: 10 } }, win);
    rec.start(stats(WARMUP));
    rec.events([{ t: 'deadlockStart', tick: 4000, deadlock: 1, agents: [1, 2] }]);
    expect(rec.finish(stats(END)).deadlocksPerShift).toBe(5); // 1 ÷ 2 h × 10 h
  });
  it('picker-hours follow the picker count per interval', () => {
    const rec = createKpiRecorder(scenario, win);
    rec.start(stats(WARMUP, { fleet: { ...scenario.fleet, picker: 10 }, unitsPicked: { picker: 0 } }));
    rec.sample(stats(WARMUP + 7200, { fleet: { ...scenario.fleet, picker: 10 } }));
    const k = rec.finish(stats(END, { fleet: { ...scenario.fleet, picker: 20 }, unitsPicked: { picker: 3000 } }));
    expect(k.unitsPerPickerHour).toBe(100); // 3,000 ÷ (10 × 1 h + 20 × 1 h)
  });
  it('an empty or zero-length window gives zeros, never NaN', () => {
    const rec = createKpiRecorder(scenario, win);
    rec.start(stats(WARMUP));
    const k = rec.finish(stats(WARMUP));
    for (const [name, v] of Object.entries(k)) if (typeof v === 'number') expect(Number.isFinite(v), name).toBe(true);
    expect(k.oph).toBe(0);
    expect(k.byType).toEqual({});
    expect(k.robotUtilizationPct).toBe(0);
    expect(k.unitsPerPickerHour).toBe(0);
    expect(k.keepsUp).toBe(true);
  });
  it('types with no agents are left out of byType; people never count as robots', () => {
    const rec = createKpiRecorder(scenario, win);
    rec.start(stats(WARMUP));
    const k = rec.finish(stats(END, { ticksByState: addTicks(zeroTicks(), { picker: { work: 100 }, amr: { travel: 50, broken: 50 } }) }));
    expect(Object.keys(k.byType).sort()).toEqual(['amr', 'picker']);
    expect(k.robotUtilizationPct).toBe(100); // 50 travel ÷ (100 − 50 broken)
    expect(k.byType.amr).toMatchObject({ utilizationPct: 50, brokenPct: 50 });
  });
  it('misuse fails loudly', () => {
    const rec = createKpiRecorder(scenario, win);
    expect(() => rec.finish(stats(END))).toThrow(/before start/);
    rec.start(stats(WARMUP));
    expect(() => rec.start(stats(WARMUP))).toThrow(/twice/);
  });
});

describe('KPI recorder in the real runner loop (FakeSim)', () => {
  const a = runScenario(scenario, data, createKpiRecorder);
  it('is deterministic and finite', () => {
    const b = runScenario(scenario, data, createKpiRecorder);
    expect(b.kpis).toEqual(a.kpis);
    for (const [name, v] of Object.entries(a.kpis)) if (typeof v === 'number') expect(Number.isFinite(v), name).toBe(true);
    expect(a.kpis.oph).toBeGreaterThan(0);
    expect(a.kpis.oph).toBeLessThanOrEqual(scenario.orders.perHour);
    expect(a.kpis.robotUtilizationPct).toBeGreaterThan(0);
    expect(a.kpis.robotUtilizationPct).toBeLessThanOrEqual(100);
    for (const t of AGENT_TYPES) {
      const s = a.kpis.byType[t]!;
      expect(s.utilizationPct + s.idlePct + s.blockedPct + s.waitPct + s.chargingPct + s.brokenPct).toBeCloseTo(100, 9);
    }
    expect(a.kpis.unitsPerPickerHour).toBeGreaterThan(0);
  });
  it('agrees with the lead’s basic recorder on what both measure', () => {
    const basic = runScenario(scenario, data, basicRecorder);
    expect(basic.hash).toBe(a.hash); // same sim run
    expect(a.kpis.backlogTrendPerHour).toBeCloseTo(basic.kpis.backlogTrendPerHour, 9);
    expect(a.kpis.avgOrderSec).toBeCloseTo(basic.kpis.avgOrderSec, 9);
    expect(a.kpis.backlogEnd).toBe(basic.kpis.backlogEnd);
    expect(a.kpis.oph).toBe(Math.min(basic.kpis.oph, scenario.orders.perHour));
    expect(a.kpis.keepsUp).toBe(basic.kpis.keepsUp);
  });
  it('a saturate run: the runner copies oph into capacityOph', () => {
    const c = runScenario(scenario, data, createKpiRecorder, { saturate: true });
    expect(c.kpis.capacityOph).toBe(c.kpis.oph);
  });
});
