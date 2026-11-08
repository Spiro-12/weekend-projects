// The host: app-level state shared by the renderer and the panels (PROTOCOL §9). Lead-owned.
// Settings (a full Scenario) live in a signal; every change goes to the live sim as a command AND to the runner,
// whose RunResult feeds the KPI tiles and the money panel.
import { signal, type Signal } from '@preact/signals';
import type { AgentTypeId, AgentsFile, LayoutFile, MoneyReport, RunResult, Scenario, SourcesFile, TrafficMode } from '../contracts/types.ts';
import { fakeEcon, type EconPort } from './econ-port.ts';
import { Bus } from './bus.ts';
import { LiveSim } from './live.ts';
import type { Runner } from './runner/types.ts';
import { peopleOnly, settingsHash, withFleet } from './settings.ts';
import type { SimImpl } from '../sim/index.ts';

export interface AppData {
  agents: AgentsFile;
  sources: SourcesFile;
  layouts: Record<string, LayoutFile>;
  scenarios: Record<string, Scenario>;
}

export type Tier = 'high' | 'medium' | 'low' | 'lite';

export type HostEvents = {
  select: { side: 0 | 1; agentId: number | null };
  tier: Tier;
  firstUsefulView: { ms: number };
  fullLook: { ms: number };
  layoutChanged: { layout: LayoutFile };
};

export interface Host {
  data: AppData;
  bus: Bus<HostEvents>;
  runner: Runner;
  /** True while numbers come from the fake runner (the UI shows "demo data"). */
  demoData: boolean;
  settings: Signal<Scenario>;
  result: Signal<RunResult | null>;
  pending: Signal<boolean>;
  /** People-only comparison run (auto-sized crew unless the user set one). */
  baseline: Signal<{ crew: { picker: number; driver: number }; result: RunResult } | null>;
  /** Money panel numbers for the current settings vs the baseline. */
  money: Signal<MoneyReport | null>;
  /** True while the money report is being recomputed (it can lag the KPI result: the baseline search runs after). */
  moneyPending: Signal<boolean>;
  selected: Signal<{ side: 0 | 1; agentId: number } | null>;
  speed: Signal<number>;
  paused: Signal<boolean>;
  live: LiveSim;
  setFleet(type: AgentTypeId, count: number): void;
  peopleOnly(): void;
  setOrderRate(perHour: number): void;
  setTraffic(mode: TrafficMode): void;
  setFinancing(f: 'buy' | 'raas'): void;
  setScenario(id: string): void;
  setSpeed(x: number): void;
  setPaused(p: boolean): void;
  select(side: 0 | 1, agentId: number | null): void;
}

