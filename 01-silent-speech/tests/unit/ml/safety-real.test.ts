// Safety on Spiro's real AirPods recordings (data/raw, exclude list applied), at DEFAULT_OPTS.
// The Phase 1 rules (safety.test.ts), measured on real data: an accepted prediction can text real people.
// Why this file exists: the synthetic generator is a weak stand in here. Its sentences only differ by syllable
// timing and per channel loudness, so after per clip normalization (norm 'clip', the Phase 2 default) they all look
// alike (other sentences at 1.0 to 1.25 x dRef, known ones at 0.6 to 0.95), while real sentences don't (other
// sentences at 1.35 to 1.7 x dRef, known ones from another session at 0.9 to 1.25; 10th to 90th percentile). The Phase 1 small model checks (b) and (c) therefore run on norm 'global' in
// safety.test.ts and on the real defaults here. See ml/results/dtw-knn/ and the Track F report for the numbers.
import { describe, expect, it } from 'vitest';
import type { Clip, Dataset } from '../../../web/src/core/contracts';
import { NONE } from '../../../web/src/core/contracts';
import { applyExclude, mergeDatasets, parseExclude } from '../../../web/src/ml/data';
import { crossValidate } from '../../../web/src/ml/eval';
import { train } from '../../../web/src/ml/index';
import { noiseSet, readJson, whiteNoise } from './helpers';

const FILES = ['s1-20261031-1621', 's2-20261031-1637', 's3-20261031-1654'].map((s) => `data/raw/ss-dataset-${s}.json`);
const real: Clip[] = applyExclude(
  mergeDatasets(FILES.map((f) => readJson<Dataset>(f))).clips,
  parseExclude(readJson('data/raw/exclude.json')),
).clips;
const sess = (s: string[]) => real.filter((c) => s.includes(c.session ?? ''));
const fires = (p: { label: string; accepted: boolean }) => p.accepted && p.label !== NONE;

// Heavy work: an explicit timeout so loaded or parallel runs (CI, 4 agents on one box) don't flake.
describe('safety on real data (default options)', { timeout: 60_000 }, () => {
  it('has the expected data: 342 clips, s1 on the right bud, s2 + s3 on the left', () => {
    expect(real.length).toBe(342);
    expect(new Set(sess(['s1']).map((c) => c.loc))).toEqual(new Set(['right']));
    expect(new Set(sess(['s2', 's3']).map((c) => c.loc))).toEqual(new Set(['left']));
  });

  it('(b, c) small models (2 to 4 classes) accept <= 10% of the sentences they were not trained on', () => {
    const SETS = [['text_mom', NONE], ['text_mom', 'volume_up', NONE], ['call_back', 'help', 'calendar', NONE], ['focus_music', 'demo_48h', NONE]];
    const SPLITS: [string[], string[]][] = [[['s2'], ['s3']], [['s3'], ['s2']], [['s2', 's3'], ['s1']], [['s1', 's2'], ['s3']]];
    let oov = 0, oovN = 0;
    for (const set of SETS) for (const [tr, te] of SPLITS) {
      const m = train(sess(tr).filter((c) => set.includes(c.label)));
      const other = sess(te).filter((c) => !set.includes(c.label));
      const n = other.filter((c) => fires(m.predict(c.samples, { loc: c.loc }))).length;
      expect(n / other.length, `${set.join('+')} ${tr.join('+')} -> ${te.join('+')}`).toBeLessThanOrEqual(0.25);
      oov += n; oovN += other.length;
    }
    expect(oov / oovN).toBeLessThanOrEqual(0.1);
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
