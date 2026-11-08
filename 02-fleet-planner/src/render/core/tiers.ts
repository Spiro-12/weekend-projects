// Quality tiers and the adaptive monitor (PROTOCOL §9). Demote when p95 frame cost > 20 ms over 2 s; promote when
// p95 < 12 ms over 5 s. "Frame cost" is CPU + GPU time when GPU timing exists, else the rAF interval.
import type { Tier } from '../../host/index.ts';

export const TIERS: Tier[] = ['lite', 'low', 'medium', 'high'];

export interface TierSettings {
  dpr: number;
  bloom: boolean;
  shadows: boolean;
  farBoxes: boolean;
  antialias: boolean;
}

export function tierSettings(t: Tier): TierSettings {
  const dev = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  switch (t) {
    case 'high':
      return { dpr: Math.min(dev, 2), bloom: true, shadows: true, farBoxes: true, antialias: true };
    case 'medium':
      return { dpr: Math.min(dev, 1.5), bloom: false, shadows: false, farBoxes: true, antialias: true };
    case 'low':
      return { dpr: 1, bloom: false, shadows: false, farBoxes: false, antialias: false };
    case 'lite':
      return { dpr: 0.75, bloom: false, shadows: false, farBoxes: false, antialias: false };
  }
}

export function initialTier(): Tier {
  if (typeof matchMedia === 'undefined') return 'medium';
  const touch = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(innerWidth, innerHeight) < 600;
  return touch || small ? 'low' : 'medium';
}

export class TierMonitor {
  private bad = 0;
  private good = 0;
  frozen = false;
  constructor(public tier: Tier, private onChange: (t: Tier) => void) {}

  /** Call once per frame with this frame's cost in ms and the frame interval in ms. */
  sample(costMs: number, dtMs: number) {
    if (this.frozen) return;
    if (costMs > 20) {
      this.bad += dtMs;
      this.good = 0;
    } else if (costMs < 12) {
      this.good += dtMs;
      this.bad = Math.max(0, this.bad - dtMs / 4);
    } else {
      this.good = 0;
    }
    const i = TIERS.indexOf(this.tier);
    if (this.bad > 2000 && i > 0) this.set(TIERS[i - 1]);
    else if (this.good > 5000 && i < TIERS.length - 1) this.set(TIERS[i + 1]);
  }

  set(t: Tier) {
    this.bad = 0;
    this.good = 0;
    if (t === this.tier) return;
    this.tier = t;
    this.onChange(t);
  }
}
