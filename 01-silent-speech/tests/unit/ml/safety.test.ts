// An accepted prediction can text real people (Phase 2), so out of vocabulary input must be rejected.
// Cases from the Track D review: small models used to accept noise and other sentences.
import { describe, expect, it } from 'vitest';
import type { DatasetClip, MotionSample } from '../../../web/src/core/contracts';
import { NONE } from '../../../web/src/core/contracts';
import type { DtwKnnModel } from '../../../web/src/ml/index';
import { train } from '../../../web/src/ml/index';
import { noiseSet, syntheticDataset, whiteNoise } from './helpers';

const clips = (): DatasetClip[] => syntheticDataset().clips;
const only = (labels: string[], cs = clips()) => cs.filter((c) => labels.includes(c.label));
const except = (labels: string[], cs = clips()) => cs.filter((c) => !labels.includes(c.label));
const acceptRate = (m: DtwKnnModel, xs: MotionSample[][]) => xs.filter((s) => m.predict(s).accepted).length / xs.length;
const noise = noiseSet(); // 80 clips: white, band limited and speech like random bursts, several loudness levels

describe('safety: out of vocabulary input is rejected', () => {
  it('(a) a 1 class model never accepts (capped below the threshold), not even noise', () => {
    const m = train(only(['text_mom']));
    for (const s of noise) {
      const p = m.predict(s);
      expect(p.accepted).toBe(false);
      expect(p.confidence).toBeLessThanOrEqual(m.threshold / 2);
    }
    expect(acceptRate(m, only(['text_mom']).map((c) => c.samples))).toBe(0);
    m.threshold = 0.8; // the cap follows the threshold
    expect(Math.max(...noise.map((s) => m.predict(s).confidence))).toBeLessThanOrEqual(0.4);
  });

  it('(a) a model with a single template per class (dRef undefined) never accepts', () => {
    const one = clips().filter((c) => c.session === 's1' && c.rep === 0);
    expect(new Set(one.map((c) => c.label)).size).toBe(one.length);
    const m = train(one);
    expect(acceptRate(m, clips().map((c) => c.samples))).toBe(0);
    expect(acceptRate(m, noise)).toBe(0);
  });

  it('(b) text_mom + none model: <= 5% of noise clips, <= 10% of other sentence clips accepted', () => {
    const m = train(only(['text_mom', NONE]));
    expect(acceptRate(m, noise)).toBeLessThanOrEqual(0.05);
    const other = except(['text_mom', NONE]).map((c) => c.samples); // 90 clips of the 6 other sentences
    expect(acceptRate(m, other)).toBeLessThanOrEqual(0.1);
  });

  it('(c) 3 class pilot size model (5 takes per class) accepts <= 10% of out of vocabulary sentences', () => {
    const pilotLabels = ['text_mom', 'volume_up', NONE];
    const pilot = only(pilotLabels).filter((c) => c.session === 's1');
    expect(pilot.length).toBe(15);
    const m = train(pilot);
    expect(acceptRate(m, except(pilotLabels).map((c) => c.samples))).toBeLessThanOrEqual(0.1); // 75 clips
    expect(acceptRate(m, noise)).toBeLessThanOrEqual(0.05);
  });

  it('a model with no none takes still rejects stillness and almost all none clips', () => {
    const m = train(except([NONE]));
    expect(acceptRate(m, only([NONE]).map((c) => c.samples))).toBeLessThanOrEqual(0.1);
    expect(acceptRate(m, whiteNoise(20, 11, 0.05))).toBe(0); // sensor noise only: nobody moved
  });

  it('the full 8 class model rejects every noise clip', () => {
    expect(acceptRate(train(clips()), noise)).toBe(0);
  });
});
