import { describe, expect, it } from 'vitest';
import { TierMonitor } from '../../src/render/core/tiers.ts';

describe('TierMonitor', () => {
  it('demotes after 2 s of slow frames, then waits 60 s before promoting again', () => {
    const seen: string[] = [];
    const m = new TierMonitor('medium', (t) => seen.push(t));
    let now = 0;
    for (let k = 0; k < 100; k++) m.sample(30, 25, 20, (now += 30));
    expect(m.tier).toBe('low');
    for (let k = 0; k < 400; k++) m.sample(16, 2, 3, (now += 16)); // fast, but inside the cool-down
    expect(m.tier).toBe('low');
    now += 60_000;
    for (let k = 0; k < 400; k++) m.sample(16, 2, 3, (now += 16));
    expect(m.tier).toBe('medium');
    expect(seen).toEqual(['low', 'medium']);
  });
  it('never promotes without GPU timing (iOS Safari)', () => {
    const m = new TierMonitor('low', () => {});
    let now = 100_000;
    for (let k = 0; k < 1000; k++) m.sample(16, 1, null, (now += 16));
    expect(m.tier).toBe('low');
  });
  it('promotes medium to high only when the high tier would fit (×2.7 GPU)', () => {
    const m = new TierMonitor('medium', () => {});
    let now = 100_000;
    for (let k = 0; k < 600; k++) m.sample(16, 4, 4, (now += 16)); // 4 + 4×2.7 = 14.8 ≥ 14
    expect(m.tier).toBe('medium');
    for (let k = 0; k < 600; k++) m.sample(16, 3, 3, (now += 16)); // 3 + 8.1 = 11.1 < 14
    expect(m.tier).toBe('high');
  });
});
