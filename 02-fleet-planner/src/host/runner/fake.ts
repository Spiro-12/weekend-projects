// Fake runner (PROTOCOL §11): instant, plausible numbers from a closed-form toy model, so UI tracks and the Phase 0
// skeleton work before the real sim and KPI code exist. Everything it returns is "demo data" and the UI says so.
// The toy model has the right shape for sanity checks (0 robots → no robot cost elsewhere; past saturation more
// robots don't help; overload → backlog grows), but none of its numbers are evidence.
import { AGENT_TYPES, type AgentState, type AgentTypeId, type Kpis, type RunResult, type Scenario, type StateShare } from '../../contracts/types.ts';
import { settingsHash } from '../settings.ts';
import type { EvaluateOptions, Runner } from './types.ts';

function meanLines(w: number[]): number {
  const total = w.reduce((a, b) => a + b, 0) || 1;
  return w.reduce((a, b, i) => a + b * (i + 1), 0) / total;
}

export function fakeEvaluate(s: Scenario, opts: EvaluateOptions = {}): RunResult {
  const f = s.fleet;
  const lines = meanLines(s.orders.linesWeights);
  const siloed = s.traffic.mode !== 'central';
  // Picking: people pick 75 units/h; cart robots raise that toward 1.8x when there are ~3 per picker.
  const robotsPerPicker = f.picker > 0 ? f.amr / f.picker : 0;
  const uplift = 1 + 0.8 * Math.min(1, robotsPerPicker / 3);
  const humanoidRate = 37.5 * 0.67;
  // Congestion: more vehicles in the same aisles slow everyone; worse with many brains.
  const vehicles = f.amr + f.forklift + f.humanoid + f.picker + f.driver;
  const congestion = 1 / (1 + Math.pow(vehicles / (siloed ? 70 : 140), 2));
  const pickUnits = (f.picker * 75 * uplift + f.humanoid * humanoidRate) * congestion;
  const pickCap = pickUnits / lines;
  // Pallets: one replenishment per N lines plus inbound.
  const palletCap = f.forklift * 12 * congestion + f.driver * 20 * congestion;
  const palletNeedPerOrder = lines / s.pallets.linesPerReplenish;
  const palletLimitedCap = palletNeedPerOrder > 0 ? Math.max(0, palletCap - s.pallets.inboundPerHour) / palletNeedPerOrder : Infinity;
  const packCap = (s.pack.stations * 3600) / s.pack.secPerOrder;
  const capacity = Math.max(0, Math.min(pickCap, palletLimitedCap, packCap));
  const demand = opts.saturate || s.orders.mode === 'saturate' ? capacity : s.orders.perHour;
  const oph = Math.min(demand, capacity);
  const keepsUp = capacity >= demand * 0.98;
  const load = capacity > 0 ? Math.min(1, demand / capacity) : 1;
  const util = (base: number) => Math.round(100 * base * load * (siloed ? 0.75 : 1));
  const share = (u: number, blocked: number, charge: number): StateShare => ({
    utilizationPct: u,
    idlePct: Math.max(0, 100 - u - blocked - charge - 5),
    blockedPct: blocked,
    waitPct: 5,
    chargingPct: charge,
    brokenPct: 0,
  });
  const robots = f.amr + f.forklift + f.humanoid;
  const byType: Partial<Record<AgentTypeId, StateShare>> = {};
  if (f.amr) byType.amr = share(util(0.72), siloed ? 18 : 4, 9);
  if (f.forklift) byType.forklift = share(util(0.6), siloed ? 15 : 3, 14);
  if (f.humanoid) byType.humanoid = share(util(0.55), siloed ? 12 : 3, 33);
  if (f.picker) byType.picker = share(util(0.8), 2, 0);
  if (f.driver) byType.driver = share(util(0.7), 2, 0);
  const robotUtil =
    robots > 0 ? Math.round(((byType.amr?.utilizationPct ?? 0) * f.amr + (byType.forklift?.utilizationPct ?? 0) * f.forklift + (byType.humanoid?.utilizationPct ?? 0) * f.humanoid) / robots) : 0;
  const avgOrderSec = Math.round(240 + 600 * Math.pow(load, 4) + (siloed ? 120 : 0));
  const kpis: Kpis = {
    oph: Math.round(oph * 10) / 10,
    capacityOph: Math.round(capacity * 10) / 10,
    robotUtilizationPct: robotUtil,
    jamsPerHour: Math.round(vehicles * vehicles * (siloed ? 0.004 : 0.0008) * 10) / 10,
    deadlocksPerShift: siloed ? Math.round(robots * 0.3) : 0,
    avgOrderSec,
    p90OrderSec: Math.round(avgOrderSec * 1.8),
    backlogEnd: keepsUp ? Math.round(demand * 0.15) : Math.round((demand - capacity) * (s.run.measureMin / 60) + demand * 0.15),
    backlogTrendPerHour: keepsUp ? 0 : Math.round(demand - capacity),
    keepsUp,
    pickerUplift: f.amr > 0 && f.picker > 0 ? Math.round(uplift * 100) / 100 : undefined,
    resetsPerHour: siloed ? Math.round(robots * 0.02 * 10) / 10 : 0,
    unitsPerPickerHour: f.picker > 0 ? Math.round(75 * uplift * congestion) : 0,
    byType,
  };
  return {
    scenarioId: s.id,
    settingsHash: settingsHash(s) + (opts.saturate ? '-sat' : ''),
    kpis,
    fleet: { ...s.fleet },
    traffic: s.traffic.mode,
    hash: 'fake',
    ticks: (s.run.warmupMin + s.run.measureMin) * 120,
    simMs: 0,
  };
}

export function createFakeRunner(delayMs = 0): Runner {
  const cache = new Map<string, RunResult>();
  const key = (s: Scenario, o?: EvaluateOptions) => settingsHash(s) + (o?.saturate ? '-sat' : '');
  return {
    kind: 'fake',
    async evaluate(s, opts) {
      const k = key(s, opts);
      const hit = cache.get(k);
      if (hit) return hit;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const r = fakeEvaluate(s, opts);
      cache.set(k, r);
      return r;
    },
    peek: (s, opts) => cache.get(key(s, opts)),
    dispose: () => cache.clear(),
  };
}

/** All agent states, for code that needs to iterate them. */
export const STATES: readonly AgentState[] = ['idle', 'travel', 'work', 'wait', 'blocked', 'charge', 'broken'];
export const TYPES = AGENT_TYPES;
