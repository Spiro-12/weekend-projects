import { describe, expect, it } from 'vitest';
import type { Clip, Metrics } from '../../../web/src/core/contracts';
import { NONE } from '../../../web/src/core/contracts';
import classes from '../../../shared/classes.json';
import type { ClassDef } from '../../../web/src/core/contracts';
import { synthDataset } from '../../../web/src/core/synth';
import { dtw, evaluate, train } from '../../../web/src/ml/index';
import { crossValidate, metricsFrom, twoNearestSameClass, type FoldResult } from '../../../web/src/ml/eval';
import { applyNorm, computeNorm, preprocessRaw, resolveOpts, toF32 } from '../../../web/src/ml/preprocess';
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

  it('exact LOO folds leave exactly the one clip out', () => {
    const cs = clips().filter((c) => c.session === 's1').slice(0, 12);
    const res = crossValidate(cs, {}, 'loo', true);
    cs.forEach((c, i) => {
      const p = train(cs.filter((_, j) => j !== i)).predict(c.samples);
      expect(res[i]).toMatchObject({ predicted: p.label, confidence: p.confidence });
    });
  });

  it('fast LOO (shared dRef shortcut) gives the exact labels; confidence only moves a little', () => {
    const fast = crossValidate(clips(), {}, 'loo');
    const exact = crossValidate(clips(), {}, 'loo', true);
    expect(fast.map((r) => r.predicted)).toEqual(exact.map((r) => r.predicted));
    for (let i = 0; i < fast.length; i++) expect(Math.abs(fast[i].confidence - exact[i].confidence)).toBeLessThan(0.01);
    expect(fast.map((r) => r.accepted)).toEqual(exact.map((r) => r.accepted));
    // small data is where one clip moves the norm stats most: a 15 clip pilot
    const pilot = clips().filter((c) => c.session === 's1' && ['text_mom', 'volume_up', NONE].includes(c.label));
    const pf = crossValidate(pilot, {}, 'loo'), pe = crossValidate(pilot, {}, 'loo', true);
    expect(pf.map((r) => r.predicted)).toEqual(pe.map((r) => r.predicted));
    for (let i = 0; i < pf.length; i++) expect(Math.abs(pf[i].confidence - pe[i].confidence)).toBeLessThan(0.06);
  }, 60_000);

  it('LOO on 240 clips is fast (< 3 s CPU; the old per fold dRef took ~15 s) and matches exact folds', () => {
    const big = synthDataset({ classes: classes as ClassDef[], reps: 10, sessions: 3, seed: 21, dropRate: 0.02 }).clips;
    expect(big.length).toBe(240);
    const cpu0 = process.cpuUsage();
    const fast = crossValidate(big, {}, 'loo');
    const cpu = process.cpuUsage(cpu0);
    expect((cpu.user + cpu.system) / 1e3).toBeLessThan(3000);
    for (let i = 0; i < big.length; i += 10) { // the slow, exact path on every 10th fold
      const p = train(big.filter((_, j) => j !== i)).predict(big[i].samples);
      expect(fast[i].predicted).toBe(p.label);
      expect(Math.abs(fast[i].confidence - p.confidence)).toBeLessThan(0.01);
    }
  }, 60_000);

  it('twoNearestSameClass matches brute force', () => {
    const cs = clips().filter((c) => c.session === 's2').slice(0, 24);
    const o = resolveOpts();
    const raws = cs.map((c) => preprocessRaw(c.samples, o));
    const norm = computeNorm(raws, 'global', 6);
    const X = raws.map((r) => toF32(applyNorm(r, 'global', norm)));
    const { d1, i1, d2 } = twoNearestSameClass(cs.map((c) => c.label), raws, o);
    cs.forEach((c, a) => {
      const ds = cs.map((u, b) => (b !== a && u.label === c.label ? dtw(X[a], X[b], 6) : Infinity));
      const sorted = [...ds].sort((p, q) => p - q);
      expect(d1[a]).toBeCloseTo(sorted[0], 9);
      expect(d2[a] === Infinity ? sorted[1] === Infinity : Math.abs(d2[a] - sorted[1]) < 1e-9).toBe(true);
      if (Number.isFinite(sorted[0])) expect(ds[i1[a]]).toBeCloseTo(sorted[0], 9);
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
