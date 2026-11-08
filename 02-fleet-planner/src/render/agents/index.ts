// Agent layer entry (Track E owns this folder from Phase 1). Phase 0: the basic instanced shapes.
import type { AgentLayer, AgentLayerOptions } from '../core/layers.ts';
import { BasicAgentLayer } from './basic.ts';

export function createAgentLayer(o: AgentLayerOptions): AgentLayer {
  const layer = new BasicAgentLayer({ width: o.layout.grid[0].length, height: o.layout.grid.length });
  return Object.assign(layer, { setTier() {} }) as unknown as AgentLayer;
}
