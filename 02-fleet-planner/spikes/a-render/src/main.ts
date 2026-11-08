// Render spike (Phase 0, spike a): can the PLAN §4 approach draw the warehouse, 150 agents per side in split screen,
// ribbons and bloom inside the frame budget? Exposes window.__fp (tests/perf/hook.ts) for scripts/perf.ts.
import {
  AgXToneMapping, DirectionalLight, Fog, Group, PCFShadowMap, PMREMGenerator, Scene, WebGLRenderer, type Object3D,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import layoutJson from '../../../data/layouts/default.json';
import type { LayoutFile } from '../../../src/contracts/types.ts';
import { buildWorld } from '../../../src/sim/world.ts';
import type { PerfPage, RenderInfo } from '../../../tests/perf/hook.ts';
import { makeGrid } from './grid.ts';
import { readParams } from './params.ts';
import { buildStaticWorld } from './static-world.ts';
import { WalkerSim } from './walkers.ts';
import { RobotMeshes } from './robots.ts';
import { PeopleParts } from './people-parts.ts';
import { BlobShadows, Ribbons } from './fx.ts';
import { Views } from './views.ts';
import { GpuTimer } from './gpu-timer.ts';
import { makeTours, type Pose } from './tours.ts';
import { Hud } from './hud.ts';

const params = readParams(location.search);
const { spec } = params;
const world = buildWorld(layoutJson as LayoutFile);
const grid = makeGrid(world);

// ── Renderer, scene, lighting
const renderer = new WebGLRenderer({ antialias: spec.antialias, powerPreference: 'high-performance' });
renderer.toneMapping = AgXToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = spec.shadowMap;
renderer.shadowMap.type = PCFShadowMap;
document.body.appendChild(renderer.domElement);
const gl = renderer.getContext() as WebGL2RenderingContext;
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const gpuName = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));

const scene = new Scene();
const sides = params.split ? 2 : 1;
const views = new Views(renderer, scene, sides, spec.dpr);
scene.fog = new Fog(views.bg, 70, 190);
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;
pmrem.dispose();
const sun = new DirectionalLight(0xfff4e6, 1.1);
sun.position.set(25, 60, 30);
sun.target.position.set(0, 0, 0);
if (spec.shadowMap) {
  // One shadow map for agents only (static racks get the baked contact shadow instead).
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const cam = sun.shadow.camera;
  cam.left = -grid.sizeX / 2 - 2;
  cam.right = grid.sizeX / 2 + 2;
  cam.top = grid.sizeZ / 2 + 2;
  cam.bottom = -grid.sizeZ / 2 - 2;
  cam.near = 20;
  cam.far = 120;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
}
scene.add(sun, sun.target);

// ── Static world
const stat = buildStaticWorld(grid, renderer.capabilities.getMaxAnisotropy() >= 8 ? 8 : 4);
scene.add(stat.group);

// ── Agents, one set per side
const nForklift = Math.round(params.robots * 0.12);
const counts = { amr: params.robots - nForklift, forklift: nForklift, person: params.people };
const setLayer = (o: Object3D, layer: number) => o.traverse((c) => c.layers.set(layer));

interface Side {
  sim: WalkerSim;
  robots: RobotMeshes;
  people: { update(dt: number): void } | null;
  blobs: BlobShadows | null;
  ribbons: Ribbons;
  group: Group;
}
const sideList: Side[] = [];
let skinnedSrc: import('./people-skinned.ts').SkinnedSource | null = null;
let skinnedMod: typeof import('./people-skinned.ts') | null = null;
if (params.peopleMode === 'skinned' && params.people > 0) {
  skinnedMod = await import('./people-skinned.ts');
  skinnedSrc = await skinnedMod.loadSkinnedSource(`${import.meta.env.BASE_URL}models/RobotExpressive.glb`);
}
for (let s = 0; s < sides; s++) {
  const sim = new WalkerSim(world, params.seed + s * 101, counts, grid.cellX, grid.cellZ);
  const group = new Group();
  group.name = `side-${s}`;
  const robots = new RobotMeshes(sim.walkers, spec.shadowMap);
  group.add(robots.group);
  const peopleW = sim.walkers.filter((w) => w.kind === 'person');
  let people: Side['people'] = null;
  if (peopleW.length) {
    if (skinnedMod && skinnedSrc) {
      const p = new skinnedMod.PeopleSkinned(peopleW, skinnedSrc, spec.shadowMap);
      group.add(p.group);
      people = p;
    } else {
      const p = new PeopleParts(peopleW, spec.shadowMap);
      group.add(p.group);
      people = p;
    }
  }
  const blobs = spec.blobs ? new BlobShadows(sim.walkers) : null;
  if (blobs) group.add(blobs.mesh);
  const ribbons = new Ribbons(sim.walkers, grid.cellX, grid.cellZ);
  group.add(ribbons.mesh);
  setLayer(group, s + 1);
  scene.add(group);
  sideList.push({ sim, robots, people, blobs, ribbons, group });
}

