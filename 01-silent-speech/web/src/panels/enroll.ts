// Enroll panel: a guided recording screen for training data (PROTOCOL §3).
// Shows one sentence at a time (shuffled blocks, every sentence once per block), saves each push to
// talk clip with the sentence that was on screen when Space went down, autosaves (store.ts), shows
// live accuracy and exports ss-dataset files.
//
// Data integrity rules (a wrong label silently poisons training):
// - Each press remembers its own prompt, keyed by the press time; that is the clip's label.
// - A press while loading, on the done screen, or without a signal is never saved.
// - A clip from a stalled or dead stream is rejected (wall clock vs sample clock, coverage checks).
// - Two presses less than SLIP_MS apart (a finger slip) are both thrown away, and a new sentence
//   must be on screen for PROMPT_READY_MS before a press counts (no label from a glimpsed prompt).
// - The recording kind (real / practice) must be the same at press time and when the take lands.
// - Real training data only comes from live, non simulated AirPods. Fake or simulated data goes to
//   separate practice sessions (fake-1, fake-2, …) and is never mixed into a real session.
import './enroll/enroll.css';
import { newId, type App, type ClipEvent, type Panel } from '../core/app';
import { NONE, type BudLocation, type Dataset, type DatasetClip, type Metrics, type StatusMsg } from '../core/contracts';
import { validateDataset } from '../core/validate';
import * as ml from '../ml/index';
import type { ClipMeta } from '../store';
import { Evaluator, type EvalResult } from './enroll/accuracy';
import { isNotImplemented } from './enroll/eval-core';
import {
  NO_SIGNAL, PRACTICE_PREFIX, Prompter, REAL_PREFIX, cleanSessionName, clipHz, evalSet, exportFileName,
  nextSessionName, planImport, promptText, recKind, shortLabel, takeReject,
  MIN_CLASSES, MIN_PER_CLASS, STALE_AT_RELEASE_MS, type RecKind,
} from './enroll/logic';

const SETTINGS_KEY = 'ss.enroll';
const DEFAULT_REPS = 15;
const DEVICE_MODEL = 'AirPods Pro 3';
const EVAL_DEBOUNCE_MS = 600;
const NO_CLIP_MS = 2200; // the shell gives up waiting for the release pad after 1.5 s
const SIGNAL_STALE_MS = 1500;
const SLIP_MS = 1000; // a new press this soon after letting go = finger slip (takes are held this long)
const PROMPT_READY_MS = 400; // a new sentence must be on screen this long before a press counts
const SLOW_LOAD_MS = 5000;

const WAIT_MSG = "Wait until the sentence turns solid white, then hold Space.";
const NOT_READY_MSG = "Wait for a sentence to show, then hold Space.";
const SLIP_MSG = 'Finger slipped, say it again.';
const SAVE_FAILED = 'Recorded but NOT saved in this browser. Press Export now.';
const NO_AUTOSAVE = 'Autosave is off in this browser. Press Export before you close the page.';
const PRACTICE_NOTE = 'Practice with fake data (not saved as real training data).';
const OFF_BANNER = 'Not connected to AirPods. Recording real data is off.';
const FAKE_BANNER = 'Fake AirPods data (no Mac app connected). You can practice here, nothing is saved as real training data.';
const SIMULATE_BANNER = 'The Mac app is in Simulate mode. Real recording is off.';
const STORAGE_STUCK = "This browser's storage isn't answering, so recordings are only kept on this page. Press Export before you close it.";
const KIND_CHANGED = 'Not saved: the AirPods mode changed while you were recording. Say it again.';

interface Settings {
  session: string; // real session (s1, s2, …)
  practice: string; // practice session (fake-1, fake-2, …)
  reps: number;
  classes: string[] | null; // null = every class
  subject: string;
}

function loadSettings(): Settings {
  const d: Settings = { session: 's1', practice: 'fake-1', reps: DEFAULT_REPS, classes: null, subject: 'spiro' };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null;
    if (!raw || typeof raw !== 'object') return d;
    const name = typeof raw.session === 'string' ? cleanSessionName(raw.session) : '';
    if (name && !name.startsWith(PRACTICE_PREFIX)) d.session = name;
    const pname = typeof raw.practice === 'string' ? cleanSessionName(raw.practice) : '';
    if (pname.startsWith(PRACTICE_PREFIX)) d.practice = pname;
    if (Number.isInteger(raw.reps) && raw.reps! >= 1 && raw.reps! <= 100) d.reps = raw.reps!;
    if (Array.isArray(raw.classes) && raw.classes.every((x) => typeof x === 'string')) d.classes = raw.classes;
    if (typeof raw.subject === 'string' && raw.subject.trim()) d.subject = raw.subject.trim().slice(0, 40);
  } catch { /* storage blocked or junk: defaults */ }
  return d;
}

