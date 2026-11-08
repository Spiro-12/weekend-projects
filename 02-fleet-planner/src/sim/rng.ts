// Seeded randomness for the sim (PROTOCOL §8). Integer math only: same seed => same numbers in every JS engine.
// sfc32 (Chris Doty-Humphrey's Small Fast Counting generator, 32-bit), seeded through SplitMix32.

/** 32-bit FNV-1a hash of a string (stream names, scenario ids). */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** SplitMix32 finalizer: a strong 32-bit integer mix. */
export function mix32(x: number): number {
  x = (x + 0x9e3779b9) | 0;
  let t = x ^ (x >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  t ^= t >>> 15;
  return t >>> 0;
}

/** Counter-based random uint32 from (seed, a, b, c). Used where results must not depend on call order,
 *  e.g. the contents of order #n (`orderLines(seed, n)`) are the same at any order rate and any fleet. */
export function hash32(seed: number, a: number, b = 0, c = 0): number {
  let h = mix32(seed >>> 0);
  h = mix32((h ^ (a >>> 0)) >>> 0);
  h = mix32((h ^ Math.imul(b >>> 0, 0x85ebca6b)) >>> 0);
  h = mix32((h ^ Math.imul(c >>> 0, 0xc2b2ae35)) >>> 0);
  return h;
}

/** Uniform integer in [0, n) from a uint32 (n <= 2^21 keeps the product exact). */
export function scale(u32: number, n: number): number {
  return Math.floor(((u32 >>> 0) * n) / 4294967296);
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const next = () => (s = mix32(s));
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = 1;
    for (let i = 0; i < 12; i++) this.u32(); // warm up
  }

  /** Next uint32. */
  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform integer in [0, n). n must be a positive integer <= 2^21. */
  int(n: number): number {
    return scale(this.u32(), n);
  }

  /** True with probability num/den (integers, den <= 2^21). */
  chance(num: number, den: number): boolean {
    return this.int(den) < num;
  }

  /** Pick one element. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  /** Deterministic in-place Fisher-Yates shuffle. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Internal state, for hashing and snapshots. */
  state(): [number, number, number, number] {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }
}

/** Named, independent stream derived from the master seed: `stream(seed, 'arrivals')`. */
export function stream(seed: number, name: string): Rng {
  return new Rng(mix32((seed >>> 0) ^ fnv1a32(name)));
}

/** Stream names used by the sim (PROTOCOL §8). Per-vendor streams are `tiebreak:<vendor>` and `ladder:<vendor>`. */
export const STREAMS = ['arrivals', 'humans', 'faults', 'battery', 'physical', 'spawn'] as const;
