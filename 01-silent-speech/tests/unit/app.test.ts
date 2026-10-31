import { describe, expect, it, vi } from 'vitest';
import classes from '../../shared/classes.json';
import { App, PAD_SEC, type ClipEvent } from '../../web/src/core/app';
import type { ClassDef, Classifier } from '../../web/src/core/contracts';
import { MotionSynth } from '../../web/src/core/synth';
import { createStore } from '../../web/src/store';

function feed(app: App, synth: MotionSynth, t0: number, t1: number) {
  for (const s of synth.range(t0, t1)) app.bus.emit('motion', s);
}

describe('App push to talk', () => {
  it('cuts a clip from press - pad to release + pad', () => {
    const app = new App(classes as ClassDef[], createStore());
    const synth = new MotionSynth(1);
    const clips: ClipEvent[] = [];
    app.bus.on('clip', (c) => clips.push(c));
    feed(app, synth, 0, 2);
    app.ptt(true);
    feed(app, synth, 2, 3.5);
    app.ptt(false);
    feed(app, synth, 3.5, 4.5);
    expect(clips).toHaveLength(1);
    const c = clips[0];
    expect(c.samples[0].t).toBeGreaterThanOrEqual(c.pressT - PAD_SEC - 1e-6);
    expect(c.samples.at(-1)!.t).toBeLessThanOrEqual(c.releaseT + PAD_SEC + 1e-6);
    expect(c.samples.length).toBeGreaterThan(45);
  });

  it('predicts in classify mode', () => {
    const app = new App(classes as ClassDef[], createStore());
    const model: Classifier = { name: 'x', labels: ['a'], predict: vi.fn(() => ({ label: 'a', confidence: 1, accepted: true, top: [], ms: 0 })) };
    app.setModel(model);
    app.setMode('classify');
    const preds: string[] = [];
    app.bus.on('prediction', (p) => preds.push(p.label));
    const synth = new MotionSynth(2);
    feed(app, synth, 0, 1);
    app.ptt(true);
    feed(app, synth, 1, 2);
    app.ptt(false);
    feed(app, synth, 2, 3);
    expect(preds).toEqual(['a']);
  });

  it('simulates actions when the source cannot run them', async () => {
    const app = new App(classes as ClassDef[], createStore());
    const r = await app.sendAction({ action: 'volume_up', label: 'volume_up', confidence: 0.9 });
    expect(r).toMatchObject({ ok: true, dryRun: true, action: 'volume_up' });
  });

  it('keeps 30 s of samples even if the bridge reports a silly hz', () => {
    const app = new App(classes as ClassDef[], createStore());
    app.bus.emit('status', { type: 'status', headphones: 'connected', auth: 'authorized', loc: 'left', hz: 2, gapPct: 0, clients: 1, armed: false, simulated: false });
    const synth = new MotionSynth(4);
    const clips: ClipEvent[] = [];
    app.bus.on('clip', (c) => clips.push(c));
    feed(app, synth, 0, 2);
    app.ptt(true);
    feed(app, synth, 2, 6);
    app.ptt(false);
    feed(app, synth, 6, 7);
    expect(app.ring.length).toBeGreaterThan(150);
    expect(clips[0].samples[0].t).toBeLessThan(2 - PAD_SEC + 0.05);
  });

  it('press before any data: clip starts at the first sample, not t = 0', () => {
    const app = new App(classes as ClassDef[], createStore());
    const synth = new MotionSynth(5);
    const clips: ClipEvent[] = [];
    app.bus.on('clip', (c) => clips.push(c));
    app.ptt(true);
    feed(app, synth, 10, 11.5);
    app.ptt(false);
    feed(app, synth, 11.5, 12.5);
    expect(clips).toHaveLength(1);
    expect(clips[0].pressT).toBeGreaterThanOrEqual(10);
  });

  it('press and release with no data at all makes no clip', () => {
    const app = new App(classes as ClassDef[], createStore());
    let n = 0;
    app.bus.on('clip', () => n++);
    app.ptt(true);
    app.ptt(false);
    expect(n).toBe(0);
  });

  it('a clock jump backwards resets the ring and a held key', () => {
    const app = new App(classes as ClassDef[], createStore());
    const synth = new MotionSynth(6);
    feed(app, synth, 100, 102);
    app.ptt(true);
    feed(app, new MotionSynth(7), 0, 1);
    expect(app.pttDown).toBe(false);
    expect(app.ring[0].t).toBeLessThan(2);
  });

  it('a model that throws does not crash the app', () => {
    const app = new App(classes as ClassDef[], createStore());
    app.setModel({ name: 'boom', labels: [], predict: () => { throw new Error('boom'); } });
    app.setMode('classify');
    const synth = new MotionSynth(8);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    feed(app, synth, 0, 1);
    app.ptt(true);
    feed(app, synth, 1, 2);
    app.ptt(false);
    expect(() => feed(app, synth, 2, 3)).not.toThrow();
    expect(app.counts.clip).toBe(1);
    err.mockRestore();
  });
});
