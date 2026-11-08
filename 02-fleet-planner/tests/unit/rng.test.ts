import { describe, expect, it } from 'vitest';
import { Rng, hash32, stream, fnv1a32 } from '../../src/sim/rng.ts';

describe('rng', () => {
  it('is deterministic per seed and stream', () => {
    const a = stream(42, 'arrivals');
    const b = stream(42, 'arrivals');
    const c = stream(42, 'humans');
    const xs = Array.from({ length: 5 }, () => a.u32());
    expect(Array.from({ length: 5 }, () => b.u32())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c.u32())).not.toEqual(xs);
  });
  it('pins the first values (cross-engine reference)', () => {
    const r = new Rng(1);
    expect([r.u32(), r.u32(), r.u32()]).toMatchSnapshot();
    expect(hash32(42, 7, 3)).toMatchSnapshot();
    expect(fnv1a32('arrivals')).toMatchSnapshot();
  });
  it('int(n) is uniform enough and in range', () => {
    const r = new Rng(7);
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) counts[r.int(10)]++;
    for (const k of counts) expect(Math.abs(k - 10_000)).toBeLessThan(500);
  });
  it('produces only integers', () => {
    const r = new Rng(3);
    for (let i = 0; i < 1000; i++) expect(Number.isInteger(r.u32())).toBe(true);
  });
});
