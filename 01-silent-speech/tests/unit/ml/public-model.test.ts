// The public model web/public/models/templates.json (scripts/export-model.ts): trained on s1 + s2 only, s3 held
// out for the visitor replay. Its templates are stored preprocessed, so they go stale if preprocessing changes:
// this retrains it from the raw files and compares.
import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Clip, Dataset, DtwKnnModelJSON } from '../../../web/src/core/contracts';
import { NONE } from '../../../web/src/core/contracts';
import { applyExclude, mergeDatasets, parseExclude } from '../../../web/src/ml/data';
import { loadModel, train } from '../../../web/src/ml/index';
import { DEFAULT_OPTS } from '../../../web/src/ml/preprocess';
import { maxAbsDiff, readJson } from './helpers';

const MODEL = 'web/public/models/templates.json';
const json = readJson<DtwKnnModelJSON>(MODEL);
const meta = readJson<{ trainedOn: string[]; sessions: string[]; heldOut: string; opts: unknown; nTemplates: number; decimals: number | null; check: { accuracy: number; nClips: number } }>('web/public/models/templates.meta.json');
const excl = parseExclude(readJson('data/raw/exclude.json'));
const load = (files: string[]): Clip[] => applyExclude(mergeDatasets(files.map((f) => readJson<Dataset>(`data/raw/${f}`))).clips, excl).clips;

// Heavy work: an explicit timeout so loaded or parallel runs (CI, 4 agents on one box) don't flake.
describe('public model', { timeout: 60_000 }, () => {
  it('is small enough to fetch (< 1.5 MB) and says what it was trained on', () => {
    expect(statSync(new URL(`../../../${MODEL}`, import.meta.url)).size).toBeLessThan(1.5e6);
    expect(meta.sessions).toEqual(['s1', 's2']);
    expect(meta.heldOut).toBe('s3');
    expect(meta.trainedOn.some((f) => f.includes('-s3-'))).toBe(false);
    expect(meta.nTemplates).toBe(json.templates.length);
    expect(meta.opts).toEqual(json.opts);
    expect(json.opts).toEqual({ ...DEFAULT_OPTS, channels: [...DEFAULT_OPTS.channels] });
  });

  it('matches a fresh train() on s1 + s2 (templates rounded to its decimals, nothing else)', () => {
    const fresh = train(load(meta.trainedOn)).toJSON();
    expect(json.labels).toEqual(fresh.labels);
    expect(json.norm).toEqual(fresh.norm);
    expect(json.templates.map((t) => t.label)).toEqual(fresh.templates.map((t) => t.label));
    const tol = meta.decimals ? 0.5 * 10 ** -meta.decimals + 1e-9 : 0;
    json.templates.forEach((t, i) => expect(maxAbsDiff(t.x, fresh.templates[i].x)).toBeLessThanOrEqual(tol));
  }, 60_000);

  it('scores the held out s3 as its meta says, and never fires on a none take', () => {
    const m = loadModel(json);
    const s3 = load(['ss-dataset-s3-20261031-1654.json']);
    expect(s3.length).toBe(meta.check.nClips);
    const preds = s3.map((c) => m.predict(c.samples, { loc: c.loc }));
    expect(preds.filter((p, i) => p.label === s3[i].label).length / s3.length).toBe(meta.check.accuracy);
    expect(preds.some((p, i) => p.accepted && p.label !== s3[i].label)).toBe(false);
    expect(preds.some((p, i) => p.accepted && s3[i].label === NONE)).toBe(false);
  }, 60_000);
});
