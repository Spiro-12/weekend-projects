// The public replay file: valid, small, held-out s3 takes only, picked at random (seeded), copied exactly,
// and reproducible from data/raw (so nobody can hand edit it into looking better).
import { readdirSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildReplay, DEFAULT_SEED, metaFor, pickTakes } from '../../scripts/build-replay';
import { App, PAD_SEC, type ClipEvent } from '../../web/src/core/app';
import type { ClassDef, Dataset, DatasetClip, MotionSample, Session } from '../../web/src/core/contracts';
import { mulberry32 } from '../../web/src/core/rng';
import { validateSession } from '../../web/src/core/validate';
import type { ReplayMeta } from '../../web/src/sources/replay';

const root = new URL('../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');
const rawDir = 'data/raw/';
const s3File = readdirSync(new URL(rawDir, root)).find((f) => f.startsWith('ss-dataset-s3-'))!;
const classes = JSON.parse(read('shared/classes.json')) as ClassDef[];
const store = { all: () => [] } as unknown as ConstructorParameters<typeof App>[1];

let text: string, session: Session, meta: ReplayMeta, s3: Dataset, exclude: string[], byId: Map<string, DatasetClip>;
beforeAll(() => {
  text = read('web/public/replay/demo-session.json');
  session = JSON.parse(text) as Session;
  meta = JSON.parse(read('web/public/replay/demo-session.meta.json')) as ReplayMeta;
  s3 = JSON.parse(read(rawDir + s3File)) as Dataset;
  exclude = (JSON.parse(read('data/raw/exclude.json')) as { ids: string[] }).ids;
  byId = new Map(s3.clips.map((c) => [c.id, c]));
});

/** Feeds the session through the real shell (no model) and returns the clips it cuts. */
function cutClips(s: Session): ClipEvent[] {
  const app = new App(classes, store);
  const clips: ClipEvent[] = [];
  app.bus.on('clip', (c) => clips.push(c));
  const ptts = s.events.filter((e) => e.kind === 'ptt') as { t: number; down: boolean }[];
  let e = 0;
  for (const smp of s.samples) {
    while (e < ptts.length && ptts[e].t < smp.t) { app.ptt(ptts[e].down, ptts[e].t); e++; }
    app.bus.emit('motion', smp);
  }
  return clips;
}

