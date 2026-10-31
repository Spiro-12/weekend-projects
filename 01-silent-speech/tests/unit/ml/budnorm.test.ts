// PROTOCOL §5 step 0: bud normalization. A right bud clip is mirrored into the left bud frame
// (rr -> [x, -y, -z], ua -> [-x, y, z]) when budNorm is 'mirror'; 'none' and any other bud leave it alone.
import { describe, expect, it } from 'vitest';
import type { BudLocation, Channel, Clip, DatasetClip, DtwKnnModelJSON } from '../../../web/src/core/contracts';
import { DEFAULT_CHANNELS } from '../../../web/src/core/contracts';
import { crossValidate } from '../../../web/src/ml/eval';
import { loadModel, preprocess, train } from '../../../web/src/ml/index';
import { MIRROR_FLIPS, mirrorSample, mirrors, preprocessRaw, toGrid } from '../../../web/src/ml/preprocess';
import { syntheticDataset } from './helpers';

const clips = (): DatasetClip[] => syntheticDataset().clips;
const bySession = (s: string) => clips().filter((c) => c.session === s);
/** The same takes as if a right bud had recorded them: samples mirrored, loc 'right'. */
const asRightBud = <T extends Clip>(cs: T[]): T[] => cs.map((c) => ({ ...c, samples: c.samples.map(mirrorSample), loc: 'right' as const }));
const bits = (x: ArrayLike<number>[]) => x.map((r) => Array.from(r));

describe('bud normalization (step 0)', () => {
  const s = clips()[3].samples;

  it('mirrorSample flips rr.y, rr.z and ua.x only (and keeps the other fields)', () => {
    const m = mirrorSample(s[10]);
    expect(m.rr).toEqual([s[10].rr[0], -s[10].rr[1], -s[10].rr[2]]);
    expect(m.ua).toEqual([-s[10].ua[0], s[10].ua[1], s[10].ua[2]]);
    expect({ ...m, rr: 0, ua: 0 }).toEqual({ ...s[10], rr: 0, ua: 0 });
    expect(s[10].rr).not.toEqual(m.rr); // the input is not changed
    expect(Object.entries(MIRROR_FLIPS).filter(([, f]) => f).map(([c]) => c)).toEqual(['rr.y', 'rr.z', 'ua.x']);
  });

  it('only a right bud with budNorm mirror is mirrored', () => {
    const locs: (BudLocation | undefined)[] = ['left', 'right', 'default', 'unknown', undefined];
    expect(locs.map((l) => mirrors(l, 'mirror'))).toEqual([false, true, false, false, false]);
    expect(locs.map((l) => mirrors(l, 'none'))).toEqual([false, false, false, false, false]);
  });

  it('a right bud clip preprocesses bit for bit like its mirrored samples (every step, any channel order)', () => {
    const mirrored = s.map(mirrorSample);
    for (const channels of [[...DEFAULT_CHANNELS], ['ua.x', 'rr.z', 'ua.y'] as Channel[]]) {
      for (const o of [{ channels }, { channels, L: 48, hpHz: 2 }, { channels, norm: 'clip' as const }]) {
        expect(bits(preprocessRaw(s, o, 'right'))).toEqual(bits(preprocessRaw(mirrored, { ...o, budNorm: 'none' })));
      }
      expect(bits(toGrid(s, channels, true))).toEqual(bits(toGrid(mirrored, channels)));
    }
    const ref = preprocessRaw(mirrored, {});
    expect(bits(preprocess(s, {}, undefined, 'right'))).toEqual(bits(ref.map((r) => Float32Array.from(r))));
  });

  it("'none' is a no op, and so is every bud but right", () => {
    const plain = bits(preprocessRaw(s, {}));
    expect(bits(preprocessRaw(s, { budNorm: 'none' }, 'right'))).toEqual(plain);
    for (const loc of ['left', 'default', 'unknown', undefined] as const) expect(bits(preprocessRaw(s, {}, loc))).toEqual(plain);
    expect(bits(preprocessRaw(s, {}, 'right'))).not.toEqual(plain);
  });

  it('train stores right bud clips in the left frame: same model as the left bud takes', () => {
    const left = [...bySession('s1'), ...bySession('s2')];
    const a = train(left).toJSON();
    const b = train(asRightBud(left)).toJSON();
    expect(b).toEqual(a);
    // budNorm 'none' keeps them as recorded, so the templates really differ
    expect(train(asRightBud(left), { budNorm: 'none' }).toJSON().templates).not.toEqual(a.templates);
  });

  it('predict mirrors by ctx.loc: a right bud clip on a left bud model = the left bud clip', () => {
    const model = train([...bySession('s1'), ...bySession('s2')]);
    for (const c of bySession('s3').filter((_, i) => i % 4 === 0)) {
      const want = { ...model.predict(c.samples), ms: 0 };
      const right = c.samples.map(mirrorSample);
      expect({ ...model.predict(right, { loc: 'right' }), ms: 0 }).toEqual(want);
      expect({ ...model.predict(c.samples, { loc: 'left' }), ms: 0 }).toEqual(want);
      expect({ ...model.predict(c.samples, {}), ms: 0 }).toEqual(want);
    }
  });

  it('mirroring really changes what the model sees (an unmirrored right bud clip scores differently)', () => {
    const model = train([...bySession('s1'), ...bySession('s2')]);
    const c = bySession('s3')[0];
    const right = c.samples.map(mirrorSample);
    expect(model.predict(right, { loc: 'right' }).confidence).not.toBe(model.predict(right).confidence);
  });

  it("a budNorm 'none' model ignores ctx.loc, also after a JSON round trip", () => {
    const model = train([...bySession('s1'), ...bySession('s2')], { budNorm: 'none' });
    const back = loadModel(JSON.parse(JSON.stringify(model.toJSON())) as DtwKnnModelJSON);
    expect(back.toJSON().opts.budNorm).toBe('none');
    const c = bySession('s3')[5];
    const want = { ...model.predict(c.samples), ms: 0 };
    expect({ ...model.predict(c.samples, { loc: 'right' }), ms: 0 }).toEqual(want);
    expect({ ...back.predict(c.samples, { loc: 'right' }), ms: 0 }).toEqual(want);
  });

  it('add() mirrors by the clip’s own loc', () => {
    const base = bySession('s1');
    const a = train(base), b = train(base);
    const extra = bySession('s2')[0];
    a.add(extra);
    b.add(asRightBud([extra])[0]);
    expect(b.toJSON()).toEqual(a.toJSON());
  });

  it('cross validation mirrors each clip by its own loc (training and held out clips)', () => {
    const cs = clips().filter((c) => c.rep < 3);
    const mixed = cs.map((c) => (c.session === 's1' ? asRightBud([c])[0] : c)); // s1 "recorded on the right bud"
    const strip = (r: ReturnType<typeof crossValidate>) => r.map(({ ms, ...rest }) => { void ms; return rest; });
    expect(strip(crossValidate(mixed, {}, 'loso'))).toEqual(strip(crossValidate(cs, {}, 'loso')));
    expect(strip(crossValidate(mixed, {}, 'loo'))).toEqual(strip(crossValidate(cs, {}, 'loo')));
    // without bud normalization the mirrored session is a different signal
    expect(strip(crossValidate(mixed, { budNorm: 'none' }, 'loso'))).not.toEqual(strip(crossValidate(cs, { budNorm: 'none' }, 'loso')));
  });
});
