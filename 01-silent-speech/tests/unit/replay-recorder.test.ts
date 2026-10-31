// Session recorder: what it captures, how takes get truth labels, undo, limits, and that its file plays back.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App } from '../../web/src/core/app';
import type { ClassDef, MotionSample, Session } from '../../web/src/core/contracts';
import { NONE } from '../../web/src/core/contracts';
import { mulberry32 } from '../../web/src/core/rng';
import { fakeHello, fakeStatus, MotionSynth } from '../../web/src/core/synth';
import { validateSession } from '../../web/src/core/validate';
import { demoScript, MAX_SEC, SessionRecorder, sessionFileName } from '../../web/src/panels/session-recorder/recorder';
import { ReplaySource } from '../../web/src/sources/replay';

const classes = JSON.parse(readFileSync(new URL('../../shared/classes.json', import.meta.url), 'utf8')) as ClassDef[];
const actions = classes.filter((c) => c.action).map((c) => c.action as string);
const hello = fakeHello(actions, true);
const status = fakeStatus({ simulated: false, loc: 'right', hz: 50 });
const stream = (t0: number, t1: number) => new MotionSynth(3, { hz: 50 }).range(t0, t1).map((s) => ({ ...s, g: [0, 0, -1] as [number, number, number] }));

/** Records `samples`, with takes [t0, t1, label] pressed and released at those sample times. */
function record(samples: MotionSample[], takes: [number, number, string | null][], rec = new SessionRecorder()) {
  rec.start(hello, status, new Date('2026-10-31T17:00:00Z'));
  let k = 0, down = false;
  for (const s of samples) {
    rec.motion(s);
    const tk = takes[k];
    if (tk && !down && s.t >= tk[0]) { rec.ptt(true, s.t, tk[2]); down = true; }
    if (tk && down && s.t >= tk[1]) {
      rec.ptt(false, s.t);
      rec.prediction(tk[2] ?? 'help', 0.8, s.t + 0.3);
      rec.action('volume_up', true, s.t + 0.4);
      down = false;
      k++;
    }
  }
  return rec;
}

describe('SessionRecorder', () => {
  it('captures motion (without gravity), push to talk, predictions, actions and labelled truth into a valid file', () => {
    const rec = record(stream(100, 110), [[101, 103, 'help'], [105, 107, 'none'], [108, 109, null]]);
    rec.stop();
    const out = rec.export();
    if (!out.ok) throw new Error(out.errors.join());
    const s = out.session;
    expect(validateSession(JSON.parse(out.text))).toEqual([]);
    expect(s).toMatchObject({ format: 'ss-session', v: 1, recordedAt: '2026-10-31T17:00:00.000Z', hello, status });
    expect(s.samples).toHaveLength(500);
    expect(s.samples.every((x) => x.g === undefined)).toBe(true);
    expect(s.events.filter((e) => e.kind === 'ptt')).toHaveLength(6);
    expect(s.events.filter((e) => e.kind === 'prediction')).toHaveLength(3);
    expect(s.events.filter((e) => e.kind === 'action')).toHaveLength(3);
    expect(s.events.map((e) => e.t)).toEqual([...s.events.map((e) => e.t)].sort((a, b) => a - b));
    // the unlabelled take has push to talk events but no truth (the replay won't score it)
    expect(s.truth.map((w) => w.label)).toEqual(['help', 'none']);
    expect(s.truth[0].t0).toBeGreaterThanOrEqual(101);
    expect(s.truth[0].t1).toBeGreaterThanOrEqual(103);
    expect(rec.nTakes).toBe(3);
  });

  it('ignores everything while not recording, and a release whose press came before Record', () => {
    const rec = new SessionRecorder();
    rec.motion(stream(0, 0.1)[0]);
    rec.ptt(true, 0);
    rec.prediction('help', 1, 0);
    expect(rec.hasData).toBe(false);
    rec.start(hello, status);
    rec.ptt(false, 1);
    expect(rec.events).toEqual([]);
    expect(rec.export()).toEqual({ ok: false, errors: ['no motion recorded'] });
  });

  it('Stop drops a take whose release never came', () => {
    const samples = stream(0, 4);
    const rec = record(samples, [[0.5, 1, 'help']]);
    rec.ptt(true, 2, 'calendar');
    rec.prediction('calendar', 0.9, 2.5);
    rec.stop();
    const s = rec.toSession();
    expect(s.truth.map((w) => w.label)).toEqual(['help']);
    expect(s.events.filter((e) => e.kind === 'ptt')).toHaveLength(2);
    expect(s.events.some((e) => e.t >= 2)).toBe(false);
  });

  it('Undo removes the last take with its prediction and action, and gives its label back', () => {
    const rec = record(stream(0, 6), [[0.5, 1, 'help'], [2, 3, 'calendar']]);
    expect(rec.undoLast()).toEqual({ label: 'calendar' });
    const s = rec.toSession();
    expect(s.truth.map((w) => w.label)).toEqual(['help']);
    expect(s.events.filter((e) => e.t >= 2)).toEqual([]);
    expect(rec.nPredictions).toBe(1);
    expect(rec.undoLast()).toEqual({ label: 'help' });
    expect(rec.undoLast()).toBeNull();
    rec.ptt(true, 5, 'help');
    expect(rec.undoLast()).toBeNull(); // not while a take is being held
  });

  it('notices a bud or Simulate change, and stops itself at the time limit', () => {
    const rec = new SessionRecorder();
    rec.start(hello, status);
    rec.onStatus({ ...status, hz: 49 });
    expect(rec.statusChanged).toBe(false);
    rec.onStatus({ ...status, loc: 'left' });
    expect(rec.statusChanged).toBe(true);
    const s0 = stream(0, 0.1)[0];
    expect(rec.motion({ ...s0, t: 0 })).toBe(true);
    expect(rec.motion({ ...s0, seq: 1, t: MAX_SEC + 0.1 })).toBe(false);
    expect(rec.recording).toBe(false);
  });

  it('its file plays back in the replay source with every labelled take scored against its window', async () => {
    const rec = record(stream(5000, 5012), [[5001, 5003, 'help'], [5005, 5006.5, 'none'], [5008, 5010, 'text_mom']]);
    rec.stop();
    const s = rec.toSession();
    const app = new App(classes, { all: () => [] } as unknown as ConstructorParameters<typeof App>[1]);
    let now = 0;
    const src = new ReplaySource(app, {}, { fetchJson: async () => structuredClone(s) as Session, now: () => now, timers: false });
    const clips: [number, number][] = [];
    app.bus.on('clip', (c) => clips.push([c.pressT, c.releaseT]));
    await src.start();
    await new Promise((r) => setTimeout(r, 0));
    while (src.pass === 0) { now += 40; src.tick(); }
    expect(clips).toEqual(s.truth.map((w) => [w.t0, w.t1]));
  });
});

describe('demoScript', () => {
  it('every sentence twice plus two "say nothing", no repeats in a row, ending on demo_48h', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const sc = demoScript(classes, mulberry32(seed));
      expect(sc).toHaveLength(16);
      for (const c of classes) expect(sc.filter((x) => x === c.id)).toHaveLength(2);
      expect(sc.at(-1)).toBe('demo_48h');
      sc.forEach((x, i) => { if (i) expect(x).not.toBe(sc[i - 1]); });
    }
    expect(demoScript(classes.filter((c) => c.id !== 'demo_48h'), mulberry32(1)).filter((x) => x === NONE)).toHaveLength(2);
  });
});

it('sessionFileName', () => {
  expect(sessionFileName(new Date(2026, 9, 31, 9, 5))).toBe('ss-session-20261031-0905.json');
});
