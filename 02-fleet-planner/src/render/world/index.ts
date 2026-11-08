// World layer (Track D): the warehouse building, racks, docks, pack area, chargers and floor paint.
// First view: procedural only (a few KB of code, no downloads). Once the first useful view is on screen (or after 2.5 s
// at the latest), the first-tier SimReady models stream in through the shared loader and replace their stand-ins;
// `fullLook` resolves when they are all in (or failed: the stand-ins stay).
//
// Draw calls per view at the overview (medium): floor 1, walls 1, steel 1, rack frames 1, rack loads 1 (+5 for the
// near SimReady loads in close views), props 3 + conveyor cartons 1, SimReady props 13. See debug().
import { Group, type Camera, type InstancedMesh, type Mesh } from 'three';
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
  faceBlocksDrawn(cell: number): { blocks: number; drawn: number };
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
  /** Model key → the file now swapped in (only set once the model is actually in the scene). */
  const installed = new Map<string, string>();
  const failed: string[] = [];

  /** Fetch a model for a tier, or null when that exact file is already in. */
  async function fetchParts(key: string, t: Tier) {
    const loader = await getLoader();
    const url = await loader.urlFor(key, t);
    if (installed.get(key) === url) return null;
    const g = await loader.gltf(key, t);
    return { url, parts: glbParts(g.scene, { envMap: env.texture }) };
  }
  const drop = (x: { parts: { geometry: { dispose(): void }; material: { dispose(): void } }[] } | null) =>
    x?.parts.forEach((p) => (p.geometry.dispose(), p.material.dispose()));

  /** Swap in the models for a tier (only files that change). Never rejects: a model that fails keeps its stand-in. */
  async function loadTier(t: Tier): Promise<void> {
    const jobs: Promise<void>[] = [];
    if (nearCaps(t).pallets > 0)
      jobs.push(
        Promise.all([fetchParts('pallet_loaded', t), fetchParts('pallet_wrapped', t)]).then(([full, wrap]) => {
          if (!full && !wrap) return;
          if (disposed || t !== tier) return void (drop(full), drop(wrap));
          // Both composites swap together; reuse the other file's parts only if it was unchanged (refetch then).
          if (full && wrap) {
            racks.setGlb(full.parts, wrap.parts);
            installed.set('pallet_loaded', full.url);
            installed.set('pallet_wrapped', wrap.url);
            budgetDirty = true;
          } else {
            drop(full);
            drop(wrap);
          }
        }),
      );
    for (const key of PROP_KEYS) {
      const pt = propTier(key, t);
      if (!pt) continue; // keeps its procedural stand-in (or the model it already has) at this tier
      jobs.push(
        fetchParts(key, pt).then((x) => {
          if (!x) return;
          if (disposed || t !== tier) return void drop(x);
          props.setGlb(key, x.parts);
          installed.set(key, x.url);
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
  }

  // One loader at a time; a tier change while loading runs another pass for the new tier before `fullLook` resolves.
  let loading: Promise<void> | null = null;
  let again = false;
  function ensureLoaded(): Promise<void> {
    again = true;
    loading ??= (async () => {
      while (again && !disposed) {
        again = false;
        await loadTier(tier);
      }
    })().finally(() => (loading = null));
    return loading;
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
  let fullLookDone = false;
  const fullLook = new Promise<void>((r) => (startLoad = r))
    .then(() => ensureLoaded())
    .then(() => void (fullLookDone = true));
  const cams: Camera[] = [];

  return {
    group,
    sizeX: plan.sizeX,
    sizeZ: plan.sizeZ,
    fullLook,
    setTier(t: Tier) {
      if (t === tier) return;
      tier = t;
      racks.setTier(t);
      budgetDirty = true;
      // Only files that differ between the two tiers are fetched and swapped (e.g. medium ↔ high: the conveyor).
      if (loadStarted) void ensureLoaded();
    },
    update(_dt: number, now: number) {
      if (!loadStarted) {
        if (firstFrame < 0) firstFrame = now;
        if (o.core.perf.firstUsefulViewMs != null || now - firstFrame > 2500) {
          loadStarted = true;
          startLoad();
        }
      }
      const views = o.core.views;
      cams.length = views.length;
      for (let i = 0; i < views.length; i++) cams[i] = views[i].camera;
      racks.update(cams, now);
      props.update(now);
      if (budgetDirty) {
        budgetDirty = false;
        staticTris = countStatic();
        racks.setTriangleBudget(budget(tier) - staticTris);
      }
    },
    setFaceFill: (cell, fill) => racks.setFaceFill(cell, fill),
    /** Test hook: how many of a face's block instances are still drawn (non-zero matrices). */
    faceBlocksDrawn(cell: number) {
      const arr = racks.blocks.instanceMatrix.array as Float32Array;
      const idx = racks.faceBlocks(cell);
      return { blocks: idx.length, drawn: idx.filter((b) => arr[b * 16 + 15] !== 0).length };
    },
    debug() {
      return {
        tier,
        buildMs,
        fullLookDone,
        /** Whole-renderer GPU objects (layout-rebuild leak test). */
        gpu: (({ geometries, textures }) => ({ geometries, textures }))(o.core.info()),
        staticTriangles: staticTris,
        triangleBudget: budget(tier),
        size: [plan.sizeX, plan.sizeZ],
        grid: [plan.W, plan.H],
        /** A rack cell with stock, for tests of setFaceFill. */
        sampleFace: [...plan.faceSlots].find(([, l]) => l.filter((i) => plan.slots[i].kind).length >= 3)?.[0] ?? -1,
        wallH: plan.wallH,
        floorTexture: floor.size,
        models: Object.fromEntries(installed),
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
