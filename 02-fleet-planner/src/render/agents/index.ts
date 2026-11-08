// Agent layer entry (Track E, PROTOCOL §9): cart robots, autonomous and driven forklifts, humanoids and people as
// instanced rig meshes, route ribbons, glow discs, selection / blocked / deadlock markers, the hero worker, hover
// and deadlock labels, and high-tier bloom. See layer.ts.
import type { AgentLayer, AgentLayerOptions } from '../core/layers.ts';
import { AgentLayerImpl } from './layer.ts';

export function createAgentLayer(o: AgentLayerOptions): AgentLayer {
  return new AgentLayerImpl(o);
}