describe('web/public/replay/demo-session.json', () => {
  it('is a valid ss-session under 1 MB, without gravity, with a continuous clock and seq', () => {
    expect(validateSession(session)).toEqual([]);
    expect(text.length).toBeLessThan(1024 * 1024);
    session.samples.forEach((s, i) => {
      expect(s.seq).toBe(i);
      expect(s.g).toBeUndefined();
      if (i) expect(s.t).toBeGreaterThan(session.samples[i - 1].t);
    });
    const dts = session.samples.slice(1).map((s, i) => s.t - session.samples[i].t);
    expect(Math.max(...dts)).toBeLessThan(0.2); // no holes bigger than the takes' own dropouts
    expect(session.status).toMatchObject({ armed: false, simulated: false, loc: 'left', hz: 50 });
    expect(session.hello.armed).toBe(false);
  });

  it('has each sentence twice plus 2 none, no sentence twice in a row, gaps of 1.5 to 2.5 s', () => {
    const labels = session.truth.map((w) => w.label);
    for (const c of classes) expect(labels.filter((l) => l === c.id)).toHaveLength(2);
    expect(labels).toHaveLength(16);
    labels.forEach((l, i) => expect(l).not.toBe(labels[(i + 1) % labels.length]));
    for (let i = 1; i < session.truth.length; i++) {
      const gap = (session.truth[i].t0 - PAD_SEC) - (session.truth[i - 1].t1 + PAD_SEC);
      expect(gap).toBeGreaterThanOrEqual(1.5 - 1e-4);
      expect(gap).toBeLessThanOrEqual(2.5 + 1e-4);
    }
  });

  it('push to talk events are exactly the truth windows', () => {
    const ptt = session.events.filter((e) => e.kind === 'ptt');
    expect(ptt).toHaveLength(session.truth.length * 2);
    expect(session.events).toHaveLength(ptt.length); // no made up predictions or actions
    session.truth.forEach((w, i) => {
      expect(ptt[2 * i]).toEqual({ t: w.t0, kind: 'ptt', down: true });
      expect(ptt[2 * i + 1]).toEqual({ t: w.t1, kind: 'ptt', down: false });
    });
  });

  it('uses only held-out s3 takes, none excluded, and the shell cuts each take exactly as recorded', () => {
    expect(meta.takes).toHaveLength(16);
    expect(new Set(meta.takes).size).toBe(16);
    const clips = cutClips(session);
    expect(clips).toHaveLength(16);
    meta.takes!.forEach((id, k) => {
      const take = byId.get(id)!;
      expect(take, id).toBeDefined();
      expect(take.session ?? s3.session).toBe('s3');
      expect(exclude).not.toContain(id);
      expect(take.label).toBe(session.truth[k].label);
      const cut = clips[k].samples;
      expect(cut).toHaveLength(take.samples.length);
      const shift = cut[0].t - take.samples[0].t;
      cut.forEach((s, j) => {
        const o = take.samples[j];
        expect(s.rr).toEqual(o.rr);
        expect(s.ua).toEqual(o.ua);
        expect(s.q).toEqual(o.q);
        expect(s.t - o.t).toBeCloseTo(shift, 4);
      });
      expect(clips[k].releaseT - clips[k].pressT).toBeCloseTo(take.releaseT - take.pressT, 4);
    });
  });

  it('fills the gaps only with motion from the neighbouring takes\' own padding', () => {
    const inWin = (t: number) => session.truth.some((w) => t >= w.t0 - PAD_SEC && t <= w.t1 + PAD_SEC);
    const key = (s: Pick<MotionSample, 'rr' | 'ua'>) => `${s.rr.join()}|${s.ua.join()}`;
    const pads = new Set<string>();
    for (const id of meta.takes!) {
      const c = byId.get(id)!;
      for (const s of c.samples) if (s.t < c.pressT || s.t > c.releaseT) pads.add(key(s));
    }
    const filler = session.samples.filter((s) => !inWin(s.t));
    expect(filler.length).toBeGreaterThan(1000);
    for (const s of filler) expect(pads.has(key(s))).toBe(true);
  });

  it('is exactly what build-replay makes from data/raw (seeded, not hand picked), and the meta matches', () => {
    const r = buildReplay(s3, { exclude, seed: DEFAULT_SEED, session: 's3' });
    expect(JSON.stringify(r.session) + '\n').toBe(text);
    expect(r.takes.map((t) => t.id)).toEqual(meta.takes);
    expect(metaFor(r, s3, `data/raw/${s3File}`, { seed: DEFAULT_SEED, session: 's3' })).toEqual(meta);
    expect(meta).toMatchObject({ real: true, subject: 'Spiro', device: 'AirPods Pro 3', heldOut: true, session: 's3' });
    expect(meta.matches).toEqual({ recordedAt: session.recordedAt, nSamples: session.samples.length, nTruth: 16 });
  }, 30_000);
});

describe('buildReplay', () => {
  it('skips excluded ids and other sessions, and fails loudly when there are not enough takes', () => {
    const someHelp = s3.clips.filter((c) => c.label === 'help').map((c) => c.id);
    const r = buildReplay(s3, { exclude: someHelp.slice(0, -2) });
    expect(r.takes.filter((t) => t.label === 'help').map((t) => t.id).sort()).toEqual(someHelp.slice(-2).sort());
    expect(() => buildReplay(s3, { exclude: someHelp.slice(0, -1) })).toThrow(/need 2 takes of help/);
    expect(() => buildReplay(s3, { session: 's1' })).toThrow(/need 2 takes/);
  });

  it('a different seed picks different takes (the default seed is not special)', () => {
    const a = buildReplay(s3, { seed: 1 }).takes.map((t) => t.id);
    const b = buildReplay(s3, { seed: 2 }).takes.map((t) => t.id);
    expect(a).not.toEqual(b);
  });

  it('pickTakes never puts the same sentence twice in a row (also across the loop seam)', () => {
    for (let seed = 0; seed < 20; seed++) {
      const order = pickTakes(s3.clips, classes.map((c) => c.id), { perClass: 2, nNone: 2 }, mulberry32(seed));
      order.forEach((c, i) => expect(c.label).not.toBe(order[(i + 1) % order.length].label));
    }
  });
});
