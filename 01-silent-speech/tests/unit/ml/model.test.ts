import { describe, expect, it } from 'vitest';
import type { Clip, DtwKnnModelJSON } from '../../../web/src/core/contracts';
import { NONE } from '../../../web/src/core/contracts';
import { dtw, loadModel, preprocess, train } from '../../../web/src/ml/index';
import { syntheticDataset } from './helpers';

const clips = (): Clip[] => syntheticDataset().clips;
const bySession = (s: string) => clips().filter((c) => c.session === s);

describe('train / predict', () => {
  const model = train([...bySession('s1'), ...bySession('s2')]);
  const test = bySession('s3');

  it('has the Classifier shape', () => {
    expect(model.name).toBe('dtw-knn');
    expect(model.labels).toEqual([...new Set(clips().map((c) => c.label))].sort());
    expect(model.threshold).toBe(0.5);
  });

  it('prediction fields are consistent: top[0] is the label and its score is the confidence', () => {
    for (const c of test) {
      const p = model.predict(c.samples);
      expect(p.top.length).toBeGreaterThanOrEqual(1);
      expect(p.top.length).toBeLessThanOrEqual(3);
      expect(p.top[0].label).toBe(p.label);
      expect(p.top[0].score).toBe(p.confidence);
      expect(p.confidence).toBeGreaterThanOrEqual(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
      for (let i = 1; i < p.top.length; i++) expect(p.top[i].score).toBeLessThanOrEqual(p.top[i - 1].score);
      expect(p.top.reduce((a, t) => a + t.score, 0)).toBeLessThanOrEqual(1 + 1e-12);
      expect(new Set(p.top.map((t) => t.label)).size).toBe(p.top.length);
      expect(p.accepted).toBe(p.label !== NONE && p.confidence >= model.threshold);
      expect(p.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('matches a brute force kNN + the documented confidence formula (public dtw, no early abandon)', () => {
    const json = model.toJSON();
    const tpl = json.templates.map((t) => ({ label: t.label, x: t.x.map((r) => Float32Array.from(r)) }));
    for (const c of test.slice(0, 16)) {
      const q = preprocess(c.samples, json.opts, json.norm);
      const d = tpl.map((t) => ({ label: t.label, d: dtw(q, t.x, 6) }));
      const nearest = new Map<string, number>();
      for (const x of d) nearest.set(x.label, Math.min(nearest.get(x.label) ?? Infinity, x.d));
      const knn = [...d].sort((a, b) => a.d - b.d).slice(0, 3);
      const w = new Map<string, number>();
      for (const x of knn) w.set(x.label, (w.get(x.label) ?? 0) + 1 / (x.d + 1e-9));
      const wSum = [...w.values()].reduce((a, b) => a + b, 0);
      const label = [...w.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const dBest = Math.min(...nearest.values());
      const T = 0.1 * dBest + 1e-12;
      const z = [...nearest.values()].reduce((a, v) => a + Math.exp(-(v - dBest) / T), 0);
      const conf = (w.get(label)! / wSum) * (Math.exp(-(nearest.get(label)! - dBest) / T) / z);
      const p = model.predict(c.samples);
      expect(p.label).toBe(label);
      expect(p.confidence).toBeCloseTo(conf, 9);
      expect(p.top.map((t) => t.label).sort()).toEqual([...w.keys()].sort());
    }
  });

  it('a training clip predicts itself with full confidence', () => {
    const c = bySession('s1')[0];
    const p = model.predict(c.samples);
    expect(p.label).toBe(c.label);
    expect(p.confidence).toBeGreaterThan(0.99);
  });

  it('none is never accepted, threshold is live', () => {
    const none = test.find((c) => c.label === NONE)!;
    const p = model.predict(none.samples);
    expect(p.label).toBe(NONE);
    expect(p.accepted).toBe(false);
    const word = test.find((c) => c.label !== NONE && model.predict(c.samples).label === c.label)!;
    const m2 = train([...bySession('s1'), ...bySession('s2')]);
    m2.threshold = 0;
    expect(m2.predict(word.samples).accepted).toBe(true);
    m2.threshold = 1.01;
    expect(m2.predict(word.samples).accepted).toBe(false);
  });

  it('train() and loadModel(toJSON()) give identical predictions (also through a JSON string)', () => {
    const json = model.toJSON();
    const a = loadModel(json);
    const b = loadModel(JSON.parse(JSON.stringify(json)) as DtwKnnModelJSON);
    for (const c of test) {
      const p = model.predict(c.samples);
      for (const m of [a, b]) {
        const q = m.predict(c.samples);
        expect({ ...q, ms: 0 }).toEqual({ ...p, ms: 0 });
      }
    }
    expect(b.toJSON()).toEqual(json);
  });

  it('toJSON has the DtwKnnModelJSON shape', () => {
    const json = model.toJSON();
    expect(json.kind).toBe('dtw-knn');
    expect(json.v).toBe(1);
    expect(json.opts).toEqual({ channels: ['rr.x', 'rr.y', 'rr.z', 'ua.x', 'ua.y', 'ua.z'], L: 64, hpHz: 1, band: 0.1, k: 3, norm: 'global', threshold: 0.5 });
    expect(json.norm.mean.length).toBe(6);
    expect(json.templates.length).toBe(80);
    expect(json.templates[0].x.length).toBe(6);
    expect(json.templates[0].x[0].length).toBe(64);
    expect(json.labels).toEqual(model.labels);
  });

  it('dedupes clips by id (first wins)', () => {
    const s1 = bySession('s1');
    const m = train([...s1, ...s1, { ...s1[0], label: 'calendar' }]);
    expect(m.toJSON().templates.length).toBe(s1.length);
    expect(m.toJSON().templates[0].label).toBe(s1[0].label);
  });

  it('add() appends a template using the existing norm stats', () => {
    const m = train(bySession('s1'));
    const before = m.toJSON();
    const extra = bySession('s2')[0];
    m.add(extra);
    const after = m.toJSON();
    expect(after.templates.length).toBe(before.templates.length + 1);
    expect(after.norm).toEqual(before.norm);
    expect(m.predict(extra.samples).label).toBe(extra.label);
    expect(m.predict(extra.samples).confidence).toBeGreaterThan(0.99);
  });

  it('works with the clip norm and other options', () => {
    const m = train([...bySession('s1'), ...bySession('s2')], { norm: 'clip', k: 1, L: 48, band: 0.2, channels: ['rr.x', 'rr.y', 'ua.z'] });
    const ok = test.filter((c) => m.predict(c.samples).label === c.label).length;
    expect(ok / test.length).toBeGreaterThan(0.8);
    const p = m.predict(test[0].samples);
    expect(p.top.length).toBe(1);
    const back = loadModel(JSON.parse(JSON.stringify(m.toJSON())) as DtwKnnModelJSON);
    expect({ ...back.predict(test[0].samples), ms: 0 }).toEqual({ ...p, ms: 0 });
  });

  it('an empty model answers none with 0 confidence', () => {
    const m = train([]);
    const p = m.predict(test[0].samples);
    expect(p).toMatchObject({ label: NONE, confidence: 0, accepted: false, top: [] });
  });

  it('loadModel rejects broken JSON', () => {
    const json = model.toJSON();
    expect(() => loadModel({ ...json, kind: 'x' } as unknown as DtwKnnModelJSON)).toThrow();
    expect(() => loadModel({ ...json, templates: [{ label: 'a', x: [[1, 2]] }] })).toThrow();
    expect(() => loadModel({ ...json, norm: { mean: [0], std: [1] } })).toThrow();
  });
});
