// Enroll panel: a guided recording screen for training data (PROTOCOL §3).
// Shows one sentence at a time (shuffled blocks, every sentence once per block), saves each push to
// talk clip with that label, autosaves (store.ts), shows live accuracy and exports ss-dataset files.
import './enroll/enroll.css';
import { newId, type App, type ClipEvent, type Panel } from '../core/app';
import { NONE, type Dataset, type DatasetClip, type Metrics } from '../core/contracts';
import { validateDataset } from '../core/validate';
import * as ml from '../ml/index';
import { Evaluator, type EvalResult } from './enroll/accuracy';
import { isNotImplemented } from './enroll/eval-core';
import {
  Prompter, cleanSessionName, estimateHz, evalSet, exportFileName, nextSessionName, promptText,
  rejectReason, shortLabel, sourceNow, MIN_CLASSES, MIN_PER_CLASS,
} from './enroll/logic';

const SETTINGS_KEY = 'ss.enroll';
const DEFAULT_REPS = 15;
const DEVICE_MODEL = 'AirPods Pro 3';
const EVAL_DEBOUNCE_MS = 600;
const NO_CLIP_MS = 2200; // the shell gives up waiting for the release pad after 1.5 s
const SIGNAL_STALE_MS = 1500;

type Origin = 'airpods' | 'fake';
interface Settings {
  session: string;
  reps: number;
  classes: string[] | null; // null = every class
  subject: string;
  /** Per session: where its clips came from, decided while recording (fake wins once any clip was fake). */
  origin: Record<string, Origin>;
}

