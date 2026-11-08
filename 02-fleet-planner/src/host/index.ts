// The host: app-level state shared by the renderer and the panels (PROTOCOL §9). Lead-owned.
// Settings (a full Scenario) live in a signal; every change goes to the live sim as a command AND to the runner,
// whose RunResult feeds the KPI tiles and the money panel.
import { signal, type Signal } from '@preact/signals';
import type { AgentTypeId, AgentsFile, LayoutFile, RunResult, Scenario, SourcesFile, TrafficMode } from '../contracts/types.ts';
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

export function createHost(data: AppData, runner: Runner, opts: { scenario?: string; seed?: number; impl?: SimImpl } = {}): Host {
  const first = data.scenarios[opts.scenario ?? 'default'] ?? data.scenarios.default;
  const start: Scenario = opts.seed !== undefined ? { ...first, seed: opts.seed } : first;
  const bus = new Bus<HostEvents>();
  const settings = signal(start);
  const result = signal<RunResult | null>(null);
  const pending = signal(false);
  const selected = signal<{ side: 0 | 1; agentId: number } | null>(null);
  const speed = signal(1);
  const paused = signal(false);
  const simData = (s: Scenario) => ({ agents: data.agents, layout: data.layouts[s.layout] });
  const live = new LiveSim(start, simData(start), opts.impl);

  let runToken = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const recalc = () => {
    const s = settings.value;
    const cached = runner.peek(s);
    if (cached) {
      result.value = cached;
      pending.value = false;
      return;
    }
    pending.value = true;
    clearTimeout(timer);
    const token = ++runToken;
    timer = setTimeout(() => {
      runner
        .evaluate(s)
        .then((r) => {
          if (token !== runToken) return;
          result.value = r;
          pending.value = false;
        })
        .catch((e) => {
          console.error('[runner] evaluate failed', e);
          if (token === runToken) pending.value = false;
        });
    }, 250);
  };

  const update = (next: Scenario) => {
    if (settingsHash(next) === settingsHash(settings.value)) return;
    settings.value = next;
    recalc();
  };

  const host: Host = {
    data,
    bus,
    runner,
    demoData: runner.kind === 'fake',
    settings,
    result,
    pending,
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
      settings.value = s;
      if (layoutChanged) {
        const next = new LiveSim(s, simData(s), opts.impl);
        host.live = next;
        bus.emit('layoutChanged', { layout: data.layouts[s.layout] });
      } else host.live.reset(s);
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
