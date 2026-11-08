// Frame timing: CPU ms per frame (time spent in our frame callback), GPU ms via EXT_disjoint_timer_query_webgl2 when
// the browser offers it, and fps from rAF intervals. The perf harness and ?perf=1 read summary().
import type { WebGLRenderer } from 'three';

const N = 240;

class Ring {
  private a = new Float64Array(N);
  private n = 0;
  private i = 0;
  push(v: number) {
    this.a[this.i] = v;
    this.i = (this.i + 1) % N;
    if (this.n < N) this.n++;
  }
  p(q: number): number {
    if (!this.n) return 0;
    const s = Array.from(this.a.subarray(0, this.n)).sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
  }
  mean(): number {
    let t = 0;
    for (let k = 0; k < this.n; k++) t += this.a[k];
    return this.n ? t / this.n : 0;
  }
  get size() {
    return this.n;
  }
  clear() {
    this.n = 0;
    this.i = 0;
  }
}

/** Per-frame samples since the last drain (perf harness, tests/perf/hook.ts). */
interface Frame {
  cpu: number;
  gpu: number | null;
}

export class PerfMonitor {
  readonly cpu = new Ring();
  readonly gpu = new Ring();
  readonly frame = new Ring();
  gpuName = 'unknown';
  tier = 'medium';
  agents = 0;
  drawCalls = 0;
  triangles = 0;
  private gl: WebGL2RenderingContext | null = null;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private queries: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private activeFrame: Frame | null = null;
  private queryFrame = new Map<WebGLQuery, Frame>();
  private last = 0;
  private frames: Frame[] = [];
  private work: number[] = [];
  private lastCpu = 0;
  private lastGpu: number | null = null;
  /** Sync mode: the renderer waits for the GPU each frame (1-pixel readback) and reports `work`. */
  syncMode = false;
  firstUsefulViewMs: number | null = null;
  fullLookMs: number | null = null;

  attach(renderer: WebGLRenderer) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.gl = gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  beginFrame(now: number) {
    if (this.last) this.frame.push(now - this.last);
    this.last = now;
    this.activeFrame = { cpu: 0, gpu: null };
    if (this.gl && this.ext && !this.active) {
      const q = this.gl.createQuery();
      if (q) {
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
        this.active = q;
        this.queryFrame.set(q, this.activeFrame);
      }
    }
  }

  /** Sync mode: time from frame start until the GPU finished it. */
  pushWork(ms: number) {
    this.work.push(ms);
  }

  endFrame(cpuMs: number) {
    this.cpu.push(cpuMs);
    this.lastCpu = cpuMs;
    if (this.activeFrame) {
      this.activeFrame.cpu = cpuMs;
      this.frames.push(this.activeFrame);
      if (this.frames.length > 20_000) this.frames.splice(0, 10_000);
      this.activeFrame = null;
    }
    const gl = this.gl;
    const ext = this.ext;
    if (gl && ext && this.active) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      this.queries.push(this.active);
      this.active = null;
    }
    if (gl && ext) {
      while (this.queries.length) {
        const q = this.queries[0];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        this.queries.shift();
        const frame = this.queryFrame.get(q);
        this.queryFrame.delete(q);
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          const ms = Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6;
          this.gpu.push(ms);
          this.lastGpu = ms;
          if (frame) frame.gpu = ms;
        }
        gl.deleteQuery(q);
      }
    }
  }

  // ── tests/perf/hook.ts PerfHook ──
  cpuMs(): number {
    return this.lastCpu;
  }
  gpuMs(): number | null {
    return this.lastGpu;
  }
  drain(): { cpu: number[]; gpu: (number | null)[]; work?: number[] } {
    const f = this.frames;
    this.frames = [];
    const work = this.syncMode ? this.work : undefined;
    this.work = [];
    return { cpu: f.map((x) => x.cpu), gpu: f.map((x) => x.gpu), work };
  }
  sync(on: boolean) {
    this.syncMode = on;
    this.work = [];
  }

  reset() {
    this.cpu.clear();
    this.gpu.clear();
    this.frame.clear();
  }

  summary() {
    const fm = this.frame.mean();
    return {
      fps: fm > 0 ? 1000 / fm : 0,
      frameP95: this.frame.p(0.95),
      cpuP50: this.cpu.p(0.5),
      cpuP95: this.cpu.p(0.95),
      gpuP95: this.gpu.size ? this.gpu.p(0.95) : null,
      gpuP50: this.gpu.size ? this.gpu.p(0.5) : null,
      tier: this.tier,
      gpu: this.gpuName,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      agents: this.agents,
      samples: this.cpu.size,
    };
  }
}
