// Replay source: plays a recorded ss-session (PROTOCOL §4) in real time on its own sample clock, so visitors
// without AirPods see a real session. Push to talk goes through app.ptt(down, t) at the recorded times, so the
// shell cuts the clips and predicts with whatever app.model is, exactly like live. Loops forever (the clock and
// seq keep counting up across loops, nothing resets), at 1× or 2×. Never sends actions (hello/status say
// armed: false, simulated: true). start() resolves right away and never rejects (PROTOCOL §7): load problems
// show up as conn 'closed' and phase 'error'.
//
// URL options: ?session=<same site path> (default replay/demo-session.json), ?speed=1|2.
import { PAD_SEC, type App, type MotionSource, type SourceDef } from '../core/app';
import type { MotionSample, Session, StatusMsg } from '../core/contracts';
import { validateSession } from '../core/validate';

export const DEFAULT_SESSION = 'replay/demo-session.json';
export const SPEEDS = [1, 2] as const;
const TICK_MS = 40;
const STATUS_MS = 1000;
const MAX_BURST_SEC = 1; // after a stall (debugger, sleeping laptop) skip the wait instead of bursting samples out
const PAD_HOLD_SEC = PAD_SEC + 0.05; // a pause right after a release waits for the clip's pad, so the clip is whole
const MIN_SPEED = 0.25, MAX_SPEED = 16; // the UI offers 1× and 2×; tests use ?speed=8

/** Sidecar `<session>.meta.json` written by scripts/build-replay.ts: who and what is in the default replay. */
export interface ReplayMeta {
  format: 'ss-session-meta';
  v: 1;
  /** The meta is only trusted if these match the loaded session (a replaced session file must not keep old claims). */
  matches: { recordedAt: string; nSamples: number; nTruth: number };
  real: boolean; // real AirPods data (not fake motion)
  subject: string;
  device: string;
  heldOut: boolean; // none of the takes were used to train the public model
  note: string;
  builtBy?: string;
  from?: string;
  session?: string;
  seed?: number;
  takes?: string[];
}

export type ReplayPhase = 'loading' | 'playing' | 'paused' | 'error';
export interface TruthWindow { t0: number; t1: number; label: string }

export interface ReplayEnv {
  /** Resolves with parsed JSON, rejects on network / HTTP / parse errors. */
  fetchJson(url: string): Promise<unknown>;
  now(): number; // ms, monotonic
  /** false: no timers, the caller drives tick() (unit tests). */
  timers: boolean;
  /** Pause while the tab is hidden (background tabs only get throttled timers anyway). Calls fn with the current state right away. */
  onHidden?(fn: (hidden: boolean) => void): () => void;
}

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

