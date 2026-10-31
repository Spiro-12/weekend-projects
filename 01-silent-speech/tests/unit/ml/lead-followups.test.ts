import { describe, expect, it } from 'vitest';
import classes from '../../../shared/classes.json';
import type { ClassDef, MotionSample } from '../../../web/src/core/contracts';
import { synthDataset } from '../../../web/src/core/synth';
import { crossValidate, EXACT_LOO_MAX } from '../../../web/src/ml/eval';
import { train } from '../../../web/src/ml';

const cls = (classes as ClassDef[]).filter((c) => ['text_mom', 'volume_up', 'none'].includes(c.id));

// Heavy work: an explicit timeout so loaded or parallel runs (CI, 4 agents on one box) don't flake.
describe('lead follow ups after Track D review', { timeout: 60_000 }, () => {
  it('small sets use the exact LOO path (fast path == exact path bit for bit)', () => {
    const ds = synthDataset({ classes: cls, reps: 5, sessions: 1, seed: 3 });
    expect(ds.clips.length).toBeLessThanOrEqual(EXACT_LOO_MAX);
    const strip = (r: ReturnType<typeof crossValidate>) => r.map(({ ms, ...rest }) => { void ms; return rest; });
    const fast = strip(crossValidate(ds.clips, { L: 48 }, 'loo'));
    const exact = strip(crossValidate(ds.clips, { L: 48 }, 'loo', true));
    expect(fast).toEqual(exact);
  });

  it('a NaN training clip is rejected at train time with clip norm too', () => {
    const ds = synthDataset({ classes: cls, reps: 3, sessions: 1, seed: 4 });
    const bad = structuredClone(ds.clips);
    (bad[0].samples[5] as MotionSample).rr[0] = NaN;
    expect(() => train(bad, { norm: 'clip' })).toThrow(/non finite/);
  });
});
