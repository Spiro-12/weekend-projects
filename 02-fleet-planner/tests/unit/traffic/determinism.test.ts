// Determinism: the same input sequence gives the same outputs and stateWords (PROTOCOL §8).
import { describe, expect, it } from 'vitest';
import { CentralController } from '../../../src/sim/traffic/central/index.ts';
import { createPlan, type TrafficAgent, type TrafficInput } from '../../../src/sim/traffic/types.ts';
import { Harness, mix } from './harness.ts';

const opts = { robots: mix(60), pickers: 14, drivers: 2, pocketGoalPct: 10, digest: true };
const ser = (x: unknown) => JSON.stringify(x, (_, v) => (ArrayBuffer.isView(v) ? Array.from(v as Int32Array) : v));
const copy = (input: TrafficInput): TrafficInput => ({
  ...input,
  agents: input.agents.map((a) => (a ? { ...a } : null)) as (TrafficAgent | null)[],
  order: [...input.order],
  ready: input.ready.slice(),
  occ: input.occ.slice(),
  yields: [...input.yields],
});

function run(seed: number, ticks: number): { digest: number; words: number[] } {
  const c = new CentralController();
  const h = new Harness({ ...opts, seed, controller: c });
  h.run(ticks);
  return { digest: h.digest, words: c.stateWords() };
}

describe('one brain: determinism', () => {
  it('same seed: same outputs every tick (digest) and same stateWords; another seed differs', () => {
    const a = run(7, 3000);
    const b = run(7, 3000);
    expect(b.digest).toBe(a.digest);
    expect(b.words).toEqual(a.words);
    expect(a.words.every((x) => Number.isSafeInteger(x))).toBe(true);
    expect(run(8, 3000).digest).not.toBe(a.digest);
  });

  it('a fresh controller fed the recorded inputs reproduces every reset, output, event and the state', () => {
    // 150 robots for 2,000 ticks so manual resets (5 min without progress) happen too
    const before: TrafficInput[] = [];
    const after: TrafficInput[] = [];
    const outputs: string[] = [];
    const c1 = new CentralController();
    const h = new Harness({
      ...opts, robots: mix(150), seed: 11, controller: c1,
      onRecover: (input) => before.push(copy(input)),
      onPlan: (input, out, resets) => {
        after.push(copy(input));
        outputs.push(ser([out, resets]));
      },
    });
    h.run(2000);
    expect(h.resets).toBeGreaterThan(0);
    expect(h.events.detour).toBeGreaterThan(0);
    expect(h.events.yield).toBeGreaterThan(0);

    const c2 = new CentralController();
    for (let i = 0; i < before.length; i++) {
      const rec = c2.recover(before[i]);
      const out = createPlan(h.out.moveTo.length);
      c2.plan(after[i], out);
      expect(ser([out, rec.resets])).toBe(outputs[i]);
      expect(rec.retasks).toEqual([]);
    }
    expect(c2.stateWords()).toEqual(c1.stateWords());
  });
});