function loadSettings(): Settings {
  const d: Settings = { session: 's1', reps: DEFAULT_REPS, classes: null, subject: 'spiro', origin: {} };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null;
    if (!raw || typeof raw !== 'object') return d;
    if (typeof raw.session === 'string' && cleanSessionName(raw.session)) d.session = cleanSessionName(raw.session);
    if (Number.isInteger(raw.reps) && raw.reps! >= 1 && raw.reps! <= 100) d.reps = raw.reps!;
    if (Array.isArray(raw.classes) && raw.classes.every((x) => typeof x === 'string')) d.classes = raw.classes;
    if (typeof raw.subject === 'string' && raw.subject.trim()) d.subject = raw.subject.trim().slice(0, 40);
    if (raw.origin && typeof raw.origin === 'object') {
      for (const [k, v] of Object.entries(raw.origin)) if (v === 'airpods' || v === 'fake') d.origin[k] = v;
    }
  } catch { /* storage blocked or junk: defaults */ }
  return d;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
    <div class="en-stage" data-testid="enroll-stage" data-ref="stage">
      <div class="en-top">
        <span class="en-kicker" data-ref="kicker"></span>
        <span class="en-rec">Recording… let go when you finish</span>
      </div>
      <div class="en-prompt" data-testid="enroll-prompt" data-ref="prompt" aria-live="polite">Loading…</div>
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
  private prompt: string | null = null; // class id shown right now (null = loading, done, or not recording)
  private pressPrompt: string | null = null; // prompt when push to talk went down: that's what was said
  private pressWall = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private restored = false;
  private lastMotion = -Infinity;
  private conn = 'connecting';
  private askedPersist = false;
  private lastTrain = '';
  private recorded: string[] = []; // ids saved since the page loaded, newest last (for Redo last)
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
    const restore = Promise.race([app.store.ready, new Promise((res) => setTimeout(res, 3000))]);
    void restore.then(() => { this.restored = true; this.render(); this.scheduleEval(); });
    this.render();
    setInterval(() => this.renderSignal(), 500);
  }

  // ---------- state ----------
  private get active() { return this.app.mode === 'enroll'; }
  private get canRecord() {
    const k = this.app.source?.kind;
    return this.active && (k === 'live' || k === 'fake');
  }
  private chosen(): string[] {
    const all = this.app.classes.map((c) => c.id);
    const pick = this.s.classes ? all.filter((id) => this.s.classes!.includes(id)) : all;
    return pick.length ? pick : all;
  }
  private sessionClips(): DatasetClip[] { return this.app.store.all().filter((c) => c.session === this.s.session); }
  private sentence(id: string) { return this.app.classes.find((c) => c.id === id)?.sentence ?? id; }
  private label(id: string) { return id === NONE ? 'Stay still (no sentence)' : this.sentence(id); }

  private save() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.s)); } catch { /* storage blocked: settings just won't stick */ }
  }

  private noteOrigin(session: string, o: Origin) {
    if (this.s.origin[session] === o || this.s.origin[session] === 'fake') return;
    this.s.origin[session] = o;
    this.save();
  }

  // ---------- events ----------
  private wire() {
    const { app, r } = this;
    app.store.onChange(() => { this.render(); this.scheduleEval(); });
    app.bus.on('mode', () => { this.syncFake(true); this.render(); });
    app.bus.on('source', () => this.render());
    app.bus.on('conn', (c) => { this.conn = c.state; });
    app.bus.on('motion', () => { this.lastMotion = performance.now(); });
    app.bus.on('ptt', ({ down }) => this.onPtt(down));
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
    session.addEventListener('change', () => {
      const name = cleanSessionName(session.value);
      if (name && name !== this.s.session) this.setSession(name);
      else session.value = this.s.session;
    });
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

  private onPtt(down: boolean) {
    if (down) {
      this.clearWatchdog();
      if (!this.canRecord) return;
      this.pressPrompt = this.prompt;
      this.pressWall = Date.now();
      this.syncFake(); // runs before the fake source reads app.fakeLabel (it subscribes later)
      this.r.stage.dataset.rec = '1';
      return;
    }
    delete this.r.stage.dataset.rec;
    if (!this.canRecord) return;
    this.clearWatchdog();
    this.watchdog = setTimeout(() => this.noClip(), NO_CLIP_MS);
  }

  private clearWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private noClip() {
    this.watchdog = null;
    const flowing = performance.now() - this.lastMotion < SIGNAL_STALE_MS;
    this.say('bad', flowing
      ? 'Too short, nothing was saved. Keep holding Space the whole time you mouth the sentence.'
      : 'Nothing was saved: no motion data is coming in. Check the AirPods are in your ears and the Mac app is open.');
  }

  private onClip(c: ClipEvent) {
    this.clearWatchdog();
    if (!this.canRecord) return; // classify mode, or a replay: not training data
    const label = this.pressPrompt ?? this.prompt;
    this.pressPrompt = null;
    if (!label) {
      if (this.restored) this.say('info', `Session ${this.s.session} is done. Start the next session to record more.`);
      return;
    }
    const bad = rejectReason(c);
    if (bad) { this.say('bad', `Not saved. ${bad.message}`); return; }
    const session = this.s.session;
    const same = this.sessionClips().filter((x) => x.label === label);
    const clip: DatasetClip = {
      id: newId(session),
      label,
      rep: same.reduce((m, x) => Math.max(m, x.rep), -1) + 1,
      session,
      startedAt: new Date(this.pressWall || Date.now()).toISOString(),
      pressT: c.pressT,
      releaseT: c.releaseT,
      padSec: c.padSec,
      quality: { gapPct: c.gapPct, nSamples: c.samples.length },
      samples: c.samples,
    };
    this.noteOrigin(session, sourceNow(this.app.source?.kind, this.app.lastStatus?.simulated));
    this.prompter.done(label);
    this.recorded.push(clip.id);
    this.app.store.add(clip); // re-renders with the next prompt
    this.say('ok', `✓ Saved “${this.label(label)}” (${same.length + 1} of ${this.s.reps}).`);
    this.askPersist();
  }

  /** In fake mode the fake source "says" app.fakeLabel: make it the prompt so fake data matches labels. */
  private syncFake(modeChanged = false) {
    if (this.app.source?.kind !== 'fake') return;
    if (this.active) { this.app.fakeLabel = this.prompt; return; }
    if (modeChanged) { // hand control back to the header's "random sentence" picker
      const sel = document.querySelector<HTMLSelectElement>('[data-testid=fake-label]');
      this.app.fakeLabel = sel?.value || null;
    }
  }

  /** Ask the browser not to evict our IndexedDB data when the disk gets full. Best effort. */
  private askPersist() {
    if (this.askedPersist) return;
    this.askedPersist = true;
    navigator.storage?.persist?.().catch(() => { /* not supported: fine */ });
  }

  // ---------- buttons ----------
  private redo() {
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
    if (!this.prompt) return;
    this.prompter.done(this.prompt);
    this.render();
    this.say('info', 'Skipped. That sentence will come back later.');
  }

  private setSession(name: string) {
    this.s.session = name;
    this.save();
    this.prompter.reset();
    this.r.confirm.hidden = true;
    this.render();
    this.say('info', `Now recording session ${name}.`);
  }

  private newSession() {
    const names = new Set(this.app.store.all().map((c) => c.session ?? ''));
    names.add(this.s.session);
    this.setSession(nextSessionName(names));
  }

  private askClear() {
    const n = this.sessionClips().length;
    if (!n) return;
    this.r.confirmText.textContent = `Delete all ${n} recordings in session ${this.s.session}? This can't be undone.`;
    this.r.confirm.hidden = false;
  }

  private clearSession() {
    this.r.confirm.hidden = true;
    const ids = this.sessionClips().map((c) => c.id);
    delete this.s.origin[this.s.session];
    this.save();
    this.prompter.reset();
    this.app.store.removeMany(ids);
    this.render();
    this.say('info', `Deleted ${ids.length} recordings from session ${this.s.session}.`);
  }

  private exportSession() {
    const mine = this.sessionClips();
    if (!mine.length) { this.note('bad', 'Nothing recorded in this session yet.'); return; }
    const st = this.app.lastStatus;
    const ds = this.app.store.toDataset({
      session: this.s.session,
      subject: this.s.subject,
      // Decided while recording, so exporting later (say with the Mac app closed) can't mislabel real AirPods data.
      source: this.s.origin[this.s.session] ?? sourceNow(this.app.source?.kind, st?.simulated),
      device: { model: DEVICE_MODEL, loc: st?.loc ?? 'unknown' },
      hz: estimateHz(mine, st?.hz ? Math.round(st.hz) : 25),
      classes: this.app.classes,
    }, (c) => c.session === this.s.session);
    const errs = validateDataset(ds);
    if (errs.length) { this.note('bad', `Export failed: ${errs.slice(0, 2).join('; ')}`); return; }
    const name = exportFileName(this.s.session);
    const url = URL.createObjectURL(new Blob([JSON.stringify(ds)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    this.note('ok', `Saved ${name} (${ds.clips.length} recordings) to your Downloads folder.`);
  }

  private async importFiles(files: File[]) {
    const known = new Set(this.app.classes.map((c) => c.id));
    const problems: string[] = [];
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
      const keep = ds.clips.filter((c) => known.has(c.label));
      unknown += ds.clips.length - keep.length;
      const n = this.app.store.load({ ...ds, clips: keep });
      added += n;
      dupes += keep.length - n;
      for (const c of keep) this.noteOrigin(c.session ?? ds.session, ds.source);
    }
    const parts: string[] = [];
    if (added || dupes || !problems.length) parts.push(`Imported ${added} recording${added === 1 ? '' : 's'}.`);
    if (dupes) parts.push(`${dupes} ${dupes === 1 ? 'was' : 'were'} already here.`);
    if (unknown) parts.push(`${unknown} skipped (sentences this page doesn't know).`);
    parts.push(...problems);
    this.note(problems.length ? 'bad' : 'ok', parts.join(' '));
  }

  private train() {
    const chosen = this.chosen();
    const clips = this.app.store.all().filter((c) => chosen.includes(c.label));
    try {
      const model = ml.train(clips);
      this.lastTrain = `Trained on ${clips.length} recordings. Recognize mode is on: hold Space and mouth any sentence.`;
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
  private render() {
    const { r, s, app } = this;
    const active = this.active;
    r.off.hidden = active;
    r.main.hidden = !active;
    r.offText.textContent = this.lastTrain && app.model ? this.lastTrain : 'Recording is paused while Recognize mode is on.';

    const all = app.store.all();
    const mine = all.filter((c) => c.session === s.session);
    const count = new Map<string, number>();
    for (const c of mine) count.set(c.label, (count.get(c.label) ?? 0) + 1);
    const chosen = this.chosen();
    const needed = chosen.filter((id) => (count.get(id) ?? 0) < s.reps);
    const kind = app.source?.kind;
    const recordable = kind === 'live' || kind === 'fake';
    this.prompt = this.restored && active && recordable ? this.prompter.current(needed) : null;

    // prompt
    const p = this.prompt;
    let state: string;
    r.next.hidden = true;
    r.exportDone.hidden = true;
    if (!this.restored) {
      state = 'loading';
      r.kicker.textContent = '';
      r.prompt.textContent = 'Loading your saved recordings…';
      r.hint.textContent = '';
    } else if (!active) {
      state = 'paused';
      r.kicker.textContent = '';
      r.prompt.textContent = 'Recording is paused';
      r.hint.textContent = '';
    } else if (kind === 'replay') {
      state = 'replay';
      r.kicker.textContent = 'Watching a replay';
      r.prompt.textContent = 'Recording needs AirPods';
      r.hint.textContent = 'Open this page while the Silent Speech Mac app is running (or add ?mode=fake to try it with fake data).';
    } else if (!recordable) {
      state = 'loading';
      r.kicker.textContent = '';
      r.prompt.textContent = 'Connecting…';
      r.hint.textContent = '';
    } else if (!p) {
      state = 'done';
      const next = nextSessionName(new Set([...all.map((c) => c.session ?? ''), s.session]));
      r.kicker.textContent = `Session ${s.session}`;
      r.prompt.textContent = `Session ${s.session} is done!`;
      r.hint.textContent = 'Export it, then take the AirPods out, put them back in, and start the next session.';
      r.next.textContent = `Start session ${next}`;
      r.next.hidden = false;
      r.exportDone.hidden = false;
    } else {
      state = 'prompt';
      const n = (count.get(p) ?? 0) + 1;
      r.kicker.textContent = p === NONE ? `No sentence this time · ${n} of ${s.reps}` : `Mouth this, no sound · ${n} of ${s.reps}`;
      r.prompt.textContent = promptText(p, this.sentence(p));
      r.hint.innerHTML = p === NONE
        ? 'Hold <kbd>Space</kbd> for about 2 seconds without mouthing anything.'
        : 'Hold <kbd>Space</kbd> (or the bar at the top), mouth it with no sound, then let go.';
    }
    r.prompt.dataset.state = state;
    r.prompt.dataset.label = p ?? '';
    r.stage.dataset.state = state;
    (r.redo as HTMLButtonElement).disabled = !mine.length;
    (r.skip as HTMLButtonElement).disabled = !p;
    r.skip.hidden = state === 'done';

    // progress (this session, chosen sentences)
    const done = chosen.reduce((t, id) => t + (count.get(id) ?? 0), 0);
    const target = chosen.length * s.reps;
    r.total.textContent = `${done} of ${target} recorded`;
    r.totalNote.textContent = `· session ${s.session}`;
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
    (r.clear as HTMLButtonElement).disabled = !mine.length;
    const bySession = new Map<string, number>();
    for (const c of all) bySession.set(c.session ?? '?', (bySession.get(c.session ?? '?') ?? 0) + 1);
    const health = app.store.health();
    const where = health.kind === 'indexeddb'
      ? 'Autosaved in this browser'
      : 'Autosave is off in this browser: export before you close the page';
    const list = [...bySession].map(([k, n]) => `${k} (${n})`).join(', ');
    r.saved.textContent = `${where}${list ? `: ${list}` : '.'}`;
    r.saved.dataset.kind = health.kind === 'indexeddb' && !health.error ? 'ok' : 'bad';
    if (health.error) r.saved.textContent += `. Some recordings may not be saved (${health.error}). Export to keep them.`;

    // train
    const set = evalSet(all, chosen);
    const train = r.train as HTMLButtonElement;
    train.disabled = !set;
    train.title = set ? 'Train the recognizer on these recordings and switch to Recognize mode'
      : `Record at least ${MIN_PER_CLASS} of ${MIN_CLASSES} different sentences first`;

    // settings inputs (don't fight the person while they type)
    const setVal = (el: HTMLElement, v: string) => { if (document.activeElement !== el) (el as HTMLInputElement).value = v; };
    setVal(r.session, s.session);
    setVal(r.reps, String(s.reps));
    setVal(r.subject, s.subject);
    for (const box of r.pick.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) box.checked = chosen.includes(box.value);

    this.syncFake();
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

  private renderSignal() {
    const { app } = this;
    const kind = app.source?.kind;
    let ok = true;
    let text = '';
    const st = app.lastStatus;
    const stale = performance.now() - this.lastMotion > SIGNAL_STALE_MS;
    if (!this.active || kind === 'replay' || !kind) {
      text = '';
    } else if (kind === 'live' && this.conn === 'closed') {
      ok = false; text = "Can't reach the Silent Speech app on the Mac. Is it open?";
    } else if (kind === 'live' && st && st.headphones !== 'connected') {
      ok = false; text = 'The AirPods are not connected to the Mac.';
    } else if (kind === 'live' && st && st.auth !== 'authorized') {
      ok = false; text = 'The Mac app needs permission to read head motion.';
    } else if (stale) {
      ok = false; text = 'No motion data yet. Put the AirPods in your ears.';
    } else {
      text = kind === 'fake' ? 'Fake AirPods (no hardware needed)' : `AirPods signal OK${st?.simulated ? ' (simulated)' : ''}`;
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

  private async runEval() {
    if (!this.restored) return;
    if (this.evalBusy) { this.evalAgain = true; return; }
    if (this.mlMissing) { this.showAcc({ state: 'not-ready' }); return; }
    const set = evalSet(this.app.store.all(), this.chosen());
    if (!set) { this.lastResult = null; this.evalKey = ''; this.showAcc({ state: 'waiting' }); return; }
    const key = set.clips.map((c) => c.id).join('|');
    if (key === this.evalKey && this.lastResult) { this.showAcc({ state: 'ready', res: this.lastResult }); return; }
    this.evalBusy = true;
    this.showAcc({ state: 'running' });
    try {
      const res = await this.evaluator.run(set.clips, set.sessions.length >= 2);
      this.evalKey = key;
      this.lastResult = res;
      this.showAcc({ state: 'ready', res });
    } catch (e) {
      const msg = errMsg(e);
      if (isNotImplemented(msg)) { this.mlMissing = true; this.showAcc({ state: 'not-ready' }); }
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
    if (v.state !== 'ready' && v.state !== 'running') { delete r.acc.dataset.acc; delete r.acc.dataset.n; }
    r.accLoso.textContent = '';
    if (v.state === 'not-ready') {
      r.accNum.textContent = '–';
      r.accSub.textContent = 'Model not ready yet. The recognizer is still being built; your recordings are saved.';
    } else if (v.state === 'error') {
      r.accNum.textContent = '–';
      r.accSub.textContent = `Couldn't check accuracy: ${v.msg}`;
    } else if (v.state === 'waiting') {
      r.accNum.textContent = '–';
      r.accSub.textContent = `Shows up once ${MIN_CLASSES} sentences have ${MIN_PER_CLASS} recordings each.`;
    } else if (!res) {
      r.accNum.textContent = '…';
      r.accSub.textContent = 'Checking…';
    }
    r.cmCap.hidden = !res;
    if (!res) { r.cm.innerHTML = ''; return; }
    const { loo, loso } = res;
    r.acc.dataset.acc = String(loo.accuracy);
    r.acc.dataset.n = String(loo.nClips);
    r.accNum.textContent = pct(loo.accuracy);
    const right = Math.round(loo.accuracy * loo.nClips);
    const verdict = loo.accuracy >= 0.9 ? 'Great.' : loo.accuracy >= 0.7 ? 'Getting there: more recordings will help.' : 'Keep recording: it needs more examples.';
    r.accSub.textContent = `${right} of ${loo.nClips} guessed right, testing each recording against the others. ${verdict}`
      + (v.state === 'running' ? ' (updating…)' : '');
    if (loso) {
      r.accLoso.textContent = `Across sessions: ${pct(loso.accuracy)} (each session tested on the others).`;
      r.acc.dataset.loso = String(loso.accuracy);
    } else delete r.acc.dataset.loso;
    r.cm.innerHTML = this.matrix(loo);
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
