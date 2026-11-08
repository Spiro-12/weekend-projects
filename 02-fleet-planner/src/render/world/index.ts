// World layer entry (Track D owns this folder from Phase 1). Phase 0: the procedural world only.
import type { WorldLayer, WorldLayerOptions } from '../core/layers.ts';
import { tierSettings } from '../core/tiers.ts';
import { buildProceduralWorld } from './procedural.ts';

export function createWorldLayer(o: WorldLayerOptions): WorldLayer {
  const w = buildProceduralWorld(o.layout, { farBoxes: tierSettings(o.tier).farBoxes });
  return {
    group: w.group,
    sizeX: w.sizeX,
    sizeZ: w.sizeZ,
    fullLook: Promise.resolve(),
    setTier() {},
    dispose: () => w.dispose(),
  };
}