// ── Camera, controls, tours
const { poses, tours } = makeTours(grid);
const controls = new OrbitControls(views.cams[0], renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.48;
const applyPose = (p: Pose) => {
  for (const c of views.cams) {
    c.position.copy(p.pos);
    c.lookAt(p.target);
  }
  controls.target.copy(p.target);
};
applyPose(poses[params.pose] ?? poses.overview);
controls.update();
views.resize();
window.addEventListener('resize', () => views.resize());
if (spec.bloom) await views.enableBloom(spec.bloomScale);
views.beforeView = (_i, cam) => stat.cullBoxes(cam, spec.boxFarM);

// ── Perf hook
const timer = new GpuTimer(gl);
let frameNo = 0;
let lastCpu = 0;
let base = 0;
let cpuSamples: number[] = [];
let workSamples: number[] = [];
let syncMode = false;
const syncPixel = new Uint8Array(4);
const gpuByFrame = new Map<number, number>();
let tour: { fn: (u: number) => Pose; start: number; ms: number; done: () => void } | null = null;
const hud = params.hud ? new Hud(gpuName) : null;

const agentCounts = () => {
  const a = { robots: 0, amr: 0, forklift: 0, people: 0 };
  for (const s of sideList) {
    a.amr += s.sim.count('amr');
    a.forklift += s.sim.count('forklift');
    a.people += s.sim.count('person');
  }
  a.robots = a.amr + a.forklift;
  return a;
};

const fp: PerfPage & Record<string, unknown> = {
  ready: false,
  perf: {
    cpuMs: () => lastCpu,
    gpuMs: () => timer.last,
    tier: params.tier,
    drain: () => {
      const cpu = cpuSamples;
      const gpu = cpu.map((_, i) => gpuByFrame.get(base + i) ?? null);
      const work = syncMode ? workSamples : undefined;
      for (const k of gpuByFrame.keys()) if (k < frameNo) gpuByFrame.delete(k);
      cpuSamples = [];
      workSamples = [];
      base = frameNo;
      return { cpu, gpu, work };
    },
    sync: (on: boolean) => {
      syncMode = on;
      workSamples = [];
    },
  },
  render: {
    info: (): RenderInfo => ({
      calls: views.frameCalls,
      triangles: views.frameTris,
      views: views.viewInfo.map((v) => ({ ...v })),
      agents: agentCounts(),
      labels: {
        view: params.split ? 'split' : 'single',
        peopleMode: params.peopleMode,
        dpr: renderer.getPixelRatio(),
        canvas: `${renderer.domElement.width}x${renderer.domElement.height}`,
        bloom: spec.bloom,
        shadowMap: spec.shadowMap,
        blobs: spec.blobs,
        boxes: stat.counts.boxes,
        pallets: stat.counts.pallets,
        rackParts: stat.counts.rackParts,
        gpuTimer: timer.available,
      },
    }),
  },
  tours: Object.keys(tours),
  tour: (name: string, seconds: number) =>
    new Promise<void>((done) => {
      const fn = tours[name];
      if (!fn) throw new Error(`unknown tour '${name}' (have ${Object.keys(tours).join(', ')})`);
      controls.enabled = false;
      tour = { fn, start: performance.now(), ms: seconds * 1000, done };
    }),
  pose: (name: string) => {
    tour = null;
    applyPose(poses[name] ?? poses.overview);
  },
  poses: Object.keys(poses),
};
(window as unknown as { __fp: typeof fp }).__fp = fp;

// ── Frame loop
let simTime = params.freeze ?? 0;
let lastNow = performance.now();
const startedAt = performance.now();
if (params.freeze !== null) for (const s of sideList) s.sim.advanceTo(simTime);

function frame(now: number): void {
  requestAnimationFrame(frame);
  const t0 = performance.now();
  const dtReal = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  const frameMs = now - lastNow;
  lastNow = now;
  const frozen = params.freeze !== null;
  if (!frozen) simTime += dtReal;
  const dt = frozen ? 0 : dtReal;

  if (tour) {
    const u = Math.min(1, (performance.now() - tour.start) / tour.ms);
    applyPose(tour.fn(u));
    if (u >= 1) {
      const done = tour.done;
      tour = null;
      controls.enabled = true;
      controls.update();
      done();
    }
  } else {
    controls.update();
    for (let i = 1; i < views.cams.length; i++) {
      views.cams[i].position.copy(views.cams[0].position);
      views.cams[i].quaternion.copy(views.cams[0].quaternion);
    }
  }

  for (const s of sideList) {
    if (!frozen) s.sim.advanceTo(simTime);
    s.sim.pose(simTime, dt);
    s.robots.update();
    s.people?.update(dt);
    s.blobs?.update();
    s.ribbons.update(simTime);
  }

  timer.begin(frameNo);
  views.render();
  timer.end();
  lastCpu = performance.now() - t0;
  if (syncMode) {
    // A 1-pixel readback of the canvas blocks until the GPU has finished this frame. (Chrome's gl.finish() does not:
    // it returns after an IPC round trip.) The canvas framebuffer is still bound after the last pass.
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
    workSamples.push(performance.now() - t0);
  }
  timer.poll((f, ms) => gpuByFrame.set(f, ms));
  cpuSamples.push(lastCpu);
  if (cpuSamples.length > 20000) fp.perf.drain!();
  frameNo++;
  if (!fp.ready && frameNo > 2) {
    fp.ready = true;
    fp.perf.firstUsefulViewMs = performance.now() - startedAt;
  }
  hud?.push(frameMs, lastCpu, timer.last, now, () => {
    const a = agentCounts();
    return `${params.tier} ${params.split ? 'split' : 'single'} ${views.frameCalls} calls ${(views.frameTris / 1e6).toFixed(2)}M tris\n` +
      `robots ${a.robots} people ${a.people} (${params.peopleMode})`;
  });
}
requestAnimationFrame(frame);
