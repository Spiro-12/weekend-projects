// Replay source: loading never blocks or throws, real time playback on the sample clock, push to talk at the
// recorded times through the real shell, loops without resetting the clock, speed, pause, and the full path
// (shell cuts clips, a real model predicts, the scoreboard marks them) on synthetic and real held-out data.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App, PAD_SEC, type ClipEvent } from '../../web/src/core/app';
import type { ClassDef, Classifier, Dataset, MotionSample, Session } from '../../web/src/core/contracts';
import { synthSession } from '../../web/src/core/synth';
import * as ml from '../../web/src/ml/index';
import { mergeDatasets } from '../../web/src/ml/data';
import { Scoreboard, verdict } from '../../web/src/panels/replay/score';
import { ReplaySource, resolveSessionUrl, type ReplayEnv, type ReplayMeta } from '../../web/src/sources/replay';

const root = new URL('../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');
const classes = JSON.parse(read('shared/classes.json')) as ClassDef[];
const store = { all: () => [] } as unknown as ConstructorParameters<typeof App>[1];
const flush = () => new Promise((r) => setTimeout(r, 0));
const short = synthSession(classes.filter((c) => ['text_mom', 'help', 'none'].includes(c.id)), 5, 1); // 3 takes, 25 Hz

let demo: Session, demoMeta: ReplayMeta;
beforeAll(() => {
  demo = JSON.parse(read('web/public/replay/demo-session.json')) as Session;
  demoMeta = JSON.parse(read('web/public/replay/demo-session.meta.json')) as ReplayMeta;
});
afterEach(() => vi.restoreAllMocks());

interface Rig {
  app: App; src: ReplaySource; motion: MotionSample[]; ptt: { down: boolean; t: number }[];
  conn: string[]; clips: ClipEvent[]; board: Scoreboard; fetched: string[];
  run(ms: number, step?: number): void; clock(): number; setClock(ms: number): void;
}

/** App + replay source on a fake clock (no timers): run(ms) advances wall time in 40 ms ticks. */
async function rig(session: unknown, opts: Record<string, string> = {}, env: Partial<ReplayEnv> = {}, model?: Classifier): Promise<Rig> {
  const app = new App(classes, store);
  if (model) app.setModel(model);
  let now = 0;
  const motion: MotionSample[] = [], ptt: Rig['ptt'] = [], conn: string[] = [], clips: ClipEvent[] = [], fetched: string[] = [];
  app.bus.on('motion', (s) => motion.push(s));
  app.bus.on('ptt', (p) => ptt.push(p));
  app.bus.on('conn', (c) => conn.push(c.state));
  app.bus.on('clip', (c) => clips.push(c));
  const src = new ReplaySource(app, opts, {
    fetchJson: async (url) => { fetched.push(url); if (url.endsWith('.meta.json')) throw new Error('no meta'); return structuredClone(session); },
    now: () => now, timers: false, ...env,
  });
  // Wire the scoreboard like the replay panel does.
  const board = new Scoreboard();
  const sync = () => { if (src.session) for (let p = board.pass + 1; p <= src.pass; p++) board.setPass(p, src.truthFor(p)); };
  src.onChange(sync);
  app.bus.on('clip', (c) => { sync(); board.clip(c.id, c.pressT, c.releaseT, app.mode === 'classify' && !!app.model); });
  app.bus.on('prediction', (p) => board.prediction(p.clipId, p));
  app.registerSource({ kind: 'replay', create: () => src });
  await app.setSource('replay');
  await flush();
  const r: Rig = {
    app, src, motion, ptt, conn, clips, board, fetched,
    run(ms, step = 40) { for (let t = 0; t < ms; t += step) { now += step; src.tick(); board.update(src.headT); } },
    clock: () => now, setClock: (ms) => { now = ms; },
  };
  return r;
}

const increasing = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);

