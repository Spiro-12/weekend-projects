// Fleet Planner entry (lead-owned). Boots data → host → renderer → world → agents → panels, then exposes window.__fp.
import '../ui/styles.css';
import { Fog, Raycaster, Vector2 } from 'three';
import agents from '../../data/agents.json';
import sources from '../../data/sources.json';
import type { AgentsFile, LayoutFile, Scenario, SourcesFile } from '../contracts/types.ts';
import { createHost, type AppData } from '../host/index.ts';
import { createSim } from '../sim/index.ts';
import { createFakeRunner } from '../host/runner/fake.ts';
import { createWorkerRunner } from '../host/runner/pool.ts';
import { createAgentLayer } from '../render/agents/index.ts';
import type { AgentLayer, WorldLayer } from '../render/core/layers.ts';
import { CameraRig, type Pose } from '../render/core/camera.ts';
import { makeTours, TOURS } from '../render/core/tours.ts';
import { createRenderer } from '../render/core/renderer.ts';
import { createWorldLayer } from '../render/world/index.ts';
import { readParams } from '../ui/params.ts';
import { mountShell } from '../ui/shell.tsx';
import type { FpHooks } from './hooks.ts';

const layoutMods = import.meta.glob<{ default: LayoutFile }>('../../data/layouts/*.json', { eager: true });
const scenarioMods = import.meta.glob<{ default: Scenario }>('../../data/scenarios/*.json', { eager: true });
const byId = <T extends { id: string }>(mods: Record<string, { default: T }>) =>
  Object.fromEntries(Object.values(mods).map((m) => [m.default.id, m.default])) as Record<string, T>;

performance.mark('fp:boot');
const params = readParams();
const data: AppData = {
  agents: agents as AgentsFile,
  sources: sources as SourcesFile,
  layouts: byId(layoutMods),
  scenarios: byId(scenarioMods),
};
// Sim-only hook, set before anything touches WebGL, so the cross-engine determinism test works everywhere.
window.__fpSim = {
  /** A scenario id, or a whole scenario (the test passes the mixed-fleet fixture so every agent type is hashed). */
  runHash(scenario, ticks) {
    const sc = typeof scenario === 'string' ? data.scenarios[scenario] : scenario;
    const sim = createSim(sc, { agents: data.agents, layout: data.layouts[sc.layout] });
    sim.step(ticks);
    return sim.hash();
  },
};
// Real numbers come from the worker pool on the real sim; ?runner=fake keeps the instant toy runner ("demo data").
const runner = params.runner === 'fake' ? createFakeRunner(120) : createWorkerRunner();
const host = createHost(data, runner, { scenario: params.scenario, seed: params.seed, econ: () => import('../econ/index.ts').then((m) => m.econ), demo: runner.kind === 'fake' });
if (params.agents) host.setFleet('amr', params.agents);

const stage = document.getElementById('stage')!;
const ui = document.getElementById('ui')!;
function fatal(title: string, body: string): never {
  document.getElementById('boot')?.remove();
  const el = document.createElement('div');
  el.className = 'lost';
  el.innerHTML = `<div class="card"><h3>${title}</h3><p>${body}</p></div>`;
  document.body.appendChild(el);
  throw new Error(title);
}
let coreOrNull: ReturnType<typeof createRenderer> | null = null;
try {
  coreOrNull = createRenderer(stage, {
    tier: params.tier,
    onTier: (t) => host.bus.emit('tier', t),
    onLost: () => {
      const el = document.createElement('div');
      el.className = 'lost';
      el.innerHTML = `<div class="card"><h3>The 3D view stopped</h3><p>Your device ran low on graphics memory. Reload to start again; it will use a lighter view.</p><button class="primary">Reload</button></div>`;
      el.querySelector('button')!.addEventListener('click', () => {
        const u = new URL(location.href);
        u.searchParams.set('tier', 'lite');
        location.href = u.toString();
      });
      document.body.appendChild(el);
    },
  });
} catch (e) {
  console.warn('WebGL unavailable', e);
}
const core = coreOrNull ?? fatal('This device can\'t show the 3D warehouse', 'Fleet Planner needs WebGL 2. Try a recent Chrome, Safari, Edge or Firefox.');
if (params.tier || params.freeze || params.capture) core.tiers.frozen = true;

let layout = data.layouts[host.settings.value.layout];
let world: WorldLayer;
let agentLayer: AgentLayer;
let rig: CameraRig;
const raycaster = new Raycaster();