/** One push to talk, from Space down to its clip being saved or thrown away. */
interface Press {
  t: number; // sample clock at press = ClipEvent.pressT
  wallDown: number; // performance.now()
  wallUp: number | null;
  motionAgeAtUp: number; // ms since the newest sample, when Space was let go
  label: string | null; // the prompt on screen when Space went down
  session: string;
  kind: RecKind | null;
  loc: BudLocation;
  block: string | null; // why it can't be saved, decided at press time
  slipped: boolean;
  timer: ReturnType<typeof setTimeout> | null; // "no clip came" watchdog
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const recs = (n: number) => `${n} recording${n === 1 ? '' : 's'}`;

type Kind = 'ok' | 'bad' | 'info';
type AccView =
  | { state: 'waiting' }
  | { state: 'running' }
  | { state: 'ready'; res: EvalResult }
  | { state: 'not-ready' }
  | { state: 'error'; msg: string };

const TEMPLATE = `
<div class="en-off" data-ref="off">
  <span data-ref="offText">Recording is paused while Recognize mode is on.</span>
  <button data-testid="enroll-back" data-ref="back">Record more</button>
</div>
<div class="en-main" data-ref="main">
  <div class="en-left">
    <div class="en-banner" data-testid="enroll-banner" data-ref="banner" hidden>
      <b data-ref="bannerHead"></b>
      <span data-ref="bannerSub"></span>
    </div>
    <div class="en-alert" data-testid="enroll-alert" data-ref="alert" role="alert" hidden></div>
    <div class="en-stage" data-testid="enroll-stage" data-ref="stage">
      <div class="en-top">
        <span class="en-kicker" data-ref="kicker"></span>
        <span class="en-rec">Recording… let go when you finish</span>
      </div>
      <div class="en-prompt" data-testid="enroll-prompt" data-ref="prompt" aria-live="polite">Loading your recordings…</div>
      <div class="en-hint" data-ref="hint"></div>
      <div class="en-msg" data-testid="enroll-msg" data-ref="msg" role="status"></div>
      <div class="en-actions">
        <button data-testid="enroll-redo" data-ref="redo" title="Delete the last recording and say it again">↶ Redo last</button>
        <button data-testid="enroll-skip" data-ref="skip" title="Come back to this sentence later">Skip →</button>
        <button data-testid="enroll-export-done" data-ref="exportDone" hidden>Export JSON</button>
        <button class="primary" data-testid="enroll-next-session" data-ref="next" hidden>Start the next session</button>
      </div>
      <div class="en-signal" data-testid="enroll-signal" data-ref="signal"></div>
    </div>
    <div class="en-progress" data-testid="enroll-progress" data-ref="progress">
      <div class="en-total"><b data-ref="total"></b> <span class="muted" data-ref="totalNote"></span></div>
      <div class="en-bar"><i data-ref="totalBar"></i></div>
      <ul class="en-classes" data-ref="classes"></ul>
    </div>
  </div>
  <div class="en-right">
    <div class="en-acc" data-testid="enroll-accuracy" data-ref="acc" data-state="waiting">
      <div class="en-acc-h">How well it knows your sentences</div>
      <div class="en-acc-num" data-ref="accNum">–</div>
      <div class="en-acc-sub" data-ref="accSub"></div>
      <div class="en-acc-loso" data-ref="accLoso"></div>
      <div class="en-cm-wrap"><table class="en-cm" data-ref="cm"></table></div>
      <div class="en-cm-cap" data-ref="cmCap" hidden>Rows: what you said. Columns: what it guessed.</div>
    </div>
    <button class="primary en-train" data-testid="enroll-train" data-ref="train">Train &amp; use it</button>
    <div class="en-note" data-testid="enroll-note" data-ref="note" role="status"></div>
    <div class="en-files">
      <button data-testid="enroll-export" data-ref="export">Export JSON</button>
      <label class="btn" data-testid="enroll-import">Import JSON
        <input type="file" accept=".json,application/json" multiple hidden data-testid="enroll-import-file" data-ref="file">
      </label>
    </div>
    <div class="en-saved muted" data-testid="enroll-saved" data-ref="saved"></div>
    <details class="en-settings" data-testid="enroll-settings">
      <summary>Settings</summary>
      <label>Session name <input data-testid="enroll-session" data-ref="session" maxlength="24" autocomplete="off"></label>
      <button data-testid="enroll-new-session" data-ref="newSession">Start a new session</button>
      <label>Recordings per sentence <input type="number" min="1" max="100" data-testid="enroll-reps" data-ref="reps"></label>
      <label>Your name <input data-testid="enroll-subject" data-ref="subject" maxlength="40" autocomplete="off"></label>
      <fieldset><legend>Sentences to record</legend><div data-ref="pick"></div></fieldset>
      <button class="danger" data-testid="enroll-clear" data-ref="clear">Clear this session…</button>
      <div class="en-confirm" data-ref="confirm" hidden>
        <span data-ref="confirmText"></span>
        <button class="danger" data-testid="enroll-clear-yes" data-ref="clearYes">Yes, delete them</button>
        <button data-testid="enroll-clear-no" data-ref="clearNo">Keep them</button>
      </div>
    </details>
  </div>
</div>`;

class EnrollPanel {
  private s = loadSettings();
  private prompter = new Prompter();
  private promptSession = '';
  private promptKey = ''; // session | sentence | takes so far: changes whenever a new sentence shows
  private promptShownAt = 0;
  private prompt: string | null = null; // class id shown right now (null = loading, done, or paused)
  private restored = false;
  private loadStart = performance.now();
  private status: StatusMsg | null = null; // latest status from the current source
  private conn = 'connecting';
  private lastMotion = -Infinity;
  // push to talk bookkeeping
  private presses = new Map<number, Press>(); // by press sample time, until their clip arrives
  private open: Press | null = null; // Space is down
  private inflight = new Set<Press>(); // let go, clip not saved or dropped yet
  private lastReleased: Press | null = null;
  private recorded: string[] = []; // ids saved since the page loaded, newest last (for Redo last)
  private askedPersist = false;
  private lastTrain = '';
  // live accuracy
  private evaluator = new Evaluator();
  private evalTimer: ReturnType<typeof setTimeout> | null = null;
  private evalBusy = false;
  private evalAgain = false;
  private evalKey = '';
  private mlMissing = false;
  private lastResult: EvalResult | null = null;
  private r: Record<string, HTMLElement> = {};

  constructor(private el: HTMLElement, private app: App) {
    el.classList.add('en');
    el.innerHTML = TEMPLATE;
    for (const n of el.querySelectorAll<HTMLElement>('[data-ref]')) this.r[n.dataset.ref!] = n;
    this.buildPicker();
    this.wire();
    // No recording until saved clips are back: counts, prompts and reps depend on them.
    void app.store.ready.then(() => { this.restored = true; this.render(); this.scheduleEval(); });
    setTimeout(() => this.render(), SLOW_LOAD_MS);
    this.render();
    setInterval(() => this.renderSignal(), 500);
  }