export function createHost(data: AppData, runner: Runner, opts: { scenario?: string; seed?: number; impl?: SimImpl; econ?: EconPort | (() => Promise<EconPort>); demo?: boolean } = {}): Host {
  // The economics may be loaded lazily (the app does, to keep it out of the first-view JS): money waits for it.
  let econP: Promise<EconPort> | undefined;
  const loadEcon = (): Promise<EconPort> => {
    if (econP) return econP;
    const p = typeof opts.econ === 'function' ? opts.econ() : Promise.resolve(opts.econ ?? fakeEcon);
    // A failed load (e.g. the chunk didn't download) is forgotten, so the next settings change tries again.
    econP = p.catch((e) => {
      econP = undefined;
      throw e;
    });
    return econP;
  };
  // Start fetching it now, alongside the first run, rather than after it.
  loadEcon().catch(() => {});
  const first = data.scenarios[opts.scenario ?? 'default'] ?? data.scenarios.default;
  const start: Scenario = opts.seed !== undefined ? { ...first, seed: opts.seed } : first;
  const bus = new Bus<HostEvents>();
  const settings = signal(start);
  const result = signal<RunResult | null>(null);
  const pending = signal(false);
  const baseline = signal<{ crew: { picker: number; driver: number }; result: RunResult } | null>(null);
  const money = signal<MoneyReport | null>(null);
  const moneyPending = signal(true);
  const selected = signal<{ side: 0 | 1; agentId: number } | null>(null);
  const speed = signal(1);
  const paused = signal(false);
  const simData = (s: Scenario) => ({ agents: data.agents, layout: data.layouts[s.layout] });
  const live = new LiveSim(start, simData(start), opts.impl);

  let runToken = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The baseline only depends on the settings that aren't the fleet; cache by that key.
  const baselineCache = new Map<string, Promise<{ crew: { picker: number; driver: number }; result: RunResult }>>();
  const baselineKey = (s: Scenario) => settingsHash({ ...s, fleet: { amr: 0, forklift: 0, humanoid: 0, picker: 0, driver: 0 }, traffic: { ...s.traffic, mode: 'central' }, economics: { ...s.economics, financing: 'buy' } });
  const updateMoney = async (s: Scenario, r: RunResult, token: number) => {
    moneyPending.value = true;
    const key = baselineKey(s);
    let p = baselineCache.get(key);
    if (!p) {
      p = loadEcon().then((e) => e.findBaseline(s, runner));
      baselineCache.set(key, p);
    }
    try {
      const b = await p;
      const econ = await loadEcon();
      if (token !== runToken) return;
      baseline.value = b;
      money.value = econ.computeMoney({ scenario: s, agents: data.agents, candidate: r, baseline: b.result, baselineCrew: b.crew });
    } catch (e) {
      // A failed baseline search is not cached: the next change retries it. Never show the old settings' money.
      baselineCache.delete(key);
      if (token === runToken) money.value = null;
      console.error('[money] baseline or money failed', e);
    } finally {
      if (token === runToken) moneyPending.value = false;
    }
  };
  const recalc = () => {
    const s = settings.value;
    const token = ++runToken;
    moneyPending.value = true;
    const cached = runner.peek(s);
    if (cached) {
      result.value = cached;
      pending.value = false;
      void updateMoney(s, cached, token);
      return;
    }
    pending.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      runner
        .evaluate(s)
        .then((r) => {
          if (token !== runToken) return;
          result.value = r;
          pending.value = false;
          return updateMoney(s, r, token);
        })
        .catch((e) => {
          console.error('[runner] evaluate failed', e);
          if (token === runToken) {
            pending.value = false;
            moneyPending.value = false;
            money.value = null;
          }
        });
    }, 250);
  };

  const update = (next: Scenario) => {
    // Economics-only changes (buy/rent) hit the run cache, so only the money is recomputed.
    if (settingsHash(next) === settingsHash(settings.value)) return;
    settings.value = next;
    recalc();
  };

  const host: Host = {
    data,
    bus,
    runner,
    demoData: opts.demo ?? runner.kind === 'fake',
    settings,
    result,
    pending,
    baseline,
    money,
    moneyPending,
    selected,
    speed,
    paused,
    live,
    setFleet(type, count) {
      const next = withFleet(settings.value, type, count);
      host.live.command({ t: 'setFleet', type, count: next.fleet[type] });
      update(next);
    },
    peopleOnly() {
      const next = peopleOnly(settings.value);
      for (const t of ['amr', 'forklift', 'humanoid'] as const) host.live.command({ t: 'setFleet', type: t, count: 0 });
      update(next);
    },
    setOrderRate(perHour) {
      const p = Math.max(0, Math.min(28_800, Math.round(perHour)));
      host.live.command({ t: 'setOrderRate', perHour: p });
      update({ ...settings.value, orders: { ...settings.value.orders, perHour: p } });
    },
    setTraffic(mode) {
      host.live.command({ t: 'setTraffic', mode });
      update({ ...settings.value, traffic: { ...settings.value.traffic, mode } });
    },
    setFinancing(f) {
      update({ ...settings.value, economics: { ...settings.value.economics, financing: f } });
    },
    setScenario(id) {
      const s = data.scenarios[id];
      if (!s) return;
      const layoutChanged = s.layout !== settings.value.layout;
      host.select(0, null);
      settings.value = s;
      host.live.reset(s, simData(s));
      if (layoutChanged) bus.emit('layoutChanged', { layout: data.layouts[s.layout] });
      recalc();
    },
    setSpeed(x) {
      speed.value = x;
      host.live.speed = x;
    },
    setPaused(p) {
      paused.value = p;
      host.live.paused = p;
    },
    select(side, agentId) {
      selected.value = agentId === null ? null : { side, agentId };
      bus.emit('select', { side, agentId });
    },
  };
  recalc();
  return host;
}
