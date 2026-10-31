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
});
