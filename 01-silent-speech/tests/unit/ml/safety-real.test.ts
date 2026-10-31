// Safety on Spiro's real AirPods recordings (data/raw, exclude list applied), at DEFAULT_OPTS.
// The Phase 1 rules (safety.test.ts), measured on real data: an accepted prediction can text real people.
// Why this file exists: the synthetic generator is a weak stand in here. Its sentences only differ by syllable
// timing and per channel loudness, so after per clip normalization (norm 'clip', the Phase 2 default) they all look
// alike (other sentences at 1.0 to 1.25 x dRef, known ones at 0.6 to 0.95), while real sentences don't (other
// sentences at 1.35 to 1.7 x dRef, known ones from another session at 0.9 to 1.25; 10th to 90th percentile).
// The Phase 1 small model checks (b) and (c) therefore run on norm 'global' in safety.test.ts and on the real
// defaults here. Numbers: ml/results/dtw-knn/sweep/thresholds-real.json (`eval-dtw --thresholds`).
//
// Small models are only safe on average. 7.7% of the other sentences fire overall, but one sentence that sounds
// like a known one fires much more often: "call back" fires focus_music on 73% of takes for a focus_music +
// demo_48h model (s1 + s2 -> s3), and text_mom on 33% for a text_mom + none model. So actions need a full model
// (all 7 sentences + none); the Recognize panel (Track J) gates them that way. Tested below so it can't get worse.
import { describe, expect, it } from 'vitest';
import type { BudLocation, Clip, Dataset, DtwKnnModelJSON } from '../../../web/src/core/contracts';
import { NONE } from '../../../web/src/core/contracts';
import { applyExclude, mergeDatasets, parseExclude } from '../../../web/src/ml/data';
import { crossValidate } from '../../../web/src/ml/eval';
import { loadModel, train, type DtwKnnModel } from '../../../web/src/ml/index';
import { noiseSet, readJson, whiteNoise } from './helpers';

const FILES = ['s1-20261031-1621', 's2-20261031-1637', 's3-20261031-1654'].map((s) => `data/raw/ss-dataset-${s}.json`);
const real: Clip[] = applyExclude(
  mergeDatasets(FILES.map((f) => readJson<Dataset>(f))).clips,
  parseExclude(readJson('data/raw/exclude.json')),
).clips;
const sess = (s: string[]) => real.filter((c) => s.includes(c.session ?? ''));
const fires = (p: { label: string; accepted: boolean }) => p.accepted && p.label !== NONE;

/** The 16 small models (same sets and splits as `eval-dtw --thresholds`), built once and shared by the tests. */
const SETS = [['text_mom', NONE], ['text_mom', 'volume_up', NONE], ['call_back', 'help', 'calendar', NONE], ['focus_music', 'demo_48h', NONE]];
const SPLITS: [string[], string[]][] = [[['s2'], ['s3']], [['s3'], ['s2']], [['s2', 's3'], ['s1']], [['s1', 's2'], ['s3']]];
let small: { name: string; set: string[]; model: DtwKnnModel; other: Clip[] }[] | null = null;
const smallModels = () => (small ??= SETS.flatMap((set) => SPLITS.map(([tr, te]) => ({
  name: `${set.join('+')} ${tr.join('+')} -> ${te.join('+')}`, set,
  model: train(sess(tr).filter((c) => set.includes(c.label))),
  other: sess(te).filter((c) => !set.includes(c.label)),
}))));