/** Fetches JSON, and refuses it if a redirect took the request to another site. */
export async function fetchSameSiteJson(url: string, doFetch: (u: string) => Promise<Response> = (u) => fetch(u)): Promise<unknown> {
  const res = await doFetch(url);
  if (res.url && new URL(res.url).origin !== new URL(url).origin) throw new Error('redirected to another site');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const browserEnv = (): ReplayEnv => ({
  fetchJson: (url) => fetchSameSiteJson(url),
  now: () => performance.now(),
  timers: true,
  onHidden(fn) {
    if (typeof document === 'undefined') return () => {};
    const h = () => fn(document.hidden);
    document.addEventListener('visibilitychange', h);
    h(); // a tab that opens in the background starts paused
    return () => document.removeEventListener('visibilitychange', h);
  },
});

/** Where to load the session from. Only same site files: a link can't make the page play someone else's file. */
export function resolveSessionUrl(param: string | undefined, base: string, page: string): { url: string; isDefault: boolean } | { error: string } {
  const root = new URL(base, page);
  if (!param) return { url: new URL(DEFAULT_SESSION, root).href, isDefault: true };
  let u: URL;
  try { u = new URL(param, root); } catch { return { error: 'That replay address is not valid.' }; }
  if (u.origin !== new URL(page).origin) return { error: 'Replay files must come from this site.' };
  return { url: u.href, isDefault: u.href === new URL(DEFAULT_SESSION, root).href };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function metaMatches(m: unknown, s: Session): m is ReplayMeta {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Partial<ReplayMeta>;
  return x.format === 'ss-session-meta' && x.v === 1 && !!x.matches && x.matches.recordedAt === s.recordedAt
    && x.matches.nSamples === s.samples.length && x.matches.nTruth === s.truth.length
    && typeof x.subject === 'string' && typeof x.device === 'string' && typeof x.note === 'string';
}

export class ReplaySource implements MotionSource {
  readonly kind = 'replay' as const;
  readonly url: string;
  readonly isDefault: boolean;
  phase: ReplayPhase = 'loading';
  error = '';
  session: Session | null = null;
  meta: ReplayMeta | null = null;
  speed: number;
  /** How many times the session has started (0 = first time through). */
  pass = 0;
  /** Stream time of the newest sample sent. */
  headT = -Infinity;

  private env: ReplayEnv;
  private samples: MotionSample[] = [];
  private ptts: { t: number; down: boolean }[] = [];
  private status: StatusMsg | null = null;
  private t0 = 0; // first sample t in the file
  private period = 0; // stream seconds per loop
  private seqSpan = 0; // seq numbers per loop
  private i = 0; // next sample
  private e = 0; // next ptt event
  private ownDown = false; // our last app.ptt was a press
  private lastUpT = -Infinity; // stream time of our last release
  private anchorWall = 0; // wall ms at which the playhead was anchorT
  private anchorT = 0;
  private lastTarget = 0; // playhead at the previous tick
  private userPaused = false;
  private hidden = false;
  private holdUntil: number | null = null; // pause requested: keep playing until this stream time
  private started = false;
  private stopped = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private offHidden: (() => void) | null = null;
  private listeners = new Set<() => void>();

  constructor(private app: App, opts: Record<string, string> = {}, env?: Partial<ReplayEnv>) {
    this.env = { ...browserEnv(), ...env };
    const page = typeof location !== 'undefined' ? location.href : 'http://localhost/';
    const r = resolveSessionUrl(opts.session, import.meta.env?.BASE_URL ?? '/', page);
    if ('error' in r) { this.url = opts.session ?? ''; this.isDefault = false; this.error = r.error; }
    else { this.url = r.url; this.isDefault = r.isDefault; }
    const sp = Number(opts.speed);
    this.speed = Number.isFinite(sp) && sp >= MIN_SPEED && sp <= MAX_SPEED ? sp : 1;
  }

  // ---------- MotionSource ----------

  start(): Promise<void> {
    if (this.started || this.stopped) return Promise.resolve();
    this.started = true;
    try {
      this.app.setMode('classify'); // visitors watch the Recognize screen
      this.app.bus.emit('conn', { state: 'connecting', url: this.connUrl() });
      if (this.error) this.fail(this.error);
      else void this.load();
      this.offHidden = this.env.onHidden?.((h) => this.setHidden(h)) ?? null;
    } catch (e) {
      console.warn('[replay] start failed', e);
    }
    return Promise.resolve();
  }

  stop() {
    if (this.stopped) return;
    this.app.bus.emit('conn', { state: 'closed', url: this.connUrl() });
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.offHidden?.();
    this.changed();
    this.listeners.clear();
  }

  // ---------- controls (replay panel) ----------

  get paused() { return this.userPaused || this.holdUntil !== null; }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  pause() {
    if (this.phase !== 'playing' || this.holdUntil !== null) return;
    const head = this.playhead();
    // Just released? Play on until the clip's pad is in, so the shell cuts the whole clip.
    if (!this.ownDown && head < this.lastUpT + PAD_HOLD_SEC) { this.holdUntil = this.lastUpT + PAD_HOLD_SEC; this.changed(); return; }
    this.freeze(head);
  }

  play() {
    if (this.phase === 'paused' || this.holdUntil !== null) {
      this.holdUntil = null;
      if (this.userPaused) { this.userPaused = false; this.anchor(this.anchorT); }
      this.phase = 'playing';
      this.changed();
    }
  }

  setSpeed(x: number) {
    if (!(x >= MIN_SPEED && x <= MAX_SPEED) || x === this.speed) return;
    if (this.running()) this.anchor(this.playhead());
    this.speed = x;
    this.changed();
  }

  /** Truth windows of loop `pass`, in stream time (the times the shell sees). */
  truthFor(pass: number): TruthWindow[] {
    const off = pass * this.period;
    return (this.session?.truth ?? []).map((w) => ({ t0: r5(w.t0 + off), t1: r5(w.t1 + off), label: w.label }));
  }

  /** 0..1 through the current loop. */
  get progress(): number {
    if (!this.period || this.headT === -Infinity) return 0;
    return Math.min(1, Math.max(0, (this.headT - this.t0 - this.pass * this.period) / this.period));
  }

  /** Seconds per loop. */
  get duration() { return this.period; }

  /** Stream time where loop `pass` starts. */
  passStart(pass: number) { return r5(this.t0 + pass * this.period); }

  /** Runs one playback step. Timers call it every 40 ms; unit tests call it directly. */
  tick() {
    if (!this.running()) return;
    const now = this.env.now();
    let target = this.anchorT + ((now - this.anchorWall) / 1000) * this.speed;
    if (target - this.lastTarget > MAX_BURST_SEC) { target = this.lastTarget + MAX_BURST_SEC; this.anchor(target, now); }
    const hold = this.holdUntil;
    if (hold !== null && target >= hold) target = hold;
    this.lastTarget = target;
    this.advance(target);
    if (hold !== null && target >= hold) this.freeze(hold);
  }

  // ---------- internals ----------

  private connUrl() { return this.isDefault ? 'replay' : this.url || 'replay'; }

  private changed() { for (const fn of [...this.listeners]) { try { fn(); } catch (e) { console.error('[replay] listener failed', e); } } }

  private running() { return !this.stopped && this.phase === 'playing' && !this.hidden; }

  private playhead() { return this.hidden ? this.anchorT : this.anchorT + ((this.env.now() - this.anchorWall) / 1000) * this.speed; }

  private anchor(t: number, now = this.env.now()) { this.anchorT = t; this.anchorWall = now; }

  private freeze(head: number) {
    this.holdUntil = null;
    this.userPaused = true;
    this.anchorT = head;
    this.phase = 'paused';
    this.changed();
  }

  private setHidden(h: boolean) {
    if (h === this.hidden) return;
    if (h && this.running()) {
      // Never stop inside a release pad: the shell would cut the clip short on its 1.5 s backup timer.
      // Play on to the end of the pad (or to a pause that was waiting for it) first.
      let head = this.playhead();
      const padEnd = !this.ownDown ? this.lastUpT + PAD_HOLD_SEC : -Infinity;
      const until = Math.max(head, this.holdUntil ?? -Infinity, padEnd);
      // Always send: samples up to the clock target may not have gone out yet (the last tick was earlier).
      this.advance(until);
      head = until;
      this.lastTarget = Math.max(this.lastTarget, until);
      if (this.holdUntil !== null && head >= this.holdUntil) this.freeze(this.holdUntil);
      else this.anchorT = head;
    }
    this.hidden = h;
    if (!h) this.anchorWall = this.env.now(); // pick up where it was
  }

  private fail(msg: string) {
    if (this.stopped) return;
    this.phase = 'error';
    this.error = msg;
    console.warn(`[replay] ${msg}`);
    this.app.bus.emit('conn', { state: 'closed', url: this.connUrl() });
    this.changed();
  }

  private async load() {
    try {
      const metaUrl = this.isDefault ? this.url.replace(/\.json$/, '.meta.json') : null;
      const [raw, meta] = await Promise.all([
        this.env.fetchJson(this.url),
        metaUrl ? this.env.fetchJson(metaUrl).catch(() => null) : Promise.resolve(null),
      ]);
      if (this.stopped) return;
      const errs = validateSession(raw);
      if (errs.length) throw new Error(`not a valid replay file (${errs[0]})`);
      const s = raw as Session;
      this.prepare(s);
      if (metaMatches(meta, s)) this.meta = meta;
      this.session = s;
    } catch (e) {
      console.warn('[replay] load failed:', (e as Error)?.message ?? e);
      this.fail('Could not load the replay (the file is missing or broken).');
      return;
    }
    const s = this.session!;
    const bus = this.app.bus;
    // A replay never runs actions: whatever the recording said, it is not armed and not live AirPods.
    this.status = { ...s.status, armed: false, simulated: true };
    bus.emit('conn', { state: 'open', url: this.connUrl() });
    bus.emit('hello', { ...s.hello, armed: false });
    bus.emit('status', this.status);
    this.phase = 'playing';
    this.lastTarget = this.t0;
    this.anchor(this.t0);
    if (this.env.timers) {
      this.timers.push(setInterval(() => this.tick(), TICK_MS));
      this.timers.push(setInterval(() => { if (!this.stopped && this.status) bus.emit('status', this.status); }, STATUS_MS));
    }
    this.changed();
    this.tick();
  }

  private prepare(s: Session) {
    // Sorted, no repeated timestamps (the shell expects time to move forward).
    const samples: MotionSample[] = [];
    for (const x of [...s.samples].sort((a, b) => a.t - b.t)) if (!samples.length || x.t > samples[samples.length - 1].t) samples.push(x);
    if (samples.length < 2) throw new Error('the replay file has no motion');
    this.samples = samples;
    this.ptts = s.events
      .filter((e): e is { t: number; kind: 'ptt'; down: boolean } => e.kind === 'ptt' && typeof (e as { down?: unknown }).down === 'boolean')
      .map((e) => ({ t: e.t, down: e.down }))
      .sort((a, b) => a.t - b.t);
    const first = samples[0], last = samples[samples.length - 1];
    const dt = median(samples.slice(1).map((x, i) => x.t - samples[i].t)) || 0.02;
    this.t0 = first.t;
    this.period = r5(last.t - first.t + dt);
    this.seqSpan = Math.max(1, last.seq - first.seq + 1);
  }

  /** Sends samples and push to talk events up to stream time `target`, in time order, looping at the end. */
  private advance(target: number) {
    for (let guard = 0; guard < 1e6 && !this.stopped; guard++) {
      const off = this.pass * this.period;
      const s = this.samples[this.i], p = this.ptts[this.e];
      const ts = s ? r5(s.t + off) : Infinity;
      const tp = p ? r5(p.t + off) : Infinity;
      if (ts === Infinity && tp === Infinity) { this.nextPass(); continue; }
      if (Math.min(ts, tp) > target) return;
      if (tp < ts) { this.e++; this.firePtt(p.down, tp); continue; }
      this.i++;
      this.headT = ts;
      const out: MotionSample = { seq: s.seq + this.pass * this.seqSpan, t: ts, q: s.q, rr: s.rr, ua: s.ua };
      if (s.g) out.g = s.g;
      this.app.bus.emit('motion', out);
    }
  }

  private nextPass() {
    if (this.ownDown) this.firePtt(false, this.headT); // a window never spans the loop seam
    this.pass++;
    this.i = 0;
    this.e = 0;
    this.changed();
  }

  private firePtt(down: boolean, t: number) {
    if (down === this.ownDown) return; // two presses in a row in the file: keep the first
    this.ownDown = down;
    if (!down) this.lastUpT = t;
    this.app.ptt(down, t);
  }
}

const def: SourceDef = { kind: 'replay', create: (app, opts) => new ReplaySource(app, opts) };
export default def;
