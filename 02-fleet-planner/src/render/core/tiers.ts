// Quality tiers and the adaptive monitor (PROTOCOL §9, tuned by spike a on Spiro's M2 Air):
// - demote when the frame interval runs > 20 ms for 2 s (works everywhere, rAF based);
// - promote only when GPU timing exists and CPU p95 + GPU p50 × (next tier's cost ratio) < 14 ms for 5 s
//   (high ≈ 2.7× medium, medium ≈ 1.3× low); never promote without timer queries (iOS Safari);
// - no promotion for 60 s after a demotion.
import type { Tier } from '../../host/index.ts';

export const TIERS: Tier[] = ['lite', 'low', 'medium', 'high'];

export interface TierSettings {
  dpr: number;
  bloom: boolean;
  /** Bloom render-target scale (half-size mips on high: full size costs ~8 ms on an M2 Air at 2880×1800). */
  bloomScale: number;
  shadows: boolean;
  farBoxes: boolean;
  antialias: boolean;
}

export function tierSettings(t: Tier): TierSettings {
  const dev = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  switch (t) {
    case 'high':
      return { dpr: Math.min(dev, 1.5), bloom: true, bloomScale: 0.5, shadows: true, farBoxes: true, antialias: false }; // bloom renders to its own target; canvas MSAA would be unused (Track E)
    case 'medium':
      return { dpr: Math.min(dev, 1.5), bloom: false, bloomScale: 0, shadows: false, farBoxes: true, antialias: true };
    case 'low':
      return { dpr: 1, bloom: false, bloomScale: 0, shadows: false, farBoxes: false, antialias: false };
    case 'lite':
      return { dpr: 0.75, bloom: false, bloomScale: 0, shadows: false, farBoxes: false, antialias: false };
  }
}

export function initialTier(): Tier {
  if (typeof matchMedia === 'undefined') return 'medium';
  const touch = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(innerWidth, innerHeight) < 600;
  return touch || small ? 'low' : 'medium';
}

/** Cost of the next tier up relative to the current one (spike a). */
const PROMOTE_RATIO: Record<Tier, number> = { lite: 1.3, low: 1.3, medium: 2.7, high: 1 };

export class TierMonitor {
  private bad = 0;
  private good = 0;
  private lastDemote = -Infinity;
  frozen = false;
  constructor(public tier: Tier, private onChange: (t: Tier) => void) {}

  /**
   * Call once per frame. `intervalMs` = time since the previous frame; `cpuP95` = recent CPU p95 per frame;
   * `gpuP50` = recent GPU timer p50, or null when the browser has no timer queries.
   */
  sample(intervalMs: number, cpuP95: number, gpuP50: number | null, now: number) {
    if (this.frozen) return;
    if (intervalMs > 20) {
      this.bad += intervalMs;
      this.good = 0;
    } else {
      this.bad = Math.max(0, this.bad - intervalMs / 4);
      const i = TIERS.indexOf(this.tier);
      const canPromote = gpuP50 !== null && i < TIERS.length - 1 && now - this.lastDemote > 60_000;
      if (canPromote && cpuP95 + gpuP50 * PROMOTE_RATIO[this.tier] < 14) this.good += intervalMs;
      else this.good = 0;
    }
    const i = TIERS.indexOf(this.tier);
    if (this.bad > 2000 && i > 0) {
      this.lastDemote = now;
      this.set(TIERS[i - 1]);
    } else if (this.good > 5000 && i < TIERS.length - 1) this.set(TIERS[i + 1]);
  }

  set(t: Tier) {
    this.bad = 0;
    this.good = 0;
    if (t === this.tier) return;
    this.tier = t;
    this.onChange(t);
  }
}
