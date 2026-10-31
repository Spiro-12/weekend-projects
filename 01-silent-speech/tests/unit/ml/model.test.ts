import { describe, expect, it } from 'vitest';
import type { Clip, DatasetClip, DtwKnnModelJSON } from '../../../web/src/core/contracts';
import { NONE } from '../../../web/src/core/contracts';
import { dtw, loadModel, preprocess, train, type DtwKnnModel } from '../../../web/src/ml/index';
import { bandRadius } from '../../../web/src/ml/dtw';
import { fromRaw, trainModel } from '../../../web/src/ml/knn';
import { DEFAULT_OPTS, preprocessRaw, resolveOpts } from '../../../web/src/ml/preprocess';
import { syntheticDataset } from './helpers';

const clips = (): DatasetClip[] => syntheticDataset().clips;
const bySession = (s: string) => clips().filter((c) => c.session === s);

// Heavy work: an explicit timeout so loaded or parallel runs (CI, 4 agents on one box) don't flake.
describe('train / predict', { timeout: 60_000 }, () => {
  const model = train([...bySession('s1'), ...bySession('s2')]);
  const test = bySession('s3');

  it('has the Classifier shape', () => {
    expect(model.name).toBe('dtw-knn');
    expect(model.labels).toEqual([...new Set(clips().map((c) => c.label))].sort());
    expect(model.threshold).toBe(DEFAULT_OPTS.threshold);
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

  /** The header's formula, recomputed from scratch with the public dtw() (no early abandon, no caching). */
  function bruteForce(json: DtwKnnModelJSON, samples: Clip['samples']) {
    const tpl = json.templates.map((t) => ({ label: t.label, x: t.x.map((r) => Float32Array.from(r)) }));
    const r = bandRadius(json.opts.band, json.opts.L);
    const nnSame = tpl.map((t, i) => Math.min(...tpl.filter((u, j) => j !== i && u.label === t.label).map((u) => dtw(t.x, u.x, r))));
    const finite = nnSame.filter(Number.isFinite).sort((a, b) => a - b);
    const h = finite.length >> 1;
    const dRef = finite.length % 2 ? finite[h] : (finite[h - 1] + finite[h]) / 2;
    const q = preprocess(samples, json.opts, json.norm);
    const d = tpl.map((t) => ({ label: t.label, d: dtw(q, t.x, r) }));
    const nearest = new Map<string, number>();
    for (const x of d) nearest.set(x.label, Math.min(nearest.get(x.label) ?? Infinity, x.d));
    const knn = [...d].sort((a, b) => a.d - b.d).slice(0, json.opts.k);
    const w = new Map<string, number>();
    for (const x of knn) w.set(x.label, (w.get(x.label) ?? 0) + 1 / (x.d + 1e-9));
    const wSum = [...w.values()].reduce((a, b) => a + b, 0);
    const label = [...w.entries()].sort((a, b) => b[1] - a[1] || nearest.get(a[0])! - nearest.get(b[0])!)[0][0];
    const T = 0.1 * dRef;
    const still = 1.25 * q.reduce((a, r) => a + r.reduce((b, v) => b + v * v, 0), 0);
    const logits = [...[...nearest.values()].map((v) => -v / T), -1.7 * dRef / T, -still / T];
    const mx = Math.max(...logits);
    const z = logits.reduce((a, l) => a + Math.exp(l - mx), 0);
    const sep = (l: string) => Math.exp(-nearest.get(l)! / T - mx) / z;
    const confidence = (w.get(label)! / wSum) * (sep(label) + (label === NONE ? Math.exp(-still / T - mx) / z : 0));
    const rest = [...nearest.keys()].filter((l) => l !== label).sort((a, b) => nearest.get(a)! - nearest.get(b)!).slice(0, 2);
    return { dRef, label, confidence, top: [{ label, score: confidence }, ...rest.map((l) => ({ label: l, score: Math.min(sep(l), confidence) }))] };
  }

  it('matches a brute force kNN + the documented confidence formula (public dtw, no early abandon)', () => {
    const m1 = train([...bySession('s1'), ...bySession('s2')], { k: 1, norm: 'global', L: 64, band: 0.1 }); // Phase 1 path
    for (const m of [model, m1]) {
      const json = m.toJSON();
      for (const c of test.filter((_, i) => i % 3 === 0)) { // 14 clips, every class
        const want = bruteForce(json, c.samples);
        expect((m as unknown as { referenceDistance(): number }).referenceDistance()).toBeCloseTo(want.dRef, 9);
        const p = m.predict(c.samples);
        expect(p.label).toBe(want.label);
        expect(p.confidence).toBeCloseTo(want.confidence, 9);
        expect(p.top.map((t) => t.label)).toEqual(want.top.map((t) => t.label));
        p.top.forEach((t, i) => expect(t.score).toBeCloseTo(want.top[i].score, 9));
      }
    }
  });

  it('top has 3 entries (one per class, best first) when the model has 3+ classes', () => {
    for (const c of test) expect(model.predict(c.samples).top.length).toBe(3);
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
    expect(json.opts).toEqual({ channels: ['rr.x', 'rr.y', 'rr.z', 'ua.x', 'ua.y', 'ua.z'], L: 96, hpHz: 1, band: 0.05, k: 3, norm: 'clip', threshold: 0.85, budNorm: 'mirror' });
    expect(json.norm.mean.length).toBe(6);
    expect(json.templates.length).toBe(80);
    expect(json.templates[0].x.length).toBe(6);
    expect(json.templates[0].x[0].length).toBe(96);
    expect(json.labels).toEqual(model.labels);
  });

  it('dedupes clips by id (first wins)', () => {
    const s1 = bySession('s1');
    const m = train([...s1, ...s1, { ...s1[0], label: 'calendar' }]);
    expect(m.toJSON().templates.length).toBe(s1.length);
    expect(m.toJSON().templates[0].label).toBe(s1[0].label);
  });

  it('add() keeps dRef exact: an unsafe one take per class model becomes safe', () => {
    const one = bySession('s1').filter((c) => c.rep === 0);
    const m = train(one) as unknown as DtwKnnModel & { referenceDistance(): number | null };
    expect(m.referenceDistance()).toBeNull();
    expect(m.predict(test[1].samples).confidence).toBeLessThanOrEqual(m.threshold / 2);
    for (const c of bySession('s1').filter((x) => x.rep === 1 || x.rep === 2)) m.add(c);
    const want = bruteForce(m.toJSON(), test[1].samples);
    expect(m.referenceDistance()).toBeCloseTo(want.dRef, 9);
    expect(m.predict(test[1].samples).confidence).toBeCloseTo(want.confidence, 9);
  });

  it('a model handed a dRef (LOO shortcut) uses it, and add() goes back to the exact one', () => {
    const cs = bySession('s1');
    const o = resolveOpts();
    const m = fromRaw(cs.map((c) => c.label), cs.map((c) => preprocessRaw(c.samples, o)), o, { dRef: 123.5 });
    expect(m.referenceDistance()).toBe(123.5);
    m.add(bySession('s2')[0]);
    expect(m.referenceDistance()).toBeCloseTo(bruteForce(m.toJSON(), test[0].samples).dRef, 9);
    expect(fromRaw(cs.map((c) => c.label), cs.map((c) => preprocessRaw(c.samples, o)), o).referenceDistance())
      .toBeCloseTo(trainModel(cs).referenceDistance()!, 12);
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
    expect(p.top.length).toBe(3);
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
