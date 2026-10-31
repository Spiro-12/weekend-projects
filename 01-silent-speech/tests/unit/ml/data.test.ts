// Dataset merging (clip.session / clip.loc filled in from the file), exclusion lists (PROTOCOL §3), holdOut.
import { describe, expect, it } from 'vitest';
import type { Dataset } from '../../../web/src/core/contracts';
import { applyExclude, mergeDatasets, parseExclude } from '../../../web/src/ml/data';
import { holdOut } from '../../../web/src/ml/eval';
import { train } from '../../../web/src/ml/index';
import { readJson, syntheticDataset } from './helpers';

const ds = (): Dataset => structuredClone(syntheticDataset());

describe('mergeDatasets', () => {
  it('fills clip.loc from device.loc when missing, keeps a clip’s own loc', () => {
    const a = ds(), b = ds();
    a.device.loc = 'right';
    b.device.loc = 'left';
    b.clips = b.clips.map((c, i) => ({ ...c, id: `b-${c.id}`, ...(i === 0 ? { loc: 'right' as const } : {}) }));
    const { clips, duplicates } = mergeDatasets([a, b]);
    expect(duplicates).toBe(0);
    expect(clips.slice(0, a.clips.length).every((c) => c.loc === 'right')).toBe(true);
    expect(clips[a.clips.length].loc).toBe('right'); // its own
    expect(clips.slice(a.clips.length + 1).every((c) => c.loc === 'left')).toBe(true);
    expect(a.clips[0].loc).toBeUndefined(); // inputs are not changed
  });

  it('dedupes by id (first file wins) and fills session', () => {
    const a = ds(), b = ds();
    b.device.loc = 'right';
    const { clips, duplicates } = mergeDatasets([a, b]);
    expect(duplicates).toBe(b.clips.length);
    expect(clips.every((c) => c.loc === a.device.loc && typeof c.session === 'string')).toBe(true);
  });
});

describe('exclusion list', () => {
  it('parses the real data/raw/exclude.json', () => {
    const ids = parseExclude(readJson('data/raw/exclude.json'));
    expect(ids.size).toBe(18);
    expect([...ids].every((id) => /^s[12]-/.test(id))).toBe(true);
  });

  it('rejects anything that is not an ss-exclude v1 file', () => {
    for (const bad of [null, 3, {}, { format: 'ss-exclude', v: 2, ids: [] }, { format: 'x', v: 1, ids: [] },
      { format: 'ss-exclude', v: 1 }, { format: 'ss-exclude', v: 1, ids: [1] }, { format: 'ss-exclude', v: 1, ids: [''] }]) {
      expect(() => parseExclude(bad)).toThrow();
    }
    expect(parseExclude({ format: 'ss-exclude', v: 1, ids: [] }).size).toBe(0);
  });

  it('drops excluded clips and reports ids it did not find', () => {
    const cs = ds().clips;
    const r = applyExclude(cs, new Set([cs[0].id, cs[5].id, 'nope']));
    expect(r.clips.length).toBe(cs.length - 2);
    expect(r.excluded).toBe(2);
    expect(r.missing).toEqual(['nope']);
    expect(r.clips.some((c) => c.id === cs[0].id || c.id === cs[5].id)).toBe(false);
  });
});

// Heavy work: an explicit timeout so loaded or parallel runs (CI, 4 agents on one box) don't flake.
describe('holdOut', { timeout: 60_000 }, () => {
  const cs = ds().clips;
  const tr = cs.filter((c) => c.session !== 's3'), te = cs.filter((c) => c.session === 's3');

  it('is train on one set, predict the other (each clip with its own loc)', () => {
    const model = train(tr);
    const res = holdOut(tr, te, {});
    expect(res.map((r) => r.id)).toEqual(te.map((c) => c.id));
    te.forEach((c, i) => {
      const p = model.predict(c.samples);
      expect(res[i]).toMatchObject({ label: c.label, predicted: p.label, confidence: p.confidence, accepted: p.accepted });
    });
  });

  it('refuses a test clip that is also a training clip', () => {
    expect(() => holdOut(tr, [...te, tr[0]], {})).toThrow(/also a training clip/);
  });
});
