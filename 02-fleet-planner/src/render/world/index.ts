// World layer (Track D): the warehouse building, racks, docks, pack area, chargers and floor paint.
// First view: procedural only (a few KB of code, no downloads). Then the first-tier SimReady models stream in through
// the shared loader and replace their stand-ins; `fullLook` resolves when they are all in (or failed: the stand-ins stay).
//
// Draw calls per view at the overview (medium): floor 1, walls 1, steel 1, rack frames 1, rack loads 1 (+5 for the
// near SimReady loads in close views), props 3 + conveyor cartons 1, SimReady props 13. See debug().
import { Group } from 'three';
import type { Tier } from '../../host/index.ts';
import { assetLoader, useLow } from '../core/assets.ts';
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
  group.add(floor.mesh, shell.walls, shell.steel, racks.group, props.group);
  const buildMs = Math.round(performance.now() - t0);

  let tier = o.tier;
  let disposed = false;
  const loader = assetLoader(o.baseUrl);
  const loaded = new Map<string, string>();
  const failed: string[] = [];

  async function load(key: string, t: Tier) {
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

  const fullLook = loadTier(tier);

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
      const lodChanged = useLow(prev) !== useLow(t) || nearCaps(prev).pallets === 0 || t === 'high' || prev === 'high';
      if (lodChanged) void loadTier(t);
    },
    update(_dt: number, now: number) {
      racks.update(
        o.core.views.map((v) => v.camera),
        now,
      );
      props.update(now);
    },
    setFaceFill: (cell, fill) => racks.setFaceFill(cell, fill),
    debug() {
      return {
        tier,
        buildMs,
        size: [plan.sizeX, plan.sizeZ],
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
