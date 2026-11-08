// ?perf=1 overlay: fps, CPU and GPU ms, draw calls, triangles, tier, GPU name. Updated 4 times a second.
export class Hud {
  private el: HTMLDivElement;
  private frames: number[] = [];
  private cpu: number[] = [];
  private gpu: number[] = [];
  private last = 0;

  constructor(private gpuName: string) {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;left:8px;top:8px;z-index:10;font:12px/1.4 ui-monospace,Menlo,monospace;color:#e5e7eb;' +
      'background:rgba(10,12,18,0.72);padding:6px 8px;border-radius:6px;white-space:pre;pointer-events:none';
    document.body.appendChild(this.el);
  }

  push(frameMs: number, cpuMs: number, gpuMs: number | null, now: number, info: () => string): void {
    this.frames.push(frameMs);
    this.cpu.push(cpuMs);
    if (gpuMs !== null) this.gpu.push(gpuMs);
    if (now - this.last < 250) return;
    this.last = now;
    const p = (a: number[], q: number) => {
      if (!a.length) return NaN;
      const s = [...a].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(q * s.length))];
    };
    const f50 = p(this.frames, 0.5);
    this.el.textContent =
      `${(1000 / f50).toFixed(0)} fps  frame p95 ${p(this.frames, 0.95).toFixed(1)} ms\n` +
      `cpu p50 ${p(this.cpu, 0.5).toFixed(2)} p95 ${p(this.cpu, 0.95).toFixed(2)} ms\n` +
      `gpu p50 ${p(this.gpu, 0.5).toFixed(2)} p95 ${p(this.gpu, 0.95).toFixed(2)} ms\n` +
      `${info()}\n${this.gpuName}`;
    // Keep about 2 s of history.
    for (const a of [this.frames, this.cpu, this.gpu]) if (a.length > 120) a.splice(0, a.length - 120);
  }
}
