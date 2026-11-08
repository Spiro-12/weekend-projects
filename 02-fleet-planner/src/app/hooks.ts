// Test hooks (PROTOCOL §10): window.__fp. Used by e2e, the perf harness, the visual shots and the clip capture.
import type { Host } from '../host/index.ts';
import type { LiveSim } from '../host/live.ts';
import type { Runner } from '../host/runner/types.ts';
import type { PerfMonitor } from '../render/core/perf.ts';

export interface FpHooks {
  host: Host;
  sims: LiveSim[];
  runner: Runner;
  render: {
    info(): { drawCalls: number; triangles: number; geometries: number; textures: number };
    /** Screen position (CSS px) of an agent, or null. */
    project(agentId: number): { x: number; y: number } | null;
    /** Agent id at a screen position (CSS px), or null. */
    pick(x: number, y: number): number | null;
    cameraPose(): { position: number[]; target: number[] };
    following(): boolean;
  };
  perf: PerfMonitor & { firstUsefulViewMs: number | null; fullLookMs: number | null };
  /** Run a named camera tour (perf harness). Resolves when done. */
  tour(name: string): Promise<void>;
  /** Freeze or unfreeze the live sim (screenshots). */
  freeze(on: boolean): void;
  ready: Promise<void>;
}
