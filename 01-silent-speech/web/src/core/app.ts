// App core: event bus, ring buffer, push to talk clip cutting, source registry. No DOM here.
import type {
  ActionRequestMsg, ActionResultMsg, ClassDef, Classifier, HelloMsg, MotionSample, Prediction, StatusMsg,
} from './contracts';
import { gapPct } from './synth';
import type { ClipStore } from '../store';

export type SourceKind = 'live' | 'fake' | 'replay';
export type Mode = 'enroll' | 'classify';

export interface ClipEvent {
  id: string;
  samples: MotionSample[];
  pressT: number;
  releaseT: number;
  padSec: number;
  gapPct: number;
}

export type Events = {
  motion: MotionSample;
  status: StatusMsg;
  hello: HelloMsg;
  conn: { state: 'connecting' | 'open' | 'closed'; url: string };
  invalid: { raw: string }; // a frame that failed parseServerMsg (live source emits this)
  ptt: { down: boolean; t: number };
  clip: ClipEvent;
  prediction: Prediction & { clipId: string };
  actionResult: ActionResultMsg;
  mode: Mode;
  source: SourceKind;
  model: Classifier | null;
};

type Handler<T> = (v: T) => void;

export class Bus<E extends Record<string, unknown>> {
  private h = new Map<keyof E, Set<Handler<never>>>();
  readonly counts: Partial<Record<keyof E, number>> = {};
  on<K extends keyof E>(k: K, fn: Handler<E[K]>): () => void {
    if (!this.h.has(k)) this.h.set(k, new Set());
    this.h.get(k)!.add(fn as Handler<never>);
    return () => this.h.get(k)!.delete(fn as Handler<never>);
  }
  emit<K extends keyof E>(k: K, v: E[K]) {
    this.counts[k] = (this.counts[k] ?? 0) + 1;
    for (const fn of this.h.get(k) ?? []) {
      try { (fn as Handler<E[K]>)(v); } catch (e) { console.error(`[bus] ${String(k)} handler failed`, e); }
    }
  }
}

export interface Panel {
  id: string;
  order: number; // lower = earlier on the page
  title: string;
  mount(el: HTMLElement, app: App): void;
}

export interface MotionSource {
  kind: SourceKind;
  /** Must resolve right away (don't wait for a connection) and must never reject. Report problems via `conn`. */
  start(): Promise<void>;
  stop(): void;
  sendAction?(r: ActionRequestMsg): Promise<ActionResultMsg>;
}

export interface SourceDef {
  kind: SourceKind;
  create(app: App, opts?: Record<string, string>): MotionSource;
}

export const PAD_SEC = 0.3;
const RING_SEC = 30;
const RING_MAX = 5000; // hard cap in samples, whatever the clock does

let idCounter = 0;
export const newId = (prefix = 'id') => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export class App {
  readonly bus = new Bus<Events>();
  readonly classes: ClassDef[];
  readonly store: ClipStore;
  readonly sources = new Map<SourceKind, SourceDef>();
  mode: Mode = 'enroll';
  model: Classifier | null = null;
  source: MotionSource | null = null;
  /** In fake mode: which class the fake source "says" on push to talk. null = random non-none. */
  fakeLabel: string | null = null;
  lastHello: HelloMsg | null = null;
  lastStatus: StatusMsg | null = null;
  ring: MotionSample[] = [];
  pttDown = false;
  private pressT: number | null = null; // null = pressed before any sample arrived
  private pending: { pressT: number; releaseT: number; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(classes: ClassDef[], store: ClipStore) {
    this.classes = classes;
    this.store = store;
    this.bus.on('motion', (s) => this.onMotion(s));
    this.bus.on('hello', (h) => (this.lastHello = h));
    this.bus.on('status', (s) => (this.lastStatus = s));
  }

  get counts() { return this.bus.counts; }
  get lastT(): number { return this.ring.length ? this.ring[this.ring.length - 1].t : 0; }

  registerSource(def: SourceDef) { this.sources.set(def.kind, def); }

  async setSource(kind: SourceKind, opts?: Record<string, string>) {
    const def = this.sources.get(kind);
    if (!def) throw new Error(`no source registered for ${kind}`);
    this.source?.stop();
    this.resetCapture();
    this.source = def.create(this, opts);
    this.bus.emit('source', kind);
    await this.source.start();
  }

  setMode(m: Mode) { this.mode = m; this.bus.emit('mode', m); }
  setModel(m: Classifier | null) { this.model = m; this.bus.emit('model', m); }

  /** Push to talk. `t` (sample clock) defaults to the latest sample; replay passes it explicitly. */
  ptt(down: boolean, t: number = this.lastT) {
    if (down === this.pttDown) return;
    this.pttDown = down;
    const empty = this.ring.length === 0;
    this.bus.emit('ptt', { down, t });
    if (down) { this.pressT = empty ? null : t; return; }
    const pressT = this.pressT;
    this.pressT = null;
    if (pressT === null || empty) return; // no data while held: nothing to cut
    // Wait for PAD_SEC of samples after release (or give up after 1.5 s and cut what we have).
    if (this.pending) this.finishClip();
    this.pending = { pressT, releaseT: t, timer: setTimeout(() => this.finishClip(), 1500) };
  }

  /** Clears the ring and any half finished push to talk (source switch, clock jump). */
  private resetCapture() {
    const t = this.lastT;
    this.ring = [];
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.pressT = null;
    if (this.pttDown) { this.pttDown = false; this.bus.emit('ptt', { down: false, t }); }
  }

  private onMotion(s: MotionSample) {
    // Clock went backwards by more than a second (e.g. Simulate toggled): start fresh.
    if (this.ring.length && s.t < this.lastT - 1) this.resetCapture();
    this.ring.push(s);
    if (this.pttDown && this.pressT === null) this.pressT = s.t; // pressed before data arrived
    while (this.ring.length > 1 && this.ring[0].t < s.t - RING_SEC) this.ring.shift();
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    if (this.pending && s.t >= this.pending.releaseT + PAD_SEC) this.finishClip();
  }

  /** Samples with t in [t0, t1]. */
  window(t0: number, t1: number): MotionSample[] {
    return this.ring.filter((s) => s.t >= t0 && s.t <= t1);
  }

  private finishClip() {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    const samples = this.window(p.pressT - PAD_SEC, p.releaseT + PAD_SEC);
    if (samples.length < 3) return;
    const clip: ClipEvent = {
      id: newId('clip'), samples, pressT: p.pressT, releaseT: p.releaseT, padSec: PAD_SEC,
      gapPct: gapPct(samples),
    };
    this.bus.emit('clip', clip);
    if (this.mode === 'classify' && this.model) {
      try {
        const pred = this.model.predict(samples);
        this.bus.emit('prediction', { ...pred, clipId: clip.id });
      } catch (e) {
        console.error('[model] predict failed', e);
      }
    }
  }

  /** Asks the source to run an action. Sources without sendAction get a simulated result. */
  async sendAction(r: Omit<ActionRequestMsg, 'type' | 'id'>): Promise<ActionResultMsg> {
    const req: ActionRequestMsg = { type: 'action', id: newId('act'), ...r };
    const res: ActionResultMsg = this.source?.sendAction
      ? await this.source.sendAction(req)
      : { type: 'actionResult', id: req.id, action: req.action, ok: true, dryRun: true, message: `Simulated: ${req.label}`, ms: 0 };
    this.bus.emit('actionResult', res);
    return res;
  }
}
