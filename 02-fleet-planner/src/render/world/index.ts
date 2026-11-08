// World layer (Track D): the warehouse building, racks, docks, pack area, chargers and floor paint.
// First view: procedural only (a few KB of code, no downloads). Once the first useful view is on screen (or after 2.5 s
// at the latest), the first-tier SimReady models stream in through the shared loader and replace their stand-ins;
// `fullLook` resolves when they are all in (or failed: the stand-ins stay).
//
// Draw calls per view at the overview (medium): floor 1, walls 1, steel 1, rack frames 1, rack loads 1 (+5 for the
// near SimReady loads in close views), props 3 + conveyor cartons 1, SimReady props 13. See debug().
import { Group, type InstancedMesh, type Mesh } from 'three';
import type { Tier } from '../../host/index.ts';
import type { AssetLoader } from '../core/assets.ts';
import type { WorldLayer, WorldLayerOptions } from '../core/layers.ts';
import { buildHallEnv } from './env.ts';
import { buildFloor } from './floor.ts';
import { glbParts } from './glb.ts';
import { planWorld } from './plan.ts';
import { propTier, Props, type PropKey } from './props.ts';
import { nearCaps, Racks } from './racks.ts';
import { buildShell } from './shell.ts';

const PROP_KEYS: PropKey[] = ['column', 'light_panel', 'dock_gate', 'pack_table', 'conveyor', 'guard_rail'];

export interface WorldLayerExt extends WorldLayer {
  /** Phase 2 hook: how full a rack face (rack cell index y × W + x) is, 0..1. Returns the stocked slot count. */
  setFaceFill(cell: number, fill: number): number;
}

export function createWorldLayer(o: WorldLayerOptions): WorldLayerExt {
  const t0 = performance.now();
  const plan = planWorld(o.layout);
  const env = buildHallEnv(o.core.renderer);
  const group = new Group();
  group.name = 'world-layer';
  const floor = buildFloor(plan, o.layout, o.tier, env.texture);
  const shell = buildShell(plan, env.texture);
  const racks = new Racks(plan, o.tier, env.texture, shell.trailerPallets);
  const props = new Props(plan, env.texture, shell.uniforms, racks.blockMat);
  group.add(floor.mesh, shell.walls, shell.signs, shell.steel, racks.group, props.group);
  const buildMs = Math.round(performance.now() - t0);

  let tier = o.tier;
  let disposed = false;
  // The loader (GLTFLoader + meshopt decoder) is imported lazily, so it stays out of the initial JS.
  let loaderP: Promise<AssetLoader> | null = null;
  const getLoader = () => (loaderP ??= import('../core/assets.ts').then((m) => m.assetLoader(o.baseUrl)));
  const useLow = (t: Tier) => t === 'low' || t === 'lite';
  const loaded = new Map<string, string>();
  const failed: string[] = [];

  async function load(key: string, t: Tier) {
    const loader = await getLoader();
    const g = await loader.gltf(key, t);
    loaded.set(key, await loader.urlFor(key, t));
    return glbParts(g.scene, { envMap: env.texture });
  }

  /** Load (or swap to) the models for a tier. Never rejects: a model that fails keeps its stand-in. */
  async function loadTier(t: Tier): Promise<void> {
    const jobs: Promise<void>[] = [];
    if (nearCaps(t).pallets > 0)
      jobs.push(
        Promise.all([load('pallet_loaded', t), load('pallet_wrapped', t)]).then(([full, wrap]) => {
          if (disposed || t !== tier) return;
          racks.setGlb(full, wrap);
          budgetDirty = true;
        }),
      );
    let keep = false;
    for (const key of PROP_KEYS) {
      const pt = propTier(key, t);
      if (!pt) {
        keep = true;
        continue;
      }
      jobs.push(
        load(key, pt).then((parts) => {
          if (disposed || t !== tier) return;
          props.setGlb(key, parts);
          budgetDirty = true;
        }),
      );
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results)
      if (r.status === 'rejected') {
        failed.push(String(r.reason));
        console.warn('[world] a model failed to load; keeping its stand-in:', r.reason);
      }
    if (keep && !disposed) props.keepStandIns();
  }

  // Triangle budget per view for the world alone (PLAN §9 / brief): the near SimReady pallets get what is left.
  const budget = (t: Tier) => (t === 'high' || t === 'medium' ? 600_000 : t === 'low' ? 330_000 : 200_000);
  let budgetDirty = true;
  let staticTris = 0;
  function countStatic(): number {
    let n = 0;
    group.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh || !m.visible || m.name.startsWith('rack-loads-near')) return;
      const g = m.geometry;
      const per = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      n += per * ((m as InstancedMesh).isInstancedMesh ? (m as InstancedMesh).count : 1);
    });
    return n;
  }

  // Downloads wait for the first useful view, so they never compete with it.
  let loadStarted = false;
  let firstFrame = -1;
  let startLoad: () => void = () => {};
  const fullLook = new Promise<void>((r) => (startLoad = r)).then(() => loadTier(tier));

  return {
    group,
    sizeX: plan.sizeX,
    sizeZ: plan.sizeZ,
    fullLook,
    setTier(t: Tier) {
      if (t === tier) return;
      const prev = tier;
      tier = t;
      racks.setTier(t);
      budgetDirty = true;
      const lodChanged = useLow(prev) !== useLow(t) || nearCaps(prev).pallets === 0 || t === 'high' || prev === 'high';
      if (lodChanged && loadStarted) void loadTier(t);
    },
    update(_dt: number, now: number) {
      if (!loadStarted) {
        if (firstFrame < 0) firstFrame = now;
        if (o.core.perf.firstUsefulViewMs != null || now - firstFrame > 2500) {
          loadStarted = true;
          startLoad();
        }
      }
      racks.update(
        o.core.views.map((v) => v.camera),
        now,
      );
      props.update(now);
      if (budgetDirty) {
        budgetDirty = false;
        staticTris = countStatic();
        racks.setTriangleBudget(budget(tier) - staticTris);
      }
    },
    setFaceFill: (cell, fill) => racks.setFaceFill(cell, fill),
    debug() {
      return {
        tier,
        buildMs,
        staticTriangles: staticTris,
        triangleBudget: budget(tier),
        size: [plan.sizeX, plan.sizeZ],
        grid: [plan.W, plan.H],
        /** A rack cell with stock, for tests of setFaceFill. */
        sampleFace: [...plan.faceSlots].find(([, l]) => l.filter((i) => plan.slots[i].kind).length >= 3)?.[0] ?? -1,
        wallH: plan.wallH,
        floorTexture: [(floor.texture.image as HTMLCanvasElement).width, (floor.texture.image as HTMLCanvasElement).height],
        models: Object.fromEntries(loaded),
        failed,
        racks: racks.stats(),
        props: props.stats(),
        shell: shell.stats(),
        doors: plan.doors.length,
        trussLines: plan.trussZ.length,
      };
    },
    dispose() {
      disposed = true;
      floor.dispose();
      shell.dispose();
      racks.dispose();
      props.dispose();
      env.dispose();
      group.clear();
    },
  };
}
