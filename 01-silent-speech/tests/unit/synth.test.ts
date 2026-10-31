import { describe, expect, it } from 'vitest';
import classes from '../../shared/classes.json';
import type { ClassDef, MotionSample } from '../../web/src/core/contracts';
import { MotionSynth, countSyllables, synthClip, synthDataset } from '../../web/src/core/synth';

const cls = classes as ClassDef[];
const energy = (s: MotionSample[]) => s.reduce((a, x) => a + x.rr[0] ** 2, 0) / Math.max(1, s.length);

describe('synth', () => {
  it('is deterministic for a seed', () => {
    expect(synthClip(cls[0], 5)).toEqual(synthClip(cls[0], 5));
    expect(synthClip(cls[0], 5)).not.toEqual(synthClip(cls[0], 6));
  });

  it('counts syllables roughly right', () => {
    expect(countSyllables('Turn the volume up')).toBe(5);
    expect(countSyllables('I created this demo in 48 hours')).toBeGreaterThanOrEqual(10);
  });

  it('streams at 25 Hz with increasing seq', () => {
    const s = new MotionSynth(1).range(0, 2);
    expect(s.length).toBe(50);
    for (let i = 1; i < s.length; i++) expect(s[i].seq).toBe(s[i - 1].seq + 1);
  });

  it('utterances carry much more energy than silence', () => {
    const m = new MotionSynth(2);
    const { t0, t1 } = m.utter(cls[0], 3);
    const quiet = m.range(0.5, 2.5);
    const talk = m.range(t0, t1);
    expect(energy(talk)).toBeGreaterThan(5 * energy(quiet));
  });

  it('drops samples when asked, seq shows the gap', () => {
    const s = new MotionSynth(3, { dropRate: 0.3 }).range(0, 4);
    expect(s.length).toBeLessThan(90);
    expect(s.some((x, i) => i > 0 && x.seq - s[i - 1].seq > 1)).toBe(true);
  });

  it('dataset has every class x reps x sessions', () => {
    const ds = synthDataset({ classes: cls, reps: 2, sessions: 2, seed: 1 });
    expect(ds.clips.length).toBe(cls.length * 4);
    expect(new Set(ds.clips.map((c) => c.session))).toEqual(new Set(['s1', 's2']));
  });
});