// Heavy work: an explicit timeout so loaded or parallel runs (CI, 4 agents on one box) don't flake.
describe('safety on real data (default options)', { timeout: 60_000 }, () => {
  it('has the expected data: 342 clips, s1 on the right bud, s2 + s3 on the left', () => {
    expect(real.length).toBe(342);
    expect(new Set(sess(['s1']).map((c) => c.loc))).toEqual(new Set(['right']));
    expect(new Set(sess(['s2', 's3']).map((c) => c.loc))).toEqual(new Set(['left']));
  });

  it('(b, c) small models (2 to 4 classes) accept <= 10% of the sentences they were not trained on (worst model <= 25%, worst sentence <= 75%)', () => {
    let oov = 0, oovN = 0, worst = { rate: 0, what: '' };
    for (const { name, model, other } of smallModels()) {
      const fired = other.map((c) => fires(model.predict(c.samples, { loc: c.loc })));
      const n = fired.filter(Boolean).length;
      expect(n / other.length, name).toBeLessThanOrEqual(0.25); // worst today: 22.7% (focus_music + demo_48h + none)
      oov += n; oovN += other.length;
      for (const label of new Set(other.map((c) => c.label))) { // per sentence: one sound alike sentence can fire a lot
        const idx = other.map((c, i) => (c.label === label ? i : -1)).filter((i) => i >= 0);
        const rate = idx.filter((i) => fired[i]).length / idx.length;
        if (rate > worst.rate) worst = { rate, what: `"${label}" on ${name}` };
      }
    }
    expect(oov / oovN).toBeLessThanOrEqual(0.1); // 7.7% today
    expect(worst.rate, worst.what).toBeLessThanOrEqual(0.75); // 73.3% today: "call_back" on focus_music + demo_48h + none, s1 + s2 -> s3
  }, 120_000);

  it('small models never fire on noise or stillness, from either bud', () => {
    const noise = [...noiseSet(), ...whiteNoise(20, 11, 0.05)];
    for (const { name, model } of smallModels()) {
      for (const loc of ['left', 'right'] as const) expect(noise.filter((s) => fires(model.predict(s, { loc }))).length, `${name} ${loc}`).toBe(0);
    }
  }, 120_000);

  it('a wrong or missing ctx.loc only makes the model act less, never on the wrong sentence', () => {
    const wrongFires = (m: DtwKnnModel, cs: Clip[], loc?: BudLocation) =>
      cs.map((c) => m.predict(c.samples, loc === undefined ? {} : { loc })).filter((p, i) => fires(p) && p.label !== cs[i].label).length;
    const left = train(sess(['s2', 's3'])); // right bud s1 takes, told they are left / unknown / not told: not mirrored
    for (const loc of [undefined, 'left', 'unknown', 'default', 'right'] as const) expect(wrongFires(left, sess(['s1']), loc), String(loc)).toBe(0);
    const pub = loadModel(readJson<DtwKnnModelJSON>('web/public/models/templates.json')); // left bud s3 takes, told right: mirrored by mistake
    for (const loc of [undefined, 'left', 'right'] as const) expect(wrongFires(pub, sess(['s3']), loc), String(loc)).toBe(0);
  }, 120_000);

  it('the full model (LOSO, 3 sessions): <= 3% of sentences fire the wrong action, no none take fires, >= 60% fire the right one', () => {
    const res = crossValidate(real, {}, 'loso');
    const S = res.filter((r) => r.label !== NONE), N = res.filter((r) => r.label === NONE);
    const wrong = (rs: typeof res) => rs.filter((r) => r.accepted && r.predicted !== r.label).length / rs.length;
    expect(wrong(S)).toBeLessThanOrEqual(0.03);
    const s1 = new Set(sess(['s1']).map((c) => c.id)); // the cross bud fold: s2 + s3 (left) -> s1 (right)
    expect(wrong(S.filter((r) => s1.has(r.id)))).toBeLessThanOrEqual(0.03);
    expect(N.length).toBe(27);
    expect(N.filter((r) => r.accepted).length).toBe(0);
    expect(S.filter((r) => r.accepted && r.predicted === r.label).length / S.length).toBeGreaterThanOrEqual(0.6);
  }, 120_000);

  it('a model trained on all of it rejects noise and stillness (from either bud)', () => {
    const m = train(real);
    const noise = noiseSet();
    for (const loc of ['left', 'right'] as const) {
      expect(noise.filter((s) => fires(m.predict(s, { loc }))).length).toBe(0);
      expect(whiteNoise(20, 11, 0.05).filter((s) => fires(m.predict(s, { loc }))).length).toBe(0);
    }
  }, 120_000);
});
