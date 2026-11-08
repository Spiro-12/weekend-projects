// Test hooks (PROTOCOL §10): window.__fp. Used by e2e, the perf harness (tests/perf/hook.ts PerfPage), the visual
// shots and the clip capture.
import type { Host } from '../host/index.ts';
import type { LiveSim } from '../host/live.ts';
import type { Runner } from '../host/runner/types.ts';
import type { Group } from 'three';
import type { AgentLayer, WorldLayer } from '../render/core/layers.ts';
import type { PerfMonitor } from '../render/core/perf.ts';

export interface FpHooks {
  host: Host;
  sims: LiveSim[];
  runner: Runner;
  /** True once the first useful view has rendered (perf harness contract). */
  ready: boolean;
  whenReady: Promise<void>;
  render: {
    /** Last frame: draw calls and triangles over all views and passes, per-view breakdown, agent counts. */
    info(): {
      calls: number;
      triangles: number;
      views: { id: string; calls: number; triangles: number }[];
      agents: Record<string, number>;
      labels: Record<string, string | number | boolean>;
    };
    /** Screen position (CSS px) of an agent, or null. */
    project(agentId: number): { x: number; y: number } | null;
    /** Agent id at a screen position (CSS px), or null. */
    pick(x: number, y: number): number | null;
    cameraPose(): { position: number[]; target: number[] };
    following(): boolean;
    /** Scene roots (tests may hide e.g. agents to measure the world alone). */
    roots: { world: Group; agents: Group; fx: Group };
    /** The live layers, with their optional debug() info and the agent layer's inject() test hook. */
    layers: { world: WorldLayer; agents: AgentLayer };
  };
  perf: PerfMonitor;
  /** Drive the camera along a named path for `seconds` of real time; resolves at the end. */
  tour(name: string, seconds?: number): Promise<void>;
  tours: string[];
  /** Freeze or unfreeze the live sim (screenshots). */
  freeze(on: boolean): void;
}
