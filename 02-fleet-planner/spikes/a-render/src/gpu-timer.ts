// GPU frame time via EXT_disjoint_timer_query_webgl2. One TIME_ELAPSED query wraps all GL work of a frame; results
// arrive a few frames later and are matched back to their frame number. Disjoint results are dropped.

interface Pending {
  q: WebGLQuery;
  frame: number;
}

export class GpuTimer {
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private free: WebGLQuery[] = [];
  private pending: Pending[] = [];
  private active: Pending | null = null;
  /** Latest resolved GPU ms. */
  last: number | null = null;

  constructor(private gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get available(): boolean {
    return this.ext !== null;
  }

  begin(frame: number): void {
    if (!this.ext || this.active) return;
    if (this.pending.length > 8) return; // GPU far behind: skip this frame rather than pile up queries
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = { q, frame };
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Collect finished queries: calls `onResult(frame, ms)` for each. */
  poll(onResult: (frame: number, ms: number) => void): void {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const p = this.pending[0];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number;
      this.free.push(p.q);
      if (disjoint) continue;
      this.last = ns / 1e6;
      onResult(p.frame, this.last);
    }
  }
}
