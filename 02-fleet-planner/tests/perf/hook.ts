// The page side of the perf harness (scripts/perf.ts). Any page the harness measures exposes this on `window.__fp`.
// It follows PLAN §10 (`perf.cpuMs()`, `perf.gpuMs()`, `perf.tier`, `render.info()`) and adds two things the harness
// needs: `tour(name, seconds)` (a scripted camera path) and the optional `perf.drain()` (exact per-frame samples).
// Types only: no runtime code, so both the page bundle and the Node harness can import it.

export interface ViewInfo {
  id: string;
  /** Draw calls issued while rendering this view (shadow passes included). */
  calls: number;
  triangles: number;
}

export interface RenderInfo {
  /** Draw calls in the last frame, all views and post passes together. */
  calls: number;
  triangles: number;
  views?: ViewInfo[];
  /** Agent counts by kind, summed over all views (for example { robots: 300, people: 80 }). */
  agents?: Record<string, number>;
  /** Free-form labels the harness copies into its output (view mode, people mode, DPR, canvas size, ...). */
  labels?: Record<string, string | number | boolean>;
}

export interface PerfSamples {
  /** CPU ms inside the page's frame callback, one entry per rendered frame since the last drain. */
  cpu: number[];
  /** GPU ms for the same frames (EXT_disjoint_timer_query_webgl2), null where no result came back. */
  gpu: (number | null)[];
  /** Sync mode only: ms from frame start until the GPU finished the frame (1-pixel readback), same frames. */
  work?: number[];
}

export interface PerfHook {
  /** CPU ms spent inside the page's last frame callback (sim step, agent updates, render calls). */
  cpuMs(): number;
  /** GPU ms of the most recent frame whose timer query resolved, or null when timer queries are unavailable. */
  gpuMs(): number | null;
  /** Current quality tier ('high' | 'medium' | 'low' | 'lite'). */
  tier: string;
  /** Optional: per-frame samples since the last call, CPU and GPU paired by frame. When present the harness uses it
   *  instead of polling cpuMs()/gpuMs() once per animation frame. */
  drain?(): PerfSamples;
  /** Optional sync mode: wait for the GPU at the end of each frame (a 1-pixel readPixels; Chrome's gl.finish() does
   *  not wait) and report `work` in drain().
   *  A direct CPU + GPU figure that does not depend on timer queries. On ANGLE/Metal the timer query spans the
   *  frame's first to last GPU command, idle gaps included, so it reads high; `work` is the cross-check. */
  sync?(on: boolean): void;
  firstUsefulViewMs?: number;
}

export interface PerfPage {
  /** True once the first full frame has rendered. */
  ready: boolean;
  perf: PerfHook;
  render: { info(): RenderInfo };
  /** Drive the camera along a named path for `seconds` (real time); resolves when it ends. */
  tour(name: string, seconds: number): Promise<void>;
  /** Names `tour` accepts. */
  tours?: string[];
}

/** The window as the harness sees it. */
export type PerfWindow = Window & { __fp?: PerfPage };