describe('resolveSessionUrl', () => {
  const base = '/weekend-projects/01-silent-speech/', page = 'https://spiro-12.github.io/weekend-projects/01-silent-speech/?x=1';
  it('defaults to the demo file under the Pages base', () => {
    expect(resolveSessionUrl(undefined, base, page)).toEqual({ url: 'https://spiro-12.github.io/weekend-projects/01-silent-speech/replay/demo-session.json', isDefault: true });
  });
  it('takes same site paths, refuses other sites', () => {
    expect(resolveSessionUrl('replay/other.json', base, page)).toEqual({ url: 'https://spiro-12.github.io/weekend-projects/01-silent-speech/replay/other.json', isDefault: false });
    expect(resolveSessionUrl('/x.json', base, page)).toMatchObject({ url: 'https://spiro-12.github.io/x.json' });
    expect(resolveSessionUrl('https://evil.example/s.json', base, page)).toEqual({ error: 'Replay files must come from this site.' });
    expect(resolveSessionUrl('//evil.example/s.json', base, page)).toHaveProperty('error');
  });
});

describe('ReplaySource loading', () => {
  it('start() resolves right away even if the file never arrives, and switches to Recognize mode', async () => {
    const app = new App(classes, store);
    const conn: string[] = [];
    app.bus.on('conn', (c) => conn.push(c.state));
    const src = new ReplaySource(app, {}, { fetchJson: () => new Promise(() => {}), now: () => 0, timers: false });
    expect(app.mode).toBe('enroll');
    await expect(src.start()).resolves.toBeUndefined();
    expect(app.mode).toBe('classify');
    expect(conn).toEqual(['connecting']);
    expect(src.phase).toBe('loading');
  });

  it.each([
    ['a network error', () => Promise.reject(new Error('offline')), /offline/],
    ['a broken file', () => Promise.resolve({ format: 'nope' }), /not a valid replay file/],
    ['a file without motion', () => Promise.resolve({ ...short, samples: [] }), /no motion/],
  ])('never rejects on %s: phase error, conn closed', async (_name, fetchJson, msg) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await rig(null, {}, { fetchJson });
    expect(r.src.phase).toBe('error');
    expect(r.src.error).toMatch(msg);
    expect(r.conn).toEqual(['connecting', 'closed']);
    expect(warn).toHaveBeenCalled();
    r.run(1000);
    expect(r.motion).toHaveLength(0);
  });

  it('refuses a session from another site without fetching it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await rig(short, { session: 'https://evil.example/s.json' });
    expect(r.fetched).toEqual([]);
    expect(r.src.phase).toBe('error');
    expect(r.src.error).toMatch(/this site/);
  });

  it('says hello and status as not armed and simulated, whatever the file says', async () => {
    const app = new App(classes, store);
    const seen: unknown[] = [];
    app.bus.on('hello', (h) => seen.push(h));
    app.bus.on('status', (s) => seen.push(s));
    const armed = { ...demo, hello: { ...demo.hello, armed: true }, status: { ...demo.status, armed: true, simulated: false } };
    const src = new ReplaySource(app, {}, { fetchJson: async () => armed, now: () => 0, timers: false });
    await src.start();
    await flush();
    expect(seen).toEqual([{ ...demo.hello, armed: false }, { ...demo.status, armed: false, simulated: true }]);
    expect(app.lastStatus?.loc).toBe('left'); // the shell passes this to predict (bud normalization)
  });

  it('uses the meta sidecar only for the default file and only if it matches the session', async () => {
    const withMeta = (meta: unknown): Partial<ReplayEnv> => ({ fetchJson: async (u) => (u.endsWith('.meta.json') ? meta : structuredClone(demo)) });
    expect((await rig(demo, {}, withMeta(demoMeta))).src.meta).toEqual(demoMeta);
    const stale = { ...demoMeta, matches: { ...demoMeta.matches, nSamples: 1 } };
    expect((await rig(demo, {}, withMeta(stale))).src.meta).toBeNull();
    const custom = await rig(demo, { session: 'replay/other.json' }, withMeta(demoMeta));
    expect(custom.src.meta).toBeNull();
    const r = await rig(demo);
    expect(r.fetched.map((u) => u.replace(/^.*\/replay\//, ''))).toEqual(['demo-session.json', 'demo-session.meta.json']);
  });

  it('stop() silences everything, including a file that arrives late', async () => {
    let resolve!: (v: unknown) => void;
    const app = new App(classes, store);
    const events: string[] = [];
    for (const k of ['motion', 'hello', 'status'] as const) app.bus.on(k, () => events.push(k));
    const src = new ReplaySource(app, {}, { fetchJson: () => new Promise((r) => { resolve = r; }), now: () => 0, timers: false });
    await src.start();
    src.stop();
    resolve(structuredClone(short));
    await flush();
    src.tick();
    expect(events).toEqual([]);
  });
});

describe('ReplaySource playback', () => {
  it('plays in real time on the sample clock (50 Hz file: ~50 samples a second), 2× twice as fast', async () => {
    const r = await rig(demo);
    const n0 = r.motion.length;
    r.run(2000);
    expect(r.motion.length - n0).toBeGreaterThanOrEqual(98);
    expect(r.motion.length - n0).toBeLessThanOrEqual(102);
    r.src.setSpeed(2);
    const n1 = r.motion.length;
    r.run(2000);
    expect(r.motion.length - n1).toBeGreaterThanOrEqual(196);
    expect(r.motion.length - n1).toBeLessThanOrEqual(204);
    r.src.setSpeed(0); // out of range: ignored
    expect(r.src.speed).toBe(2);
  });

  it('presses push to talk through the shell at the recorded times, and the shell cuts one clip per take', async () => {
    const r = await rig(demo);
    r.run(30_000);
    const truth = demo.truth.filter((w) => w.t1 + PAD_SEC < r.src.headT);
    expect(truth.length).toBeGreaterThanOrEqual(4);
    expect(r.ptt.slice(0, truth.length * 2)).toEqual(truth.flatMap((w) => [{ down: true, t: w.t0 }, { down: false, t: w.t1 }]));
    expect(r.clips.map((c) => [c.pressT, c.releaseT])).toEqual(truth.map((w) => [w.t0, w.t1]));
  });

  it('loops forever with the clock and seq still counting up, windows shifted by one loop', async () => {
    const r = await rig(short, { speed: '4' });
    const loop = r.src.duration;
    expect(loop).toBeGreaterThan(5);
    r.run(((2.5 * loop) / 4) * 1000);
    expect(r.src.pass).toBe(2);
    expect(increasing(r.motion.map((s) => s.t))).toBe(true);
    expect(increasing(r.motion.map((s) => s.seq))).toBe(true);
    const n = short.samples.length;
    expect(r.motion[n].seq).toBe(short.samples[n - 1].seq + 1);
    expect(r.motion[n].t - r.motion[n - 1].t).toBeGreaterThan(0);
    expect(r.motion[n].t - r.motion[n - 1].t).toBeLessThan(0.06);
    const w1 = r.src.truthFor(1);
    w1.forEach((w, i) => { expect(w.t0).toBeCloseTo(short.truth[i].t0 + loop, 4); expect(w.label).toBe(short.truth[i].label); });
    // pass 1's clips line up with pass 1's windows
    const pass1 = r.clips.slice(short.truth.length, 2 * short.truth.length);
    expect(pass1.map((c) => [c.pressT, c.releaseT])).toEqual(w1.map((w) => [w.t0, w.t1]));
    expect(r.app.ring.length).toBeGreaterThan(0); // never reset by a clock jump
  });

  it('pause stops the stream; play picks up exactly where it was', async () => {
    const r = await rig(demo);
    r.run(500); // before the first take (1.3 s)
    r.src.pause();
    expect(r.src.phase).toBe('paused');
    const n = r.motion.length;
    r.run(3000);
    expect(r.motion).toHaveLength(n);
    r.src.play();
    r.run(200);
    expect(r.motion.length).toBeGreaterThan(n);
    expect(r.motion[n].seq).toBe(r.motion[n - 1].seq + 1);
    expect(r.motion[n].t - r.motion[n - 1].t).toBeLessThan(0.03);
  });

  it('pausing right after a release waits for the pad, so the clip is whole', async () => {
    const r = await rig(demo);
    const up = demo.truth[0].t1;
    while (r.src.headT < up + 0.05) r.run(40);
    expect(r.clips).toHaveLength(0);
    r.src.pause();
    expect(r.src.paused).toBe(true);
    r.run(2000);
    expect(r.src.phase).toBe('paused');
    expect(r.clips).toHaveLength(1);
    expect(r.clips[0].samples.at(-1)!.t).toBeGreaterThanOrEqual(up + PAD_SEC - 0.02);
    expect(r.src.headT).toBeLessThan(up + PAD_SEC + 0.1);
  });

  it('after a stall it does not burst more than a second of samples out at once', async () => {
    const r = await rig(demo);
    r.run(400);
    const n = r.motion.length;
    r.setClock(r.clock() + 60_000);
    r.src.tick();
    expect(r.motion.length - n).toBeLessThanOrEqual(51);
    r.run(1000);
    expect(r.motion.length - n).toBeLessThanOrEqual(51 + 51);
  });

  it('pauses while the tab is hidden and resumes without a burst', async () => {
    let hide!: (h: boolean) => void;
    const r = await rig(demo, {}, { onHidden: (fn) => { hide = fn; return () => {}; } });
    r.run(400);
    hide(true);
    const n = r.motion.length;
    r.run(5000);
    expect(r.motion).toHaveLength(n);
    hide(false);
    r.run(400);
    expect(r.motion.length - n).toBeLessThanOrEqual(22);
    expect(r.motion.length - n).toBeGreaterThanOrEqual(18);
  });
});

describe('ReplaySource + shell + real classifier', () => {
  it('synthetic: a model trained on the synthetic fixture gets >= 90% of the synthetic session right', async () => {
    const ds = JSON.parse(read('shared/fixtures/dataset.synthetic.json')) as Dataset;
    const model = ml.train(mergeDatasets([ds]).clips);
    const session = JSON.parse(read('shared/fixtures/session.synthetic.json')) as Session;
    const r = await rig(session, { speed: '8' }, {}, model);
    while (r.src.pass === 0) r.run(400);
    const s = r.board.summary(0);
    expect(s.scored).toBe(session.truth.length);
    expect(s.right / s.scored).toBeGreaterThanOrEqual(0.9);
  });

  it('real held-out takes: every window is scored exactly as the model scores that recorded take', async () => {
    const ex = new Set((JSON.parse(read('data/raw/exclude.json')) as { ids: string[] }).ids);
    const files = ['s1-20261031-1621', 's2-20261031-1637', 's3-20261031-1654'].map((f) => JSON.parse(read(`data/raw/ss-dataset-${f}.json`)) as Dataset);
    const train = mergeDatasets(files.slice(0, 2)).clips.filter((c) => !ex.has(c.id)); // like the public model: s1 + s2
    const model = ml.train(train);
    const r = await rig(demo, { speed: '8' }, {}, model);
    while (r.src.pass === 0) r.run(400);
    const ws = r.board.of(0);
    expect(ws.every((w) => ['right', 'wrong', 'unsure'].includes(w.state))).toBe(true);
    const s3 = new Map(files[2].clips.map((c) => [c.id, c]));
    demoMeta.takes!.forEach((id, k) => {
      const take = s3.get(id)!;
      // The recorded take, moved onto the replay's clock (the raw boot clock is ~1.3e6 s, where float rounding
      // can change preprocessing's grid length by one point; see the Track K report).
      const shift = ws[k].t0 - PAD_SEC - take.samples[0].t;
      const offline = model.predict(take.samples.map((s) => ({ ...s, t: Math.round((s.t + shift) * 1e5) / 1e5 })), { loc: 'left' });
      expect(ws[k].label).toBe(take.label);
      expect(ws[k].predicted).toBe(offline.label);
      expect(ws[k].confidence).toBeCloseTo(offline.confidence, 6);
      expect(ws[k].state).toBe(verdict(take.label, offline));
    });
  });
});
