// Fake source: synthetic motion at 25 Hz in real time. On push to talk it "says" app.fakeLabel
// (or a random sentence). Lets everything run with no AirPods.
import type { App, MotionSource, SourceDef } from '../core/app';
import { NONE } from '../core/contracts';
import { MotionSynth, fakeHello, fakeStatus } from '../core/synth';

class FakeSource implements MotionSource {
  kind = 'fake' as const;
  private synth: MotionSynth;
  private start0 = 0;
  private k = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private off: (() => void) | null = null;
  private T0 = 1000; // sample clock offset, seconds

  constructor(private app: App, opts: Record<string, string> = {}) {
    this.synth = new MotionSynth(Number(opts.seed ?? 42), { dropRate: Number(opts.drop ?? 0) });
  }

  async start() {
    const app = this.app;
    const actions = app.classes.filter((c) => c.action).map((c) => c.action as string);
    app.bus.emit('conn', { state: 'open', url: 'fake' });
    app.bus.emit('hello', fakeHello(actions));
    app.bus.emit('status', fakeStatus());
    this.start0 = performance.now();
    this.timers.push(setInterval(() => this.tick(), 40));
    this.timers.push(setInterval(() => app.bus.emit('status', fakeStatus()), 1000));
    this.off = app.bus.on('ptt', ({ down }) => {
      if (!down) return;
      const pool = app.classes.filter((c) => c.id !== NONE);
      const cls = app.classes.find((c) => c.id === app.fakeLabel) ?? pool[Math.floor(Math.random() * pool.length)];
      this.synth.utter(cls, this.now() + 0.15);
    });
  }

  private now() { return this.T0 + (performance.now() - this.start0) / 1000; }

  private tick() {
    const due = Math.floor(((performance.now() - this.start0) / 1000) * this.synth.hz);
    for (; this.k <= due; this.k++) {
      const s = this.synth.sampleAt(this.T0 + this.k / this.synth.hz);
      if (s) this.app.bus.emit('motion', s);
    }
    if (this.k % 250 === 0) this.synth.prune(this.now() - 5);
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.off?.();
    this.app.bus.emit('conn', { state: 'closed', url: 'fake' });
  }
}

const def: SourceDef = { kind: 'fake', create: (app, opts) => new FakeSource(app, opts) };
export default def;