  // ---------- state ----------
  private get active() { return this.app.mode === 'enroll'; }
  private get kind(): RecKind | null { return recKind(this.app.source?.kind, this.conn, this.status); }
  private get practice() { return this.kind === 'practice'; }
  /** The session new takes go to: practice (fake-N) with fake data, real (sN) otherwise. */
  private get session() { return this.practice ? this.s.practice : this.s.session; }
  private get source(): ClipMeta['source'] { return this.practice ? 'fake' : 'airpods'; }
  private get busy() { return !!this.open || this.inflight.size > 0; }
  private get promptReady() { return performance.now() - this.promptShownAt >= PROMPT_READY_MS; }
  private chosen(): string[] {
    const all = this.app.classes.map((c) => c.id);
    const pick = this.s.classes ? all.filter((id) => this.s.classes!.includes(id)) : all;
    return pick.length ? pick : all;
  }
  private sessionClips(session = this.session): DatasetClip[] { return this.app.store.all().filter((c) => c.session === session); }
  private sourceOf(c: DatasetClip): ClipMeta['source'] { return this.app.store.meta(c.id)?.source ?? 'fake'; }
  /** Clips of the chosen sentences with the same source as now (real and practice never mix). */
  private pool(): DatasetClip[] {
    const chosen = this.chosen();
    return this.app.store.all().filter((c) => chosen.includes(c.label) && this.sourceOf(c) === this.source);
  }
  private sentence(id: string) { return this.app.classes.find((c) => c.id === id)?.sentence ?? id; }
  private label(id: string) { return id === NONE ? 'Mouth closed (say nothing)' : this.sentence(id); }

