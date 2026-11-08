// ?perf=1 overlay (lead-owned): fps, CPU and GPU ms per frame, detail tier, GPU name. Spiro screenshots it on his phone.
import { useEffect, useState } from 'preact/hooks';

interface PerfInfo {
  fps: number;
  cpuP95: number;
  gpuP95: number | null;
  tier: string;
  gpu: string;
  drawCalls: number;
  triangles: number;
  agents: number;
}

export function PerfOverlay() {
  const [p, setP] = useState<PerfInfo | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      const perf = window.__fp?.perf;
      if (perf) setP(perf.summary());
    }, 500);
    return () => clearInterval(id);
  }, []);
  if (!p) return null;
  return (
    <div class="card perf" data-testid="perf-overlay">
      <div><b>{p.fps.toFixed(0)}</b> fps · tier <b>{p.tier}</b></div>
      <div>CPU p95 {p.cpuP95.toFixed(1)} ms · GPU p95 {p.gpuP95 === null ? 'n/a' : p.gpuP95.toFixed(1) + ' ms'}</div>
      <div>{p.drawCalls} draws · {(p.triangles / 1000).toFixed(0)}k tris · {p.agents} agents</div>
      <div style="color:var(--muted);max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{p.gpu}</div>
    </div>
  );
}
