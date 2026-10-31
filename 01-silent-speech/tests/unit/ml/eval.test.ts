import { describe, expect, it } from 'vitest';
import type { Clip, Metrics } from '../../../web/src/core/contracts';
import { NONE } from '../../../web/src/core/contracts';
import { evaluate, train } from '../../../web/src/ml/index';
import { crossValidate, metricsFrom, type FoldResult } from '../../../web/src/ml/eval';
import { syntheticDataset } from './helpers';

const clips = (): Clip[] => syntheticDataset().clips;

function checkShape(m: Metrics, protocol: 'loo' | 'loso') {
  expect(m.model).toBe('dtw-knn');
  expect(m.protocol).toBe(protocol);
  expect(m.nClips).toBe(120);
  expect(m.labels.length).toBe(8);
  expect(m.confusion.length).toBe(8);
  expect(m.confusion.every((r) => r.length === 8)).toBe(true);
  expect(m.confusion.flat().reduce((a, b) => a + b, 0)).toBe(120);
  expect(m.confusion.map((r) => r.reduce((a, b) => a + b, 0))).toEqual(new Array(8).fill(15));
  const diag = m.confusion.reduce((a, r, i) => a + r[i], 0);
  expect(m.accuracy).toBeCloseTo(diag / 120, 12);
  expect(m.macroF1).toBeGreaterThan(0);
  expect(m.macroF1).toBeLessThanOrEqual(1);
  expect(m.noneFalseAcceptRate).toBeGreaterThanOrEqual(0);
  expect(m.params).toMatchObject({ L: 64, band: 0.1, k: 1, norm: 'global', radius: 6 });
  expect(m.inferMsPerClip).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(m.generatedAt))).toBe(false);
}

describe('evaluate on the synthetic fixture', () => {
  /** Share of correct, non none held out predictions that were accepted at the default threshold 0.5. */
  const correctAccepted = (res: FoldResult[]) => {
    const ok = res.filter((r) => r.label === r.predicted && r.label !== NONE);
    return ok.filter((r) => r.accepted).length / ok.length;
  };

  it('(d) LOSO accuracy >= 0.95, and >= 90% of correct predictions accepted', () => {
    const m = evaluate(clips(), {}, 'loso');
    checkShape(m, 'loso');
    expect(m.accuracy).toBeGreaterThanOrEqual(0.95);
    expect(correctAccepted(crossValidate(clips(), {}, 'loso'))).toBeGreaterThanOrEqual(0.9);
  }, 60_000);

  it('(d) LOO accuracy >= 0.95, and >= 90% of correct predictions accepted', () => {
    const res = crossValidate(clips(), {}, 'loo');
    const m = metricsFrom(res, 'loo', { L: 64, band: 0.1, k: 1, norm: 'global', radius: 6 });
    checkShape(m, 'loo');
    expect(m.accuracy).toBeGreaterThanOrEqual(0.95);
    expect(correctAccepted(res)).toBeGreaterThanOrEqual(0.9);
  }, 60_000);

  it('predict < 20 ms with 120 templates', () => {
    const model = train(clips());
    const cs = clips();
    for (let i = 0; i < 10; i++) model.predict(cs[i].samples); // warm up the JIT
    const ms: number[] = [];
    for (let i = 0; i < 40; i++) ms.push(model.predict(cs[(i * 7) % cs.length].samples).ms);
    ms.sort((a, b) => a - b);
    expect(ms[Math.floor(ms.length / 2)]).toBeLessThan(20); // median: some slack for slow CI machines
  });

  it('dedupes by id before evaluating', () => {
    const cs = clips();
    const m = evaluate([...cs, ...cs.slice(0, 30)], {}, 'loso');
    expect(m.nClips).toBe(120);
  });

  it('LOSO folds use only the other sessions (norm stats included)', () => {
    const cs = clips();
    const res = crossValidate(cs, {}, 'loso');
    for (const s of ['s1', 's2', 's3']) {
      const model = train(cs.filter((c) => c.session !== s));
      cs.forEach((c, i) => {
        if (c.session !== s) return;
        const p = model.predict(c.samples);
        expect(res[i]).toMatchObject({ id: c.id, predicted: p.label, confidence: p.confidence, accepted: p.accepted });
      });
    }
  });

  it('LOO folds leave exactly the one clip out', () => {
    const cs = clips().filter((c) => c.session === 's1').slice(0, 12);
    const res = crossValidate(cs, {}, 'loo');
    cs.forEach((c, i) => {
      const p = train(cs.filter((_, j) => j !== i)).predict(c.samples);
      expect(res[i]).toMatchObject({ predicted: p.label, confidence: p.confidence });
    });
  });

  it('LOSO needs 2 sessions, LOO needs 2 clips', () => {
    const s1 = clips().filter((c) => c.session === 's1');
    expect(() => evaluate(s1, {}, 'loso')).toThrow(/2 sessions/);
    expect(() => evaluate(s1.slice(0, 1), {}, 'loo')).toThrow(/2 clips/);
  });
});

describe('metrics', () => {
  const r = (label: string, predicted: string, accepted = predicted !== NONE) =>
    ({ id: `${label}-${predicted}-${Math.random()}`, label, predicted, confidence: 0.9, accepted, ms: 1 });

  it('accuracy, confusion, macro F1 (sklearn style) and none false accepts', () => {
    const res = [r('a', 'a'), r('a', 'b'), r('b', 'b'), r(NONE, NONE), r(NONE, 'a'), r(NONE, 'b', false)];
    const m = metricsFrom(res, 'loo', {});
    expect(m.labels).toEqual(['a', 'b', 'none']);
    expect(m.confusion).toEqual([[1, 1, 0], [0, 1, 0], [1, 1, 1]]);
    expect(m.accuracy).toBeCloseTo(3 / 6, 12);
    // F1: a = 2*1/(2+2) = 0.5, b = 2*1/(1+3) = 0.5, none = 2*1/(3+1) = 0.5
    expect(m.macroF1).toBeCloseTo(0.5, 12);
    expect(m.noneFalseAcceptRate).toBeCloseTo(1 / 3, 12);
    expect(m.inferMsPerClip).toBe(1);
  });

  it('no none clips -> false accept rate 0', () => {
    expect(metricsFrom([r('a', 'a')], 'loso', {}).noneFalseAcceptRate).toBe(0);
  });
});