function buildScene(l: LayoutFile) {
  world?.dispose();
  core.roots.world.clear();
  agentLayer?.dispose();
  core.roots.agents.clear();
  const opts = { layout: l, tier: core.tiers.tier, core, baseUrl: import.meta.env.BASE_URL };
  world = createWorldLayer(opts);
  core.roots.world.add(world.group);
  agentLayer = createAgentLayer(opts);
  core.roots.agents.add(agentLayer.group);
  rig?.controls.dispose();
  rig = new CameraRig(core.renderer.domElement, world.sizeX, world.sizeZ);
  core.setViews([{ id: 'main', rect: [0, 0, 1, 1], camera: rig.camera, layers: [0] }]);
  const built = world;
  void built.fullLook.then(() => {
    if (built !== world) return;
    core.perf.fullLookMs = Math.round(performance.now());
    host.bus.emit('fullLook', { ms: core.perf.fullLookMs });
  });
}
host.bus.on('tier', (t) => {
  world.setTier(t);
  agentLayer.setTier(t);
});
buildScene(layout);
performance.mark('fp:scene');
host.bus.on('layoutChanged', ({ layout: l }) => {
  layout = l;
  buildScene(l);
});

let frozen = params.freeze;
let lastAspect = 0;
let firstUsefulViewMs: number | null = null;
let readyResolve: () => void = () => {};
const whenReady = new Promise<void>((r) => (readyResolve = r));
let tourState: { fn: (u: number) => Pose; t0: number; ms: number; done: () => void } | null = null;

core.onFrame((dt, now) => {
  if (!frozen) host.live.advance(dt);
  world.update?.(dt, now);
  const sel = host.selected.value;
  agentLayer.update(host.live.snapshot, host.live.renderTick, sel?.agentId ?? null, dt);
  if (tourState) {
    const u = Math.min(1, (now - tourState.t0) / tourState.ms);
    rig.setPose(tourState.fn(u));
    if (u >= 1) {
      tourState.done();
      tourState = null;
    }
  } else rig.update(now);
  core.perf.agents = agentLayer.count();
  const fog = core.scene.fog as Fog;
  const dist = rig.distance();
  fog.near = Math.max(40, dist * 0.9);
  fog.far = Math.max(140, dist * 2.4);
  if (rig.camera.aspect !== lastAspect) {
    lastAspect = rig.camera.aspect;
    rig.refit();
  }
  if (firstUsefulViewMs === null && agentLayer.count() > 0 && host.result.value) {
    firstUsefulViewMs = Math.round(performance.now());
    performance.mark('fp:first-useful-view');
    core.perf.firstUsefulViewMs = firstUsefulViewMs;
    hooks.ready = true;
    host.bus.emit('firstUsefulView', { ms: firstUsefulViewMs });
    document.getElementById('boot')?.remove();
    readyResolve();
  }
});

// Click or tap an agent to follow it; click empty floor (or Esc) to pull back out.
const canvas = core.renderer.domElement;
let down: { x: number; y: number; t: number } | null = null;
canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 6) return;
  const id = pickAt(e.clientX, e.clientY);
  selectAgent(id);
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') selectAgent(null);
});
host.bus.on('select', ({ agentId }) => {
  if (agentId === null) {
    if (rig.following) rig.overview();
  } else rig.follow(() => agentLayer.followTarget(agentId));
});

function pickAt(x: number, y: number): number | null {
  const r = canvas.getBoundingClientRect();
  const ndc = new Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, rig.camera);
  return agentLayer.pick(raycaster);
}
function selectAgent(id: number | null) {
  host.select(0, id);
}

mountShell(ui, host, params);

const hooks: FpHooks = {
  host,
  sims: [host.live],
  runner,
  ready: false,
  whenReady,
  render: {
    info: () => {
      const i = core.info();
      const counts: Record<string, number> = {};
      for (const a of host.live.snapshot.agents) counts[a.type] = (counts[a.type] ?? 0) + 1;
      return {
        calls: i.calls,
        triangles: i.triangles,
        views: i.views,
        agents: counts,
        labels: { tier: core.tiers.tier, dpr: core.renderer.getPixelRatio(), layout: host.settings.value.layout, canvas: `${canvas.width}x${canvas.height}` },
      };
    },
    project: (id) => {
      const r = canvas.getBoundingClientRect();
      const p = agentLayer.project(id, rig.camera, r.width, r.height);
      return p ? { x: p.x + r.left, y: p.y + r.top } : null;
    },
    pick: (x, y) => pickAt(x, y),
    cameraPose: () => rig.pose(),
    following: () => rig.following,
    roots: core.roots,
    get layers() {
      return { world, agents: agentLayer };
    },
  },
  perf: core.perf,
  tours: [...TOURS],
  tour(name, seconds = 20) {
    const fn = makeTours(layout)[name] ?? makeTours(layout).default;
    host.select(0, null);
    return new Promise<void>((done) => {
      tourState = { fn, t0: performance.now(), ms: seconds * 1000, done };
    });
  },
  freeze(on) {
    frozen = on;
  },
};
window.__fp = hooks;
