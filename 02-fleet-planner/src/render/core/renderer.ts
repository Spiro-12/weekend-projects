// Renderer core (lead-owned, PROTOCOL §9): one WebGL2 renderer, scene roots, one or two scissor views, tiers,
// perf timing, context-lost handling. World and agent layers add themselves under roots.world / roots.agents.
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector4,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Tier } from '../../host/index.ts';
import { PerfMonitor } from './perf.ts';
import { initialTier, tierSettings, TierMonitor } from './tiers.ts';

export interface View {
  id: string;
  /** Rectangle in 0..1 of the canvas (x, y from bottom-left, w, h). */
  rect: [number, number, number, number];
  camera: PerspectiveCamera;
  /** Only objects on these layers render in this view (layer 0 = shared world). */
  layers: number[];
}

export interface RendererCore {
  renderer: WebGLRenderer;
  scene: Scene;
  roots: { world: Group; agents: Group; fx: Group };
  views: View[];
  perf: PerfMonitor;
  tiers: TierMonitor;
  sun: DirectionalLight;
  addView(v: View): void;
  setViews(v: View[]): void;
  onFrame(fn: (dtMs: number, nowMs: number) => void): () => void;
  /** Called after the scene renders each frame (post effects can replace the plain render). */
  setRenderPass(fn: ((view: View) => void) | null): void;
  /** Last frame, all views and passes (tests/perf/hook.ts RenderInfo). */
  info(): { calls: number; triangles: number; views: { id: string; calls: number; triangles: number }[]; geometries: number; textures: number };
  setTier(t: Tier): void;
  dispose(): void;
}

export function createRenderer(container: HTMLElement, opts: { tier?: Tier; onTier?: (t: Tier) => void; onLost?: () => void } = {}): RendererCore {
  const start = opts.tier ?? initialTier();
  const ts = tierSettings(start);
  const renderer = new WebGLRenderer({ antialias: ts.antialias, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(ts.dpr);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = typeof AgXToneMapping === 'number' ? AgXToneMapping : ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.autoClear = false;
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('data-testid', 'stage-canvas');
  renderer.domElement.tabIndex = 0;

  const scene = new Scene();
  scene.background = new Color(0x090c11);
  scene.fog = new Fog(0x090c11, 70, 190);
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
  const hemi = new HemisphereLight(0xcfd8ff, 0x1a1712, 0.55);
  scene.add(hemi);
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(-30, 60, 25);
  scene.add(sun);

  const roots = { world: new Group(), agents: new Group(), fx: new Group() };
  roots.world.name = 'world';
  roots.agents.name = 'agents';
  roots.fx.name = 'fx';
  scene.add(roots.world, roots.agents, roots.fx);

  const perf = new PerfMonitor();
  perf.attach(renderer);
  let views: View[] = [];
  const frameFns = new Set<(dt: number, now: number) => void>();
  let renderPass: ((v: View) => void) | null = null;

  const tiers = new TierMonitor(start, (t) => {
    applyTier(t);
    opts.onTier?.(t);
  });
  perf.tier = start;
  function applyTier(t: Tier) {
    const s = tierSettings(t);
    renderer.setPixelRatio(s.dpr);
    perf.tier = t;
    resize();
  }

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    for (const v of views) {
      v.camera.aspect = (w * v.rect[2]) / Math.max(1, h * v.rect[3]);
      v.camera.updateProjectionMatrix();
    }
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  const vp = new Vector4();
  const viewInfo: { id: string; calls: number; triangles: number }[] = [];
  const syncPixel = new Uint8Array(4);
  let lastCalls = 0;
  let lastTris = 0;
  let last = performance.now();
  let lost = false;
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lost = true;
    opts.onLost?.();
  });

  renderer.setAnimationLoop((now: number) => {
    if (lost) return;
    const dt = Math.min(250, now - last);
    last = now;
    perf.beginFrame(now);
    const t0 = performance.now();
    for (const fn of frameFns) fn(dt, now);
    renderer.info.reset();
    renderer.setScissorTest(views.length > 1);
    renderer.clear();
    const w = renderer.domElement.width / renderer.getPixelRatio();
    const h = renderer.domElement.height / renderer.getPixelRatio();
    viewInfo.length = 0;
    for (const v of views) {
      const c0 = renderer.info.render.calls;
      const t0v = renderer.info.render.triangles;
      vp.set(v.rect[0] * w, v.rect[1] * h, v.rect[2] * w, v.rect[3] * h);
      renderer.setViewport(vp);
      renderer.setScissor(vp);
      v.camera.layers.disableAll();
      for (const l of v.layers) v.camera.layers.enable(l);
      if (renderPass) renderPass(v);
      else {
        renderer.clearDepth();
        renderer.render(scene, v.camera);
      }
      viewInfo.push({ id: v.id, calls: renderer.info.render.calls - c0, triangles: renderer.info.render.triangles - t0v });
    }
    const cpu = performance.now() - t0;
    lastCalls = renderer.info.render.calls;
    lastTris = renderer.info.render.triangles;
    if (perf.syncMode) {
      const gl = renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
      perf.pushWork(performance.now() - t0);
    }
    perf.drawCalls = renderer.info.render.calls;
    perf.triangles = renderer.info.render.triangles;
    perf.endFrame(cpu);
    const s = perf.summary();
    tiers.sample(dt, s.cpuP95, s.gpuP50, now);
  });

  return {
    renderer,
    scene,
    roots,
    get views() {
      return views;
    },
    perf,
    tiers,
    sun,
    addView(v) {
      views.push(v);
      resize();
    },
    setViews(v) {
      views = v;
      resize();
    },
    onFrame(fn) {
      frameFns.add(fn);
      return () => frameFns.delete(fn);
    },
    setRenderPass(fn) {
      renderPass = fn;
    },
    info() {
      return {
        calls: lastCalls,
        triangles: lastTris,
        views: viewInfo.map((v) => ({ ...v })),
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
      };
    },
    setTier(t) {
      tiers.set(t);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      renderer.dispose();
    },
  } as RendererCore;
}