  private save() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.s)); } catch { /* storage blocked: settings just won't stick */ }
  }

  // ---------- events ----------
  private wire() {
    const { app, r } = this;
    app.store.onChange(() => { this.render(); this.scheduleEval(); });
    app.bus.on('mode', (m) => {
      this.syncFake(true);
      if (m === 'enroll') { this.lastTrain = ''; this.note('info', ''); }
      this.render();
    });
    app.bus.on('source', () => { this.status = null; this.render(); this.scheduleEval(); });
    app.bus.on('status', (st) => {
      const before = this.kind;
      this.status = st;
      if (this.kind !== before) { this.render(); this.scheduleEval(); }
    });
    app.bus.on('conn', (c) => { this.conn = c.state; this.render(); });
    app.bus.on('motion', () => { this.lastMotion = performance.now(); });
    app.bus.on('ptt', ({ down, t }) => this.onPtt(down, t));
    app.bus.on('clip', (c) => this.onClip(c));

    const click = (el: HTMLElement, fn: () => void) => el.addEventListener('click', () => {
      (el as HTMLButtonElement).blur(); // so a later Space press is push to talk, not another click
      fn();
    });
    click(r.redo, () => this.redo());
    click(r.skip, () => this.skip());
    click(r.next, () => this.newSession());
    click(r.newSession, () => this.newSession());
    click(r.export, () => this.exportSession());
    click(r.exportDone, () => this.exportSession());
    click(r.train, () => this.train());
    click(r.back, () => app.setMode('enroll'));
    click(r.clear, () => this.askClear());
    click(r.clearNo, () => { r.confirm.hidden = true; });
    click(r.clearYes, () => this.clearSession());

    const file = r.file as HTMLInputElement;
    file.addEventListener('change', () => {
      const files = [...(file.files ?? [])];
      file.value = ''; // so picking the same file again still fires change
      if (files.length) void this.importFiles(files);
    });

    // Focus left on these would swallow the next Space press (toggle instead of record).
    const summary = this.el.querySelector('summary');
    summary?.addEventListener('click', () => setTimeout(() => summary.blur(), 0));
    const done = (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') (e.target as HTMLInputElement).blur(); };
    const session = r.session as HTMLInputElement;
    session.addEventListener('keydown', done);
    session.addEventListener('change', () => this.renameSession(session.value));
    const reps = r.reps as HTMLInputElement;
    reps.addEventListener('keydown', done);
    reps.addEventListener('change', () => {
      const n = Math.round(Number(reps.value));
      if (Number.isFinite(n) && n >= 1) { this.s.reps = Math.min(100, n); this.save(); }
      reps.value = String(this.s.reps);
      reps.blur(); // spinner clicks keep focus here, and Space would type instead of record
      this.render();
    });
    const subject = r.subject as HTMLInputElement;
    subject.addEventListener('keydown', done);
    subject.addEventListener('change', () => {
      const v = subject.value.trim().slice(0, 40);
      if (v) { this.s.subject = v; this.save(); }
      subject.value = this.s.subject;
    });
  }

  /** Why a press right now can't be saved, or null. */
  private pressBlock(): string | null {
    if (!this.restored) return NOT_READY_MSG;
    if (this.app.source?.kind === 'replay') return "You're watching a replay. Recording needs AirPods.";
    if (!this.kind) return NO_SIGNAL;
    if (!this.prompt) {
      return this.promptState() === 'done' ? `Session ${this.session} is done. Start the next session to record more.` : NOT_READY_MSG;
    }
    if (!this.promptReady) return WAIT_MSG; // only glimpsed: the person may still be saying the last one
    return null;
  }

  private onPtt(down: boolean, t: number) {
    if (down) {
      if (!this.active) return; // Recognize mode: not training data
      const now = performance.now();
      const p: Press = {
        t, wallDown: now, wallUp: null, motionAgeAtUp: 0, label: this.prompt, session: this.session, kind: this.kind,
        loc: this.status?.loc ?? 'unknown', block: this.pressBlock(), slipped: false, timer: null,
      };
      const prev = this.lastReleased;
      if (prev?.wallUp != null && now - prev.wallUp < SLIP_MS) { prev.slipped = true; p.slipped = true; }
      const clash = this.presses.get(t);
      if (clash) { clash.block ??= NO_SIGNAL; p.block ??= NO_SIGNAL; } // sample clock didn't move: dead stream
      this.presses.set(t, p);
      this.open = p;
      // In fake mode the fake source "says" app.fakeLabel; it reads it right after this (it subscribes later).
      if (this.app.source?.kind === 'fake') this.app.fakeLabel = p.label;
      this.r.stage.dataset.rec = '1';
      this.render();
      return;
    }
    delete this.r.stage.dataset.rec;
    const p = this.open;
    this.open = null;
    if (!p) return;
    p.wallUp = performance.now();
    p.motionAgeAtUp = p.wallUp - this.lastMotion;
    this.lastReleased = p;
    this.inflight.add(p);
    p.timer = setTimeout(() => this.noClip(p), NO_CLIP_MS);
    this.render();
  }

  /** The shell never cut a clip for this press (no data, or too short to cut). */
  private noClip(p: Press) {
    p.timer = null;
    this.inflight.delete(p);
    if (this.presses.get(p.t) === p) this.presses.delete(p.t);
    if (this.active) {
      const flowing = p.motionAgeAtUp < STALE_AT_RELEASE_MS;
      this.say('bad', p.slipped ? SLIP_MSG : `Not saved. ${p.block ?? (flowing
        ? 'Too short: keep holding Space the whole time you mouth the sentence.'
        : NO_SIGNAL)}`);
    }
    this.render();
  }

  private onClip(c: ClipEvent) {
    const p = this.presses.get(c.pressT);
    if (!p) { // pressed in Recognize mode, or before any data arrived
      if (this.active) this.say('bad', `Not saved. ${WAIT_MSG}`);
      return;
    }
    this.presses.delete(c.pressT);
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    // Hold it until SLIP_MS after release: a quick re-press means the finger slipped.
    const wait = (p.wallUp ?? performance.now()) + SLIP_MS - performance.now();
    setTimeout(() => this.commit(p, c), Math.max(0, wait));
  }

  private commit(p: Press, c: ClipEvent) {
    this.inflight.delete(p);
    try {
      this.decide(p, c);
    } finally {
      this.render();
    }
  }

  private decide(p: Press, c: ClipEvent) {
    const { store } = this.app;
    // A take started in Record mode is kept even if Recognize was switched on while it landed
    // (presses in Recognize mode never get a Press record).
    if (p.slipped) { this.say('bad', SLIP_MSG); return; }
    if (p.block) { this.say('bad', `Not saved. ${p.block}`); return; }
    if (!p.label || !p.kind) { this.say('bad', `Not saved. ${NOT_READY_MSG}`); return; }
    const bad = takeReject({ wallHoldSec: ((p.wallUp ?? p.wallDown) - p.wallDown) / 1000, msSinceMotionAtRelease: p.motionAgeAtUp }, c);
    if (bad) { this.say('bad', `Not saved. ${bad.message}`); return; }
    if (this.status && this.status.headphones !== 'connected') { this.say('bad', `Not saved. ${NO_SIGNAL}`); return; }
    const kindNow = this.kind;
    if (!kindNow) { this.say('bad', `Not saved. ${NO_SIGNAL}`); return; }
    if (kindNow !== p.kind) { this.say('bad', KIND_CHANGED); return; } // e.g. Simulate switched on mid take
    const source: ClipMeta['source'] = p.kind === 'real' ? 'airpods' : 'fake';
    const sameSession = store.all().filter((x) => x.session === p.session);
    if (sameSession.some((x) => this.sourceOf(x) !== source)) {
      this.say('bad', `Not saved: session ${p.session} has ${source === 'airpods' ? 'fake' : 'real AirPods'} data in it. Start a new session.`);
      return;
    }
    const same = sameSession.filter((x) => x.label === p.label);
    const clip: DatasetClip = {
      id: newId(p.session),
      label: p.label,
      rep: same.reduce((m, x) => Math.max(m, x.rep), -1) + 1,
      session: p.session,
      startedAt: new Date(Date.now() - (performance.now() - p.wallDown)).toISOString(),
      pressT: c.pressT,
      releaseT: c.releaseT,
      padSec: c.padSec,
      quality: { gapPct: c.gapPct, nSamples: c.samples.length },
      samples: c.samples,
    };
    const meta: ClipMeta = {
      source, subject: this.s.subject, device: { model: DEVICE_MODEL, loc: p.loc },
      hz: clipHz(c.samples, Math.round(this.status?.hz || 25)),
      origin: 'recorded',
    };
    if (p.session === this.session) this.prompter.done(p.label);
    this.recorded.push(clip.id);
    store.add(clip, meta); // re-renders with the next prompt
    const health = store.health();
    const what = `“${this.label(p.label)}” (${same.length + 1} of ${this.s.reps})`;
    if (health.error) this.say('bad', SAVE_FAILED);
    else if (health.kind === 'memory') this.say('ok', `✓ Recorded ${what}. Not autosaved: export before you close the page.`);
    else this.say('ok', `✓ Saved ${what}.`);
    this.askPersist();
    void store.flush().then(() => { if (store.health().error) { this.say('bad', SAVE_FAILED); this.render(); } });
  }

  /** Leaving Record mode: hand the fake sentence back to the header's "random sentence" picker. */
  private syncFake(modeChanged = false) {
    if (this.app.source?.kind !== 'fake' || this.active || !modeChanged) return;
    const sel = document.querySelector<HTMLSelectElement>('[data-testid=fake-label]');
    this.app.fakeLabel = sel?.value || null;
  }

  /** Ask the browser not to evict our IndexedDB data when the disk gets full. Best effort. */
  private askPersist() {
    if (this.askedPersist) return;
    this.askedPersist = true;
    navigator.storage?.persist?.().catch(() => { /* not supported: fine */ });
  }

  // ---------- buttons ----------
  private redo() {
    if (this.busy) return; // a take is still landing: Redo would hit the one before it
    const mine = this.sessionClips();
    if (!mine.length) return;
    // The last one recorded on this page; after a reload, the newest in this session.
    let last: DatasetClip | undefined;
    while (!last && this.recorded.length) {
      const id = this.recorded.pop();
      last = mine.find((c) => c.id === id);
    }
    last ??= mine.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a));
    this.app.store.remove(last.id);
    this.prompter.pushFront(last.label);
    this.render();
    this.say('info', `Deleted the last recording (“${this.label(last.label)}”). Say it again.`);
  }

  private skip() {
    if (!this.prompt || this.busy) return;
    this.prompter.done(this.prompt);
    this.render();
    this.say('info', 'Skipped. That sentence will come back later.');
  }

  private renameSession(raw: string) {
    const input = this.r.session as HTMLInputElement;
    let name = cleanSessionName(raw);
    if (name && this.practice && !name.startsWith(PRACTICE_PREFIX)) name = PRACTICE_PREFIX + name;
    if (name && !this.practice && name.startsWith(PRACTICE_PREFIX)) {
      this.note('bad', `Names starting with ${PRACTICE_PREFIX} are for practice with fake data.`);
      name = '';
    }
    if (name && name !== this.session) this.setSession(name);
    else input.value = this.session;
  }

  private setSession(name: string) {
    if (this.practice) this.s.practice = name; else this.s.session = name;
    this.save();
    this.r.confirm.hidden = true;
    this.render();
    this.scheduleEval();
    this.say('info', `Now recording ${this.practice ? 'practice ' : ''}session ${name}.`);
  }

  private newSession() {
    if (this.busy) return;
    const names = new Set(this.app.store.all().map((c) => c.session ?? ''));
    names.add(this.session);
    this.setSession(nextSessionName(names, this.practice ? PRACTICE_PREFIX : REAL_PREFIX));
  }

  private askClear() {
    const n = this.sessionClips().length;
    if (!n || this.busy) return;
    this.r.confirmText.textContent = `Delete all ${recs(n)} in session ${this.session}? This can't be undone.`;
    this.r.confirm.hidden = false;
  }

  private clearSession() {
    this.r.confirm.hidden = true;
    if (this.busy) return;
    const ids = this.sessionClips().map((c) => c.id);
    this.prompter.reset();
    this.app.store.removeMany(ids);
    this.render();
    this.say('info', `Deleted ${recs(ids.length)} from session ${this.session}.`);
  }

  private exportSession() {
    const session = this.session;
    const mine = this.sessionClips(session);
    const meta = this.app.store.sessionMeta(session);
    if (!mine.length || !meta) { this.note('bad', 'Nothing recorded in this session yet.'); return; }
    // source / subject / device / hz were saved with each clip when it was recorded or imported.
    const ds = this.app.store.toDataset({ session, classes: this.app.classes, ...meta }, (c) => c.session === session);
    const errs = validateDataset(ds);
    if (errs.length) { this.note('bad', `Export failed: ${errs.slice(0, 2).join('; ')}`); return; }
    const name = exportFileName(session);
    const url = URL.createObjectURL(new Blob([JSON.stringify(ds)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    this.note('ok', `Saved ${name} (${recs(ds.clips.length)}) to your Downloads folder.`);
  }

  private async importFiles(files: File[]) {
    const known = new Set(this.app.classes.map((c) => c.id));
    const problems: string[] = [];
    const renamed: string[] = [];
    let added = 0, dupes = 0, unknown = 0;
    for (const f of files) {
      let data: unknown;
      try { data = JSON.parse(await f.text()); } catch { problems.push(`${f.name} is not a JSON file.`); continue; }
      const errs = validateDataset(data);
      if (errs.length) {
        problems.push(`${f.name} is not a Silent Speech recording file (${errs.slice(0, 2).join('; ')}${errs.length > 2 ? '; …' : ''}).`);
        continue;
      }
      const ds = data as Dataset;
      const local = new Map<string, Set<string>>();
      for (const c of this.app.store.all()) {
        const s = c.session ?? '';
        if (!local.has(s)) local.set(s, new Set());
        local.get(s)!.add(c.id);
      }
      const plan = planImport(ds, local, this.s.subject, known);
      unknown += plan.unknown;
      const n = this.app.store.load({ ...ds, clips: plan.clips });
      added += n;
      dupes += plan.clips.length - n;
      for (const [from, to] of plan.renames) renamed.push(`${from} → ${to}`);
    }
    const parts: string[] = [];
    if (added || dupes || !problems.length) parts.push(`Imported ${recs(added)}.`);
    if (dupes) parts.push(`${dupes} ${dupes === 1 ? 'was' : 'were'} already here.`);
    if (renamed.length) parts.push(`Renamed session ${renamed.join(', ')} so it doesn't mix with your own recordings.`);
    if (unknown) parts.push(`${unknown} skipped (sentences this page doesn't know).`);
    parts.push(...problems);
    this.note(problems.length ? 'bad' : 'ok', parts.join(' '));
  }

  private train() {
    if (this.busy) return; // a take is still landing: train once it's in
    const clips = this.pool();
    try {
      const model = ml.train(clips);
      this.lastTrain = `Trained on ${recs(clips.length)}${this.practice ? ' of practice data' : ''}. Recognize mode is on: hold Space and mouth any sentence.`;
      this.app.setModel(model);
      this.app.setMode('classify');
      this.note('ok', this.lastTrain);
    } catch (e) {
      const msg = errMsg(e);
      if (isNotImplemented(msg)) {
        this.mlMissing = true;
        this.note('bad', 'Model not ready yet: the recognizer is still being built. Your recordings are saved.');
        this.showAcc({ state: 'not-ready' });
      } else {
        this.note('bad', `Training failed: ${msg}`);
      }
    }
  }

  // ---------- messages ----------
  private say(kind: Kind, text: string) { this.setMsg(this.r.msg, kind, text); }
  private note(kind: Kind, text: string) { this.setMsg(this.r.note, kind, text); }
  private setMsg(el: HTMLElement, kind: Kind, text: string) {
    el.textContent = text;
    el.dataset.kind = kind;
  }

  // ---------- rendering ----------
  private promptState(): 'loading' | 'paused' | 'replay' | 'connecting' | 'done' | 'prompt' {
    const src = this.app.source?.kind;
    if (!this.restored) return 'loading';
    if (!this.active) return 'paused';
    if (src === 'replay') return 'replay';
    if (!src) return 'connecting';
    return this.prompt ? 'prompt' : 'done';
  }

  private render() {
    const { r, s, app } = this;
    const active = this.active;
    r.off.hidden = active;
    r.main.hidden = !active;
    r.offText.textContent = this.lastTrain && app.model ? this.lastTrain : 'Recording is paused while Recognize mode is on.';

    const session = this.session;
    if (this.promptSession !== session) { this.prompter.reset(); this.promptSession = session; }
    const all = app.store.all();
    const mine = all.filter((c) => c.session === session);
    const count = new Map<string, number>();
    for (const c of mine) count.set(c.label, (count.get(c.label) ?? 0) + 1);
    const chosen = this.chosen();
    const needed = chosen.filter((id) => (count.get(id) ?? 0) < s.reps);
    const src = app.source?.kind;
    this.prompt = this.restored && active && !!src && src !== 'replay' ? this.prompter.current(needed) : null;
    const state = this.promptState();
    const p = this.prompt;

    // banner: real data only with live AirPods
    const kind = this.kind;
    const practice = kind === 'practice';
    r.banner.hidden = !active || !this.restored || src === 'replay' || !src || kind === 'real';
    r.banner.dataset.kind = practice ? 'practice' : 'off';
    r.bannerHead.textContent = practice && src === 'live' ? SIMULATE_BANNER : src === 'fake' ? FAKE_BANNER : OFF_BANNER;
    r.bannerSub.textContent = practice
      ? `${PRACTICE_NOTE} Practice session: ${session}.`
      : this.offReason();

    // alert: saving is broken
    const health = app.store.health();
    const alert = health.error ? SAVE_FAILED : health.fallback ? STORAGE_STUCK : health.kind === 'memory' && mine.length ? NO_AUTOSAVE : '';
    r.alert.textContent = alert;
    r.alert.hidden = !alert || !active;

    // prompt
    r.next.hidden = true;
    r.exportDone.hidden = !(health.error || health.kind === 'memory') || !mine.length;
    if (state === 'loading') {
      r.kicker.textContent = '';
      r.prompt.textContent = 'Loading your recordings…';
      r.hint.textContent = performance.now() - this.loadStart > SLOW_LOAD_MS ? 'Still loading. If this stays, reload the page.' : '';
    } else if (state === 'paused') {
      r.kicker.textContent = '';
      r.prompt.textContent = 'Recording is paused';
      r.hint.textContent = '';
    } else if (state === 'replay') {
      r.kicker.textContent = 'Watching a replay';
      r.prompt.textContent = 'Recording needs AirPods';
      r.hint.textContent = 'Open this page while the Silent Speech Mac app is running (or add ?mode=fake to practice with fake data).';
    } else if (state === 'connecting') {
      r.kicker.textContent = '';
      r.prompt.textContent = 'Connecting…';
      r.hint.textContent = '';
    } else if (state === 'done') {
      const next = nextSessionName(new Set([...all.map((c) => c.session ?? ''), session]), practice ? PRACTICE_PREFIX : REAL_PREFIX);
      r.kicker.textContent = `${practice ? 'Practice session' : 'Session'} ${session}`;
      r.prompt.textContent = `Session ${session} is done!`;
      r.hint.textContent = practice
        ? 'This was practice with fake data. Start another practice session, or connect the AirPods to record for real.'
        : 'Export it, then take the AirPods out, put them back in, and start the next session.';
      r.next.textContent = `Start session ${next}`;
      r.next.hidden = false;
      r.exportDone.hidden = false;
    } else {
      const n = (count.get(p!) ?? 0) + 1;
      const pre = practice ? 'Practice · ' : '';
      r.kicker.textContent = p === NONE ? `${pre}No sentence this time · ${n} of ${s.reps}` : `${pre}Mouth this, no sound · ${n} of ${s.reps}`;
      r.prompt.textContent = promptText(p!, this.sentence(p!));
      r.hint.innerHTML = p === NONE
        ? 'Hold <kbd>Space</kbd> for about 2 seconds without mouthing anything.'
        : 'Hold <kbd>Space</kbd> (or the bar at the top), mouth it with no sound, then let go.';
    }
    const key = `${session}|${p}|${mine.length}`;
    if (key !== this.promptKey) { // a new sentence: it counts once it has been on screen for a moment
      this.promptKey = key;
      this.promptShownAt = performance.now();
      if (p) setTimeout(() => { if (this.promptKey === key) this.render(); }, PROMPT_READY_MS + 10);
    }
    r.prompt.dataset.state = state;
    r.prompt.dataset.ready = p && this.promptReady ? '1' : '0';
    r.prompt.dataset.label = p ?? '';
    r.prompt.dataset.session = session;
    r.stage.dataset.state = state;
    r.stage.dataset.kind = kind ?? 'off';
    const busy = this.busy;
    (r.redo as HTMLButtonElement).disabled = !mine.length || busy;
    (r.skip as HTMLButtonElement).disabled = !p || busy;
    (r.next as HTMLButtonElement).disabled = busy;
    (r.newSession as HTMLButtonElement).disabled = busy;
    r.skip.hidden = state === 'done';

    // progress (this session, chosen sentences)
    const done = chosen.reduce((t, id) => t + (count.get(id) ?? 0), 0);
    const target = chosen.length * s.reps;
    r.total.textContent = `${done} of ${target} recorded`;
    r.totalNote.textContent = `· ${practice ? 'practice ' : ''}session ${session}`;
    r.totalBar.style.width = `${Math.min(100, (100 * done) / Math.max(1, target))}%`;
    r.progress.dataset.total = String(done);
    r.progress.dataset.target = String(target);
    r.classes.innerHTML = chosen.map((id) => {
      const n = count.get(id) ?? 0;
      const w = Math.min(100, (100 * n) / s.reps);
      return `<li data-class="${esc(id)}" class="${id === p ? 'now' : ''} ${n >= s.reps ? 'full' : ''}">
        <span class="en-name" title="${esc(this.sentence(id))}">${esc(this.label(id))}</span>
        <span class="en-bar sm"><i style="width:${w}%"></i></span>
        <b class="en-count">${n}/${s.reps}</b></li>`;
    }).join('');

    // files + saved summary
    (r.export as HTMLButtonElement).disabled = !mine.length;
    (r.clear as HTMLButtonElement).disabled = !mine.length || busy;
    (r.clearYes as HTMLButtonElement).disabled = busy;
    const bySession = new Map<string, number>();
    for (const c of all) bySession.set(c.session ?? '?', (bySession.get(c.session ?? '?') ?? 0) + 1);
    const where = health.kind === 'indexeddb' ? 'Autosaved in this browser' : 'Autosave is off in this browser: export before you close the page';
    const list = [...bySession].map(([k, n]) => `${k} (${n}${app.store.sessionMeta(k)?.source === 'fake' ? ', fake' : ''})`).join(', ');
    r.saved.textContent = `${where}${list ? `: ${list}` : '.'}`;
    r.saved.dataset.kind = health.kind === 'indexeddb' && !health.error ? 'ok' : 'bad';
    if (health.error) r.saved.textContent += `. Some recordings were NOT saved (${health.error}).`;

    // train
    const trainable = evalSet(this.pool(), chosen);
    const train = r.train as HTMLButtonElement;
    train.disabled = !trainable || busy;
    train.title = trainable ? 'Train the recognizer on these recordings and switch to Recognize mode'
      : `Record at least ${MIN_PER_CLASS} of ${MIN_CLASSES} different sentences first`;

    // settings inputs (don't fight the person while they type)
    const setVal = (el: HTMLElement, v: string) => { if (document.activeElement !== el) (el as HTMLInputElement).value = v; };
    setVal(r.session, session);
    setVal(r.reps, String(s.reps));
    setVal(r.subject, s.subject);
    for (const box of r.pick.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) box.checked = chosen.includes(box.value);

    this.renderSignal();
  }

  private buildPicker() {
    this.r.pick.innerHTML = this.app.classes.map((c) => `<label class="en-pick">
      <input type="checkbox" value="${esc(c.id)}" data-testid="enroll-class-${esc(c.id)}"> ${esc(this.label(c.id))}</label>`).join('');
    this.r.pick.addEventListener('change', (e) => {
      const box = e.target as HTMLInputElement;
      box.blur(); // so the next Space press records instead of toggling the box
      const picked = [...this.r.pick.querySelectorAll<HTMLInputElement>('input:checked')].map((b) => b.value);
      if (!picked.length) { box.checked = true; this.note('info', 'Keep at least one sentence.'); return; }
      this.s.classes = picked.length === this.app.classes.length ? null : picked;
      this.save();
      this.render();
      this.scheduleEval();
    });
  }

  /** Why real recording is off (live source only). */
  private offReason(): string {
    if (this.app.source?.kind !== 'live') return 'Open this page with the Silent Speech Mac app running and the AirPods in.';
    const st = this.status;
    if (this.conn !== 'open') return "Can't reach the Silent Speech app on the Mac. Is it open?";
    if (!st) return 'Waiting for the Mac app…';
    if (st.headphones !== 'connected') return "The AirPods aren't connected. Put them in your ears.";
    if (st.auth !== 'authorized') return 'The Mac app needs permission to read head motion.';
    return '';
  }

  private renderSignal() {
    const kind = this.app.source?.kind;
    let ok = true;
    let text = '';
    const stale = performance.now() - this.lastMotion > SIGNAL_STALE_MS;
    if (!this.active || kind === 'replay' || !kind) {
      text = '';
    } else if (kind === 'live' && !this.kind) {
      ok = false; text = this.offReason() || NO_SIGNAL;
    } else if (stale) {
      ok = false; text = NO_SIGNAL;
    } else {
      text = this.practice ? 'Fake data (practice)' : 'AirPods signal OK';
    }
    const el = this.r.signal;
    if (el.textContent !== text) el.textContent = text;
    el.dataset.ok = ok ? '1' : '0';
  }

  // ---------- live accuracy ----------
  private scheduleEval() {
    if (this.evalTimer) clearTimeout(this.evalTimer);
    this.evalTimer = setTimeout(() => { this.evalTimer = null; void this.runEval(); }, EVAL_DEBOUNCE_MS);
  }

  /** Leave one out on this session; leave one session out across sessions of the same source. */
  private evalPlan() {
    const chosen = this.chosen();
    const pool = this.pool();
    const loo = evalSet(pool.filter((c) => c.session === this.session), chosen)?.clips ?? null;
    const every = evalSet(pool, chosen);
    const loso = every && every.sessions.length >= 2 ? every.clips : null;
    return { loo, loso };
  }

  private async runEval() {
    if (!this.restored) return;
    if (this.evalBusy) { this.evalAgain = true; return; }
    if (this.mlMissing) { this.showAcc({ state: 'not-ready' }); return; }
    const { loo, loso } = this.evalPlan();
    if (!loo && !loso) { this.lastResult = null; this.evalKey = ''; this.showAcc({ state: 'waiting' }); return; }
    const key = `${loo?.map((c) => c.id).join('|')}#${loso?.map((c) => c.id).join('|')}`;
    if (key === this.evalKey && this.lastResult) { this.showAcc({ state: 'ready', res: this.lastResult }); return; }
    this.evalBusy = true;
    this.showAcc({ state: 'running' });
    try {
      const res = await this.evaluator.run(loo, loso);
      this.evalKey = key;
      this.lastResult = res;
      this.showAcc({ state: 'ready', res });
    } catch (e) {
      const msg = errMsg(e);
      if (isNotImplemented(msg)) { this.mlMissing = true; this.showAcc({ state: 'not-ready' }); }
      else if (msg === 'timed out') { this.showAcc({ state: 'error', msg: 'it took too long. It will try again after the next recording' }); }
      else { console.error('[enroll] accuracy failed', e); this.showAcc({ state: 'error', msg }); }
    } finally {
      this.evalBusy = false;
      if (this.evalAgain) { this.evalAgain = false; void this.runEval(); }
    }
  }

  private showAcc(v: AccView) {
    const { r } = this;
    r.acc.dataset.state = v.state;
    const res = v.state === 'ready' ? v.res : v.state === 'running' ? this.lastResult : null;
    delete r.acc.dataset.acc; delete r.acc.dataset.n; delete r.acc.dataset.loso;
    r.accLoso.textContent = '';
    if (v.state === 'not-ready') {
      r.accNum.textContent = '–';
      r.accSub.textContent = 'Model not ready yet. The recognizer is still being built; your recordings are saved.';
    } else if (v.state === 'error') {
      r.accNum.textContent = '–';
      r.accSub.textContent = `Couldn't check accuracy: ${v.msg}.`;
    } else if (v.state === 'waiting') {
      r.accNum.textContent = '–';
      r.accSub.textContent = `Shows up once ${MIN_CLASSES} sentences have ${MIN_PER_CLASS} recordings each in this session.`;
    } else if (!res) {
      r.accNum.textContent = '…';
      r.accSub.textContent = 'Checking…';
    }
    r.cmCap.hidden = !res;
    if (!res) { r.cm.innerHTML = ''; return; }
    const { loo, loso, skipped } = res;
    const updating = v.state === 'running' ? ' (updating…)' : '';
    if (loo) {
      r.acc.dataset.acc = String(loo.accuracy);
      r.acc.dataset.n = String(loo.nClips);
      r.accNum.textContent = pct(loo.accuracy);
      const right = Math.round(loo.accuracy * loo.nClips);
      const verdict = loo.accuracy >= 0.9 ? 'Great.' : loo.accuracy >= 0.7 ? 'Getting there: more recordings will help.' : 'Keep recording: it needs more examples.';
      r.accSub.textContent = `${right} of ${loo.nClips} guessed right in this session, testing each recording against the others. ${verdict}${updating}`;
    } else {
      r.accNum.textContent = '–';
      r.accSub.textContent = skipped.includes('loo')
        ? 'Too many recordings to check in this browser.'
        : `Shows up once ${MIN_CLASSES} sentences have ${MIN_PER_CLASS} recordings each in this session.${updating}`;
    }
    if (loso) {
      r.accLoso.textContent = `Across sessions: ${pct(loso.accuracy)} (each session tested on the others).`;
      r.acc.dataset.loso = String(loso.accuracy);
    } else if (skipped.includes('loso')) {
      r.accLoso.textContent = 'Across sessions: too many recordings to check in this browser.';
    }
    const m = loo ?? loso;
    r.cmCap.hidden = !m;
    r.cm.innerHTML = m ? this.matrix(m) : '';
  }

  /** Mini confusion matrix: rows = what you said, columns = what it guessed. */
  private matrix(m: Metrics): string {
    const L = m.labels;
    const head = `<tr><th class="corner" title="rows: what you said · columns: what it guessed"></th>${
      L.map((l) => `<th title="${esc(this.label(l))}">${esc(shortLabel(l))}</th>`).join('')}</tr>`;
    const rows = L.map((l, i) => {
      const row = m.confusion[i] ?? [];
      const tot = row.reduce((a, b) => a + b, 0) || 1;
      return `<tr><th title="${esc(this.label(l))}">${esc(shortLabel(l))}</th>${L.map((g, j) => {
        const n = row[j] ?? 0;
        const a = n ? 0.15 + 0.85 * (n / tot) : 0;
        const bg = n ? (i === j ? `rgba(61,220,151,${a.toFixed(2)})` : `rgba(255,93,108,${a.toFixed(2)})`) : 'transparent';
        return `<td style="background:${bg}" title="said ${esc(l)}, guessed ${esc(g)}: ${n}">${n || ''}</td>`;
      }).join('')}</tr>`;
    }).join('');
    return `<thead>${head}</thead><tbody>${rows}</tbody>`;
  }
}

const panel: Panel = {
  id: 'enroll',
  order: 40,
  title: 'Record your sentences',
  mount(el, app) {
    el.closest('.card')?.classList.add('wide');
    new EnrollPanel(el, app);
  },
};
export default panel;
