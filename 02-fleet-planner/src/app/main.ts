// Fleet Planner entry (lead-owned). Boots data → host → renderer → world → agents → panels, then exposes window.__fp.
import '../ui/styles.css';
import { Fog, Raycaster, Vector2 } from 'three';
import agents from '../../data/agents.json';
import sources from '../../data/sources.json';
import type { AgentsFile, LayoutFile, Scenario, SourcesFile } from '../contracts/types.ts';
import { createHost, type AppData } from '../host/index.ts';
import { createSim } from '../sim/index.ts';
import { createFakeRunner } from '../host/runner/fake.ts';
import { BasicAgentLayer } from '../render/agents/basic.ts';
import { CameraRig } from '../render/core/camera.ts';
import { createRenderer } from '../render/core/renderer.ts';
import { tierSettings } from '../render/core/tiers.ts';
import { buildProceduralWorld, type WorldBuild } from '../render/world/procedural.ts';
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
  runHash(scenarioId, ticks) {
    const sc = data.scenarios[scenarioId];
    const sim = createSim(sc, { agents: data.agents, layout: data.layouts[sc.layout] });
    sim.step(ticks);
    return sim.hash();
  },
};
const runner = createFakeRunner(120);
const host = createHost(data, runner, { scenario: params.scenario, seed: params.seed });
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
let world: WorldBuild;
let agentLayer: BasicAgentLayer;
let rig: CameraRig;
const raycaster = new Raycaster();

function buildScene(l: LayoutFile) {
  world?.dispose();
  core.roots.world.clear();
  agentLayer?.dispose();
  core.roots.agents.clear();
  const ts = tierSettings(core.tiers.tier);
  world = buildProceduralWorld(l, { farBoxes: ts.farBoxes });
  core.roots.world.add(world.group);
  agentLayer = new BasicAgentLayer({ width: l.grid[0].length, height: l.grid.length });
  core.roots.agents.add(agentLayer.group);
  rig?.controls.dispose();
  rig = new CameraRig(core.renderer.domElement, world.sizeX, world.sizeZ);
  core.setViews([{ id: 'main', rect: [0, 0, 1, 1], camera: rig.camera, layers: [0] }]);
}
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
const ready = new Promise<void>((r) => (readyResolve = r));

core.onFrame((dt, now) => {
  if (!frozen) host.live.advance(dt);
  const sel = host.selected.value;
  agentLayer.update(host.live.snapshot, host.live.renderTick, sel?.agentId ?? null, dt);
  rig.update(now);
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
    hooks.perf.firstUsefulViewMs = firstUsefulViewMs;
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
  render: {
    info: () => core.info(),
    project: (id) => {
      const r = canvas.getBoundingClientRect();
      const p = agentLayer.project(id, rig.camera, r.width, r.height);
      return p ? { x: p.x + r.left, y: p.y + r.top } : null;
    },
    pick: (x, y) => pickAt(x, y),
    cameraPose: () => rig.pose(),
    following: () => rig.following,
  },
  perf: Object.assign(core.perf, { firstUsefulViewMs: null as number | null, fullLookMs: null as number | null }),
  async tour(name) {
    const size = Math.max(world.sizeX, world.sizeZ);
    const poses: Record<string, [number, number, number, number, number, number][]> = {
      overview: [[-size * 0.1, size * 0.5, size * 0.75, 0, 0, 0]],
      orbit: [
        [-size * 0.5, size * 0.35, size * 0.5, 0, 0, 0],
        [size * 0.5, size * 0.3, size * 0.4, 0, 0, 0],
        [0, 14, 10, 0, 0, -5],
        [-size * 0.1, size * 0.5, size * 0.75, 0, 0, 0],
      ],
    };
    for (const p of poses[name] ?? poses.orbit) {
      rig.flyTo({ position: [p[0], p[1], p[2]], target: [p[3], p[4], p[5]] }, 2500);
      await new Promise((r) => setTimeout(r, 2600));
    }
  },
  freeze(on) {
    frozen = on;
  },
  ready,
};
window.__fp = hooks;
