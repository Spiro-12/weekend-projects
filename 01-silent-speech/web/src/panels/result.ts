// Recognize screen (result panel): you mouth a sentence, it appears big, and (only when safe) the Mac
// does it. Track J brief.
//
// - Model (Recognize mode), see result/model-source.ts: fake source → demo model; replay → Spiro's public
//   model; live → "your model" (ready once every sentence has 5+ takes recorded here with real AirPods: the
//   only kind that may run actions; it learns from all your real AirPods takes, imported sessions too),
//   else a preview model from your real clips, else Spiro's public model.
// - Actions: one strict rule (result/rule.ts). Anything else shows a ghost chip "Would: …".
// - Moments: demo_48h → confetti, help → full screen red alert, optional "Say it out loud".
// - Demo screen (for filming): only the sentence, full screen, spoken out loud. Texts never send from it
//   (demo-screen.ts).
import './result/result.css';
import type { App, Panel, PressContext } from '../core/app';
import type { ActionResultMsg, Classifier, HelloMsg, Prediction, StatusMsg } from '../core/contracts';
import { NONE } from '../core/contracts';
import * as ml from '../ml/index';
import { confetti } from './result/confetti';
import { buildDemoModelJSON, type DemoBuilt } from './result/demo-build';
import { DEMO_BUBBLE_MS, DEMO_NOT_SENT, DEMO_NO_TEXT, demoBubble, demoHolds, playAlarm } from './result/demo-screen';
import {
  MIN_REAL_CLASSES, MIN_TAKES_FOR_ACTIONS, actionReadiness, classCount, fetchPublicModel, fingerprint, planModel, realClips,
  type Provenance, type PublicModel, type Readiness,
} from './result/model-source';
import { ActionGuard, CONFIDENCE, clearsBar, type BlockReason, type Decision, type GuardInput, type Sent } from './result/rule';
import {
  OUTCOME_UNKNOWN, TEXTING_ACTIONS, UNPAIRED_TEXT, describeAction, ghostReason, okWords, recordAllText, recordings, sentenceOf,
  toastFor, type ToastText,
} from './result/text';

const HISTORY = 5;
const THINK_TIMEOUT_MS = 2600; // the shell cuts the clip at most 1.5 s after release
const SPEAK_KEY = 'ss.result.speak';
const HELP_FLASH_MS = 3000; // a replay shows the help moment as a red flash on the stage, this long
const RING_C = 2 * Math.PI * 52; // ring circumference (r = 52 in a 120 viewBox)
const DEMO_CLASS = 'ss-demo'; // on <html> while the demo screen is on (result.css hides everything else)

type Tag = { kind: 'own' | 'preview'; n: number; fp: string } | { kind: 'public' | 'demo'; n: number };
type StageState = 'idle' | 'listening' | 'thinking' | 'accepted' | 'probable' | 'unsure' | 'nomodel';
type ChipState = 'ghost' | 'sending' | 'started' | 'done' | 'dry' | 'failed' | 'unknown';
interface Seen { label: string; accepted: boolean; shown: boolean; confidence: number }

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const pct = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;
const nextFrame = () => new Promise<void>((r) => setTimeout(r, 30)); // let "Training…" paint first

const TEMPLATE = `
<div class="rs-off" data-ref="off">
  <div class="rs-off-text"><b>Recognize mode is off.</b>
    <span>Switch it on, then mouth a sentence. It shows up here, big.</span></div>
  <button class="rs-btn rs-primary" data-testid="result-go" data-ref="go">Try Recognize</button>
</div>
<div class="rs-main" data-ref="main">
  <div class="rs-top">
    <div class="rs-model" data-testid="result-model" data-ref="model" data-kind="loading">
      <span class="rs-dot"></span><b data-ref="modelMain">Loading…</b><span class="rs-sub" data-ref="modelSub"></span>
    </div>
    <button class="rs-btn rs-small" data-testid="result-retrain" data-ref="retrain">Re-train</button>
    <button class="rs-btn rs-small" data-testid="result-demo" data-ref="demoBtn"
      title="Full screen with only the sentence, for filming. Texts never send from it.">Demo screen</button>
    <span class="rs-pill" data-testid="result-armed" data-ref="armed" data-live="0"><span class="rs-dot"></span><span data-ref="armedText"></span></span>
  </div>
  <div class="rs-stage" data-testid="result-stage" data-ref="stage" data-state="idle">
    <div class="rs-glow" aria-hidden="true"></div>
    <div class="rs-say">
      <div class="rs-state" data-testid="result-state" data-ref="state" data-state="idle"><span class="rs-dot"></span><span data-ref="stateText">Ready</span></div>
      <div class="rs-label" data-testid="result-label" data-ref="label" aria-live="polite"></div>
      <div class="rs-guess" data-ref="guess"></div>
      <div class="rs-chip" data-testid="result-action" data-ref="chip" hidden>
        <span class="rs-chip-ico" aria-hidden="true"></span>
        <span class="rs-chip-main" data-ref="chipMain"></span>
        <span class="rs-chip-why" data-ref="chipWhy"></span>
      </div>
      <div class="rs-bubble" data-testid="result-bubble" data-ref="bubble" hidden>
        <div class="rs-bubble-to">To: <b data-ref="bubbleTo"></b></div>
        <div class="rs-bubble-row"><div class="rs-bubble-msg" data-ref="bubbleMsg"></div></div>
        <div class="rs-bubble-note">${DEMO_NOT_SENT}</div>
      </div>
    </div>
    <div class="rs-ring" data-testid="result-confidence" data-ref="ring" data-value="">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <defs><linearGradient id="rs-ring-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#9db4ff"></stop><stop offset="1" stop-color="#3ddc97"></stop></linearGradient></defs>
        <circle class="rs-trk" cx="60" cy="60" r="52"></circle>
        <circle class="rs-arc" data-ref="arc" cx="60" cy="60" r="52"></circle>
      </svg>
      <div class="rs-ring-num"><b data-ref="ringNum">–</b><small>sure</small></div>
    </div>
  </div>
  <div class="rs-lower">
    <div class="rs-block">
      <div class="rs-h">Top guesses</div>
      <div class="rs-bars" data-testid="result-top" data-ref="top"><div class="rs-empty">Nothing yet</div></div>
    </div>
    <div class="rs-block">
      <div class="rs-h">Last ${HISTORY}</div>
      <div class="rs-history" data-testid="result-history" data-ref="history"><div class="rs-empty">Nothing yet</div></div>
      <label class="rs-speak" data-ref="speakWrap"><input type="checkbox" data-testid="result-speak" data-ref="speak">
        <span class="rs-switch" aria-hidden="true"></span>Say it out loud</label>
    </div>
  </div>
  <div class="rs-demo-ui">
    <span class="rs-demo-dot" data-testid="demo-dot" data-ref="demoDot" data-live="0" role="img"></span>
    <button class="rs-demo-exit" data-testid="demo-exit" data-ref="demoExit">Exit <kbd>Esc</kbd></button>
    <div class="rs-demo-hint" data-testid="demo-hint" data-ref="demoHint"></div>
  </div>
</div>`;

class ResultPanel {
  private r: Record<string, HTMLElement> = {};
  private tags = new WeakMap<Classifier, Tag>();
  private gen = 0; // bumps cancel an in flight model load
  private loading: string | null = null;
  private failure: { why: 'missing' | 'error'; message: string } | null = null;
  private trainError: string | null = null;
  private publicLoad: Promise<PublicModel> | null = null;
  private demo: Classifier | null = null; // built once, on first use in fake mode
  private demoLoad: Promise<DemoBuilt> | null = null;
  private demoWhere: DemoBuilt['where'] | null = null;
  private realNow: { n: number; classes: number; fp: string; ready: Readiness } =
    { n: 0, classes: 0, fp: '', ready: { ready: false, done: 0, total: 0 } };
  private conn = 'connecting';
  private mySerial = 0; // this panel's own count of source and conn changes
  private downSerial: number | null = null; // mySerial at the last key down this panel saw
  private hello: HelloMsg | null = null; // from the current connection only
  private status: StatusMsg | null = null; // from the current connection only
  private guard = new ActionGuard();
  private history: Seen[] = [];
  private predSeq = 0; // which prediction the chip shows (a late answer must not overwrite a newer chip)
  private thinkTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private speak = false;
  private toast!: HTMLElement;
  private alert!: HTMLElement;
  private dismiss!: HTMLButtonElement;
  private inerted: HTMLElement[] = [];
  private spaceDownInAlert = false;
  private alertTimer: ReturnType<typeof setTimeout> | null = null;
  private alertClosedAt = -Infinity; // performance.now() when the help alert last closed
  private demoOn = false; // the demo screen: texts never send while it is on
  private bubbleTimer: ReturnType<typeof setTimeout> | null = null;
  private audio: AudioContext | null = null; // for the demo screen's help alarm (made on a click, so it may play)
  private alarms = 0;

  constructor(private el: HTMLElement, private app: App) {
    el.classList.add('rs');
    el.innerHTML = TEMPLATE;
    for (const n of el.querySelectorAll<HTMLElement>('[data-ref]')) this.r[n.dataset.ref!] = n;
    this.r.arc.style.strokeDasharray = `${RING_C}`;
    this.r.arc.style.strokeDashoffset = `${RING_C}`;
    this.buildOverlays();
    try { this.speak = localStorage.getItem(SPEAK_KEY) === '1'; } catch { /* storage blocked */ }
    (this.r.speak as HTMLInputElement).checked = this.speak;
    this.r.speakWrap.hidden = typeof speechSynthesis === 'undefined';
    this.wire();
    this.refreshReal();
    this.renderMode();
    this.renderIdle();
    if (app.mode === 'classify') void this.ensureModel(false);
  }

  // ---------- wiring ----------
  private wire() {
    const { app, r } = this;
    const click = (b: HTMLElement, fn: () => void) => b.addEventListener('click', () => {
      (b as HTMLButtonElement).blur(); // so the next Space press is push to talk, not another click
      fn();
    });
    click(r.go, () => app.setMode('classify'));
    click(r.retrain, () => void this.ensureModel(true));
    click(r.demoBtn, () => this.enterDemo());
    click(r.demoExit, () => this.exitDemo());
    const speak = r.speak as HTMLInputElement;
    speak.addEventListener('change', () => {
      this.speak = speak.checked;
      try { localStorage.setItem(SPEAK_KEY, this.speak ? '1' : '0'); } catch { /* ignore */ }
      if (!this.speak) try { speechSynthesis.cancel(); } catch { /* ignore */ }
      speak.blur(); // Space on a focused checkbox would toggle it instead of push to talk
    });

    app.bus.on('mode', (m) => {
      this.renderMode();
      if (m === 'classify') void this.ensureModel(false);
      else { this.closeAlert(); this.exitDemo(); }
    });
    app.bus.on('model', (m) => {
      if (m && !this.tags.has(m)) this.gen++; // another panel set a model: drop any load in flight
      this.renderModel();
      this.renderIdle();
      this.renderArmed();
    });
    app.bus.on('source', () => {
      this.mySerial++;
      this.hello = null;
      this.status = null;
      this.conn = 'connecting';
      // A new source starts clean: no leftover result, chip or history from the previous one (e.g. the replay).
      this.history = [];
      this.r.history.innerHTML = '<div class="rs-empty">Nothing yet</div>';
      this.r.chip.hidden = true;
      this.hideBubble();
      this.renderDemoHint();
      this.renderArmed();
      this.renderIdle();
      if (app.mode === 'classify') void this.ensureModel(false); // fake ↔ live/replay need different models
    });
    app.bus.on('conn', (c) => {
      this.mySerial++;
      this.conn = c.state;
      if (c.state !== 'open') { this.hello = null; this.status = null; } // only trust what this connection says
      this.renderArmed();
    });
    app.bus.on('hello', (h) => { this.hello = h; this.renderArmed(); });
    app.bus.on('status', (s) => { this.status = s; this.renderArmed(); });
    app.bus.on('ptt', ({ down }) => {
      if (down) this.downSerial = this.mySerial;
      if (down && this.demoOn) this.wakeAudio(); // a key press: the browser lets audio start now
      this.onPtt(down);
    });
    app.bus.on('prediction', (p) => this.onPrediction(p));
    app.bus.on('actionResult', (res) => this.showToast(toastFor(res)));
    app.store.onChange(() => { this.refreshReal(); this.renderModel(); });
    void app.store.ready.then(() => { this.refreshReal(); this.renderModel(); });
  }

  // ---------- model source ----------
  private ids() { return this.app.classes.map((c) => c.id); }
  private real() { return realClips(this.app.store.all(), (id) => this.app.store.meta(id), this.ids()); }
  private recorded() { return realClips(this.app.store.all(), (id) => this.app.store.meta(id), this.ids(), { recordedOnly: true }); }

  private refreshReal() {
    const real = this.real();
    const rec = this.recorded();
    this.realNow = { n: real.length, classes: classCount(real), fp: fingerprint(real), ready: actionReadiness(rec, this.ids()) };
  }

  private provenance(): Provenance | null {
    const m = this.app.model;
    return m ? this.tags.get(m)?.kind ?? 'other' : null;
  }

  /** Only a model this panel trained as "your model" (every sentence 5+ times recorded here) may act. */
  private isOwn(m: Classifier | null | undefined): boolean {
    return !!m && this.tags.get(m)?.kind === 'own';
  }

  /** Picks the model for Recognize mode (or rebuilds it: `force`). Never throws. */
  private async ensureModel(force: boolean) {
    const gen = ++this.gen;
    const { app } = this;
    this.setLoading('Loading your recordings…');
    await app.store.ready;
    if (gen !== this.gen) return;
    const real = this.real();
    const rec = this.recorded();
    const ready = actionReadiness(rec, this.ids());
    const tag = app.model ? this.tags.get(app.model) : undefined;
    const fresh = (tag?.kind === 'own' || tag?.kind === 'preview') && tag.fp === fingerprint(real);
    const plan = planModel({
      source: app.source?.kind ?? null, ownReady: ready.ready, realClasses: classCount(real), current: this.provenance(), fresh, force,
    });
    this.trainError = null;
    if (plan === 'keep') { this.setLoading(null); return; }
    if (plan === 'demo') {
      if (!this.demo) {
        this.setLoading('Building the demo model…');
        const t0 = performance.now();
        this.demoLoad ??= buildDemoModelJSON(app.classes); // shared by overlapping calls
        const built = await this.demoLoad;
        if (gen !== this.gen) return;
        let model: Classifier | null = null;
        if (built.ok) {
          try { model = ml.loadModel(built.json); } catch (e) { console.error('[result] demo model is broken', e); }
        } else console.error('[result] building the demo model failed:', built.error);
        if (!model) {
          this.demoLoad = null; // try again next time
          this.loading = null;
          this.failure = { why: 'error', message: 'The demo model didn’t build' };
          if (this.provenance() !== 'other') app.setModel(null); else { this.renderModel(); this.renderIdle(); }
          return;
        }
        this.demo = model;
        this.demoWhere = built.where;
        this.tags.set(model, { kind: 'demo', n: built.ok ? built.n : 0 });
        console.info(`[result] demo model: ${built.ok ? built.n : 0} made-up takes, ready in ${Math.round(performance.now() - t0)} ms (${built.where})`);
      }
      this.failure = null;
      this.loading = null;
      app.setModel(this.demo);
      return;
    }
    if (plan === 'own' || plan === 'preview') {
      // Both learn from every real AirPods take, imported sessions too (more sessions = much better on a new
      // day: Spiro's s1..s4 → s5 98% vs s4 alone 92%). Only the readiness gate (ownReady) counts takes
      // recorded here, so a model still can't act until this browser has a full set.
      const clips = real;
      this.setLoading(`Training on your ${recordings(clips.length)}…`);
      await nextFrame();
      if (gen !== this.gen) return;
      try {
        const model = ml.train(clips, { threshold: CONFIDENCE.messaging }); // "You said" = sure enough to text
        this.tags.set(model, { kind: plan, n: clips.length, fp: fingerprint(clips) });
        this.failure = null;
        this.loading = null;
        app.setModel(model);
        return;
      } catch (e) {
        console.error('[result] training on your recordings failed', e);
        this.trainError = `Couldn't train on your recordings (${e instanceof Error ? e.message : String(e)}).`;
      }
    }
    this.setLoading("Loading Spiro's model…");
    if (force || !this.publicLoad) this.publicLoad = fetchPublicModel(`${import.meta.env.BASE_URL}models/templates.json`);
    const loadP = this.publicLoad;
    const res = await loadP;
    if (gen !== this.gen) return;
    if (!res.ok) this.publicLoad = null; // try again next time
    let model: Classifier | null = null;
    if (res.ok) {
      try {
        model = ml.loadModel(res.json);
        this.tags.set(model, { kind: 'public', n: res.json.templates.length });
      } catch (e) {
        console.error('[result] public model is broken', e);
        this.publicLoad = null;
        this.failure = { why: 'error', message: 'The public model file is broken' };
      }
    } else {
      this.failure = { why: res.why, message: res.message };
    }
    this.loading = null;
    if (model) { this.failure = null; app.setModel(model); return; }
    // No public model. Your model (its recordings are gone, or this is a replay), or the fake data demo, shouldn't linger.
    const prov = this.provenance();
    if (prov === 'own' || prov === 'preview' || prov === 'demo') app.setModel(null);
    else { this.renderModel(); this.renderIdle(); }
  }

  private setLoading(text: string | null) {
    this.loading = text;
    this.renderModel();
  }

  // ---------- events ----------
  private onPtt(down: boolean) {
    if (this.app.mode !== 'classify') return;
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    this.thinkTimer = null;
    if (!this.app.model) { this.setState('nomodel', down ? 'No model yet' : this.noModelKicker()); return; }
    const replay = this.app.source?.kind === 'replay';
    if (down) { this.setState('listening', replay ? 'Spiro is mouthing a sentence…' : 'Listening… let go when you finish'); return; }
    this.setState('thinking', replay ? 'Reading the motion…' : 'Reading your lips…');
    this.thinkTimer = setTimeout(() => {
      this.thinkTimer = null;
      this.setState('unsure', 'Didn’t catch that');
      this.r.guess.textContent = this.app.source?.kind === 'replay' ? 'No answer for this take.' : 'Hold Space the whole time you mouth the sentence.';
      this.r.stage.dataset.state = 'unsure';
    }, THINK_TIMEOUT_MS);
  }

  private onPrediction(p: Prediction & { clipId?: string; model?: Classifier; press?: PressContext }) {
    if (this.app.mode !== 'classify') return;
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    this.thinkTimer = null;
    const { app, r } = this;
    const seq = ++this.predSeq;
    const conf = Number.isFinite(p.confidence) ? Math.max(0, Math.min(1, p.confidence)) : 0;
    // Shown from CONFIDENCE.other up; "You said" once the model accepts it, "Probably" in between.
    const shown = p.label !== NONE && Number.isFinite(p.confidence) && p.confidence >= CONFIDENCE.other;
    const accepted = shown && p.accepted === true;
    const sentence = sentenceOf(app.classes, p.label);

    this.hideBubble(); // a new result replaces the last demo text bubble
    if (this.demoOn) try { speechSynthesis.cancel(); } catch { /* no speech here */ } // a new result cuts the last one off

    // big sentence
    r.label.dataset.label = p.label;
    r.label.dataset.accepted = accepted ? '1' : '0';
    r.label.dataset.probable = shown && !accepted ? '1' : '0';
    if (shown) {
      r.label.innerHTML = sentence.split(/\s+/).map((w, i) => `<span class="rs-w" style="--i:${i}">${esc(w)}</span>`).join(' ');
      r.guess.textContent = accepted ? '' : 'Not fully sure. Say it again to be certain.';
      const said = this.app.source?.kind === 'replay' ? 'Heard' : 'You said';
      this.setState(accepted ? 'accepted' : 'probable', accepted ? said : 'Probably');
    } else {
      r.label.innerHTML = `<span class="rs-w rs-calm">Not sure, try again</span>`;
      r.guess.textContent = p.label === NONE ? 'Looked like nothing was said.' : `Best guess: ${sentence} (${pct(conf)})`;
      this.setState('unsure', 'Not sure');
    }
    r.stage.dataset.state = accepted ? 'accepted' : shown ? 'probable' : 'unsure';
    r.stage.classList.remove('rs-pop');
    void r.stage.offsetWidth; // restart the glow animation
    r.stage.classList.add('rs-pop');

    // confidence ring + top 3
    r.ring.dataset.value = conf.toFixed(3);
    r.ring.dataset.accepted = accepted ? '1' : shown ? 'probable' : '0';
    r.ringNum.textContent = pct(conf);
    r.arc.style.strokeDashoffset = `${RING_C * (1 - conf)}`;
    const top = (Array.isArray(p.top) ? p.top : []).slice(0, 3);
    r.top.innerHTML = top.length ? top.map((t, i) => {
      const s = Number.isFinite(t.score) ? Math.max(0, Math.min(1, t.score)) : 0;
      return `<div class="rs-row" data-first="${i === 0 ? 1 : 0}" data-ok="${i === 0 && shown ? 1 : 0}" data-label="${esc(t.label)}">
        <span class="rs-name" title="${esc(sentenceOf(app.classes, t.label))}">${esc(sentenceOf(app.classes, t.label))}</span>
        <span class="rs-track"><i style="--w:${(s * 100).toFixed(1)}%"></i></span>
        <span class="rs-pct">${pct(s)}</span></div>`;
    }).join('') : '<div class="rs-empty">No guesses</div>';

    // history
    this.history.unshift({ label: p.label, accepted, shown, confidence: conf });
    this.history.length = Math.min(this.history.length, HISTORY);
    r.history.innerHTML = this.history.map((h, i) => {
      const s = sentenceOf(app.classes, h.label);
      return `<span class="rs-hchip${i === 0 ? ' rs-new' : ''}" data-ok="${h.accepted ? 1 : 0}" data-probable="${h.shown && !h.accepted ? 1 : 0}" data-label="${esc(h.label)}" title="${esc(s)} · ${pct(h.confidence)}">
        <i aria-hidden="true">${h.accepted ? '✓' : h.shown ? '~' : '?'}</i><span>${esc(h.shown ? s : 'Not sure')}</span></span>`;
    }).join('');

    // action (the strict rule), then moments
    const action = app.classes.find((c) => c.id === p.label)?.action ?? null;
    // The model that MADE this prediction (not whatever app.model is now) and where the take started.
    const input = this.guardInput({ label: p.label, accepted: p.accepted, confidence: p.confidence }, action, p.model, p.press);
    // Demo screen: an action that could message someone is only decided (same rule, same answer), and the
    // rule is never handed a way to send it. If it says "send", the screen shows what would have gone out.
    const held = this.demoOn && demoHolds(action);
    const run = held ? { decision: this.guard.decide(input), sent: null }
      : this.guard.run(input, (a) => app.sendAction({ action: a, label: p.label, confidence: p.confidence }));
    if (held && run.decision.send) { r.chip.hidden = true; this.showBubble(run.decision.action); }
    else this.renderChip(run.decision, action, shown);
    if (run.sent) void run.sent.then((s) => this.onSent(s, action!, seq));
    else if (!run.decision.send && run.decision.reason === 'unpaired') this.showToast({ kind: 'bad', title: 'Not paired', body: UNPAIRED_TEXT });
    this.renderArmed();

    // Moments use the same bars as the actions: the help alert only when texts could go, confetti from 0.5.
    if (p.label === 'demo_48h' && clearsBar('demo_48h', p)) confetti();
    if (p.label === 'help' && clearsBar('help', p)) this.openAlert(sentence, run.decision, action);
    // Speech: outside the demo screen "Say it out loud" (off by default) speaks sure results. The demo screen
    // always speaks what it shows ("Probably" too), except a demo line the Mac was just asked to say itself.
    if (this.demoOn) {
      const macSaysIt = run.decision.send && run.decision.action === 'demo_48h';
      if (shown && !macSaysIt) this.say(sentence);
    } else if (accepted && this.speak) this.say(sentence);
  }

  private guardInput(
    pred: GuardInput['pred'], action: string | null, model: Classifier | null | undefined, press: PressContext | null | undefined,
  ): GuardInput {
    const { app } = this;
    return {
      mode: app.mode, source: app.source?.kind ?? null, press, connSerial: app.connSerial,
      panelConn: { atPress: this.downSerial, now: this.mySerial }, connOpen: this.conn === 'open',
      hello: this.hello, status: this.status, ownModel: this.isOwn(model), pred, action, token: app.pairToken,
    };
  }

  private why(reason: BlockReason, action = ''): string {
    return ghostReason(reason, this.app.source?.kind ?? null, this.app.classes.length, MIN_TAKES_FOR_ACTIONS, action, this.realNow.ready.ready);
  }

  /** The Mac answered (the toast comes from the actionResult event). Updates the chip only if it still shows this prediction. */
  private onSent(s: Sent, action: string, seq: number) {
    const chip = (state: ChipState, main: string, why: string) => { if (seq === this.predSeq) this.setChip(state, main, why); };
    const alert = (text: string) => { if (action === 'help') this.updateAlert(text); };
    this.renderArmed();
    if (s.error !== undefined || !s.result) {
      console.error('[result] sending the action failed', s.error);
      chip('failed', `Didn’t run: ${describeAction(action)}`, 'Couldn’t reach the Mac app');
      this.showToast({ kind: 'bad', title: 'Not sent', body: 'Couldn’t reach the Mac app, so nothing happened.' });
      alert('Couldn’t reach the Mac app.');
      return;
    }
    const res: ActionResultMsg = s.result;
    const what = describeAction(action);
    if (res.ok && !res.dryRun) {
      // The Mac answers ok when it has STARTED (texts, music, calendar), so those never say "Done".
      const w = okWords(action, res.message);
      chip(w.title === 'Done on your Mac' ? 'done' : 'started', w.chip, w.why);
      alert(TEXTING_ACTIONS.includes(action) ? 'Your Mac is sending the text.' : w.title);
    } else if (res.ok) {
      chip('dry', `Dry run: ${what}`, 'Safe mode is on in the Mac app');
      alert('Dry run: safe mode is on, nothing was sent.');
    } else if (OUTCOME_UNKNOWN.includes(res.error ?? '')) {
      chip('unknown', `Maybe: ${what}`, 'No answer from the Mac. Not trying again.');
      alert('No answer from the Mac. It may have been sent.');
    } else {
      chip('failed', `Didn’t run: ${what}`, toastFor(res).body);
      alert(`Not sent: ${toastFor(res).body}`);
    }
  }

  // ---------- rendering ----------
  private renderMode() {
    const on = this.app.mode === 'classify';
    this.r.off.hidden = on;
    this.r.main.hidden = !on;
    this.el.dataset.mode = on ? 'classify' : 'enroll';
    this.el.closest('.card')?.classList.toggle('wide', on);
    this.renderModel();
    this.renderArmed();
    this.renderIdle();
  }

  private noModelKicker(): string {
    if (this.loading) return 'Getting the model ready…';
    return this.failure?.why === 'missing' ? 'No public model yet' : 'No model yet';
  }

  /** The big area before the first prediction (or when there is no model). */
  private renderIdle() {
    const { r, app } = this;
    if (app.mode !== 'classify') return;
    if (this.history.length) { // the last result stays on screen; only the kicker follows the model
      if (!app.model) this.setState('nomodel', this.noModelKicker());
      else if (r.state.dataset.state === 'nomodel') this.setState('idle', 'Ready');
      return;
    }
    r.label.dataset.label = '';
    r.label.dataset.accepted = '0';
    if (!app.model) {
      this.setState('nomodel', this.noModelKicker());
      r.label.innerHTML = `<span class="rs-w rs-calm">${this.loading ? 'One moment…' : 'Record your sentences first'}</span>`;
      r.guess.textContent = this.loading ? '' : 'Switch to Record mode, record a few sentences, then press “Train & use it”.';
      r.stage.dataset.state = 'nomodel';
      return;
    }
    this.setState('idle', 'Ready');
    const kind = app.source?.kind;
    r.label.innerHTML = kind === 'replay'
      ? `<span class="rs-w rs-calm">Watching Spiro's real session</span>`
      : `<span class="rs-w rs-calm">Hold <kbd>Space</kbd> and mouth a sentence</span>`;
    r.guess.textContent = kind === 'fake'
      ? (this.demoOn ? 'Fake AirPods: hold Space and they mouth a sentence for you.' : 'Fake AirPods: pick a sentence at the top, then hold Space.')
      : kind === 'replay' ? 'Watching a replay of a real session.' : 'Let go when you finish.';
    r.stage.dataset.state = 'idle';
  }

  private setState(s: StageState, text: string) {
    this.r.state.dataset.state = s;
    this.r.stateText.textContent = text;
    if (s === 'listening' || s === 'thinking' || s === 'nomodel') this.r.stage.dataset.state = s;
  }

  private renderModel() {
    const { r, app } = this;
    const m = app.model;
    const tag = m ? this.tags.get(m) : undefined;
    let kind: string, main: string, sub = '';
    if (this.loading) { kind = 'loading'; main = this.loading; }
    else if (m && tag?.kind === 'own') {
      kind = 'own';
      main = `Your model: ${recordings(tag.n)}`;
      sub = tag.fp !== this.realNow.fp ? 'New recordings since. Press Re-train.' : 'Can run actions on your Mac';
    } else if (m && tag?.kind === 'preview') {
      kind = 'preview';
      main = `Your model (preview): ${recordings(tag.n)}`;
      const rd = this.realNow.ready;
      sub = rd.ready || tag.fp !== this.realNow.fp ? 'New recordings since. Press Re-train.'
        : `${recordAllText(rd.total, MIN_TAKES_FOR_ACTIONS)} (${rd.done} of ${rd.total} done in this browser)`;
    } else if (m && tag?.kind === 'demo') {
      kind = 'demo';
      main = 'Demo model (fake data)';
      sub = 'Made-up motion like the fake AirPods. Preview only';
    } else if (m && tag?.kind === 'public') {
      kind = 'public';
      main = "Spiro's model (public)";
      sub = `${recordings(tag.n)} of Spiro’s real AirPods data`;
    } else if (m) {
      kind = 'other';
      main = 'Practice model from the Record screen';
      sub = 'Preview only';
    } else if (this.failure) {
      kind = this.failure.why;
      main = this.failure.why === 'missing' ? 'No public model yet' : this.failure.message;
      sub = 'Record sentences with your AirPods to make your own';
    } else { kind = 'none'; main = 'No model yet'; }
    if (this.trainError && kind !== 'loading') sub = this.trainError;
    r.model.dataset.kind = kind;
    if (this.demoWhere) r.model.dataset.demoBuilt = this.demoWhere; // worker or main (tests check the worker works)
    if (r.modelMain.textContent !== main) r.modelMain.textContent = main;
    if (r.modelSub.textContent !== sub) r.modelSub.textContent = sub;
    const b = r.retrain as HTMLButtonElement;
    b.disabled = !!this.loading;
    b.title = app.source?.kind === 'fake' ? 'Fake AirPods use the demo model (Re-train has nothing new to learn)'
      : this.realNow.classes >= MIN_REAL_CLASSES
      ? `Train again on your ${recordings(this.realNow.n)} from real AirPods`
      : 'Reload Spiro’s model (record 2 or more sentences with your AirPods to train your own)';
  }

  /** "Live" pill: would an accepted sentence run on the Mac right now? */
  private renderArmed() {
    const { r, app } = this;
    if (app.mode !== 'classify') return;
    const action = this.hello?.actions[0] ?? app.classes.find((c) => c.action)?.action ?? 'volume_up';
    // A take started right now, by the current model.
    const press: PressContext = { mode: 'classify', source: app.source?.kind ?? null, conn: app.connSerial, simulated: this.status?.simulated ?? null };
    const x = this.guardInput({ label: action, accepted: true, confidence: 1 }, action, app.model, press);
    const d = this.guard.decide({ ...x, panelConn: { atPress: this.mySerial, now: this.mySerial } });
    const live = d.send || d.reason === 'busy' || d.reason === 'too-soon';
    r.armed.dataset.live = live ? '1' : '0';
    const text = live ? 'Live: sentences run on your Mac' : `Preview only · ${this.why((d as { reason: BlockReason }).reason)}`;
    if (r.armedText.textContent !== text) r.armedText.textContent = text;
    // The demo screen's corner dot: green when live and armed (texts still never send from the demo screen).
    r.demoDot.dataset.live = live ? '1' : '0';
    const dot = live ? 'Live and armed (texts never send from the demo screen)' : 'Preview only';
    if (r.demoDot.title !== dot) { r.demoDot.title = dot; r.demoDot.setAttribute('aria-label', dot); }
  }

  private renderChip(d: Decision, action: string | null, shown: boolean) {
    if (d.send) { this.setChip('sending', `Doing: ${describeAction(d.action)}`, 'Sent to your Mac…'); return; }
    // Nothing would run for "Not sure" (below 0.5), 'none', or a sentence without an action.
    if (d.reason === 'not-accepted' || d.reason === 'no-action' || !action || !shown) { this.r.chip.hidden = true; return; }
    this.setChip('ghost', `Would: ${describeAction(action)}`, this.why(d.reason, action));
    this.r.chip.dataset.reason = d.reason;
  }

  private setChip(state: ChipState, main: string, why: string) {
    const { r } = this;
    r.chip.hidden = false;
    r.chip.dataset.state = state;
    delete r.chip.dataset.reason;
    r.chipMain.textContent = main;
    r.chipWhy.textContent = why;
  }

  // ---------- toast, alert, speech ----------
  private buildOverlays() {
    this.toast = document.createElement('div');
    this.toast.className = 'rs-toast';
    this.toast.dataset.testid = 'result-toast';
    this.toast.setAttribute('role', 'status');
    this.toast.setAttribute('aria-live', 'polite');
    this.toast.hidden = true;
    this.toast.innerHTML = `<span class="rs-toast-ico" aria-hidden="true"></span><div class="rs-toast-text"><b class="rs-toast-title"></b><span class="rs-toast-body" data-testid="result-toast-body"></span></div><button class="rs-toast-x" aria-label="Close">×</button>`;
    this.toast.querySelector('button')!.addEventListener('click', (e) => { (e.currentTarget as HTMLButtonElement).blur(); this.hideToast(); });

    this.alert = document.createElement('div');
    this.alert.className = 'rs-alert';
    this.alert.dataset.testid = 'result-alert';
    this.alert.setAttribute('role', 'alertdialog');
    this.alert.setAttribute('aria-modal', 'true');
    this.alert.setAttribute('aria-labelledby', 'rs-alert-title');
    this.alert.hidden = true;
    this.alert.innerHTML = `
      <div class="rs-alert-in">
        <div class="rs-alert-ico" aria-hidden="true"><span></span></div>
        <div class="rs-alert-kicker">Help</div>
        <div class="rs-alert-title" id="rs-alert-title"></div>
        <div class="rs-alert-sub" data-testid="result-alert-sub"></div>
        <button class="rs-alert-btn" data-testid="result-alert-dismiss">Dismiss</button>
      </div>`;
    this.dismiss = this.alert.querySelector('button')!;
    this.dismiss.addEventListener('click', () => this.closeAlert());
    // Clicks anywhere else on the alert keep focus on Dismiss.
    this.alert.addEventListener('pointerdown', (e) => {
      if (e.target === this.dismiss) return;
      e.preventDefault();
      this.dismiss.focus();
    });
    document.body.append(this.toast, this.alert);
  }

  private showToast(t: ToastText) {
    const el = this.toast;
    el.dataset.kind = t.kind;
    el.querySelector('.rs-toast-title')!.textContent = t.title;
    el.querySelector('.rs-toast-body')!.textContent = t.body;
    el.hidden = false;
    el.classList.remove('rs-in');
    void el.offsetWidth;
    el.classList.add('rs-in');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.hideToast(), t.kind === 'ok' || t.kind === 'dry' ? 6000 : 10_000);
  }

  private hideToast() {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.toast.hidden = true;
  }

  private openAlert(sentence: string, d: Decision, action: string | null) {
    const a = this.alert;
    a.querySelector('.rs-alert-title')!.textContent = sentence;
    const sub = this.demoOn ? DEMO_NO_TEXT // the demo screen never sends a text, whatever the rule said
      : d.send ? 'Asking your Mac to send the text…'
      : action ? `Would: ${describeAction(action)}. ${this.why(d.reason, action)}.` : '';
    a.querySelector('.rs-alert-sub')!.textContent = sub;
    if (this.app.source?.kind === 'replay') { this.flashHelp(); return; } // a replay plays on: no modal over it
    if (this.demoOn) this.alarm();
    if (!a.hidden) { this.dismiss.focus(); return; }
    // End a take that is still held, so its key up can't get stuck behind the alert. Its prediction must not
    // act behind the alert: bump our own serial first, so the rule blocks it as press-changed ("Say it again").
    if (this.app.pttDown) {
      this.mySerial++;
      this.app.ptt(false);
    }
    this.spaceDownInAlert = false;
    a.hidden = false;
    document.body.classList.add('rs-alert-open');
    // Everything behind the alert is inert: no clicks, no focus, no push to talk button.
    this.inerted = [...document.body.children].filter((n): n is HTMLElement => n !== a && n instanceof HTMLElement && !n.inert);
    for (const n of this.inerted) n.inert = true;
    document.addEventListener('keydown', this.alertKeyDown, true);
    document.addEventListener('keyup', this.alertKeyUp, true);
    document.addEventListener('focusin', this.alertFocus, true);
    this.dismiss.focus();
  }

  /** While the alert is open, keys belong to it (capture phase, before the shell's push to talk). */
  private alertKeyDown = (e: KeyboardEvent) => {
    if (this.alert.hidden) return;
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.closeAlert();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.spaceDownInAlert = true;
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); this.dismiss.focus(); }
  };

  private alertKeyUp = (e: KeyboardEvent) => {
    if (this.alert.hidden || e.code !== 'Space') return;
    if (this.app.pttDown) return; // never swallow the key up that ends push to talk
    e.preventDefault();
    e.stopPropagation();
    if (this.spaceDownInAlert) { this.spaceDownInAlert = false; this.closeAlert(); } // Space pressed on the alert = Dismiss
  };

  private alertFocus = (e: FocusEvent) => {
    if (!this.alert.hidden && !this.alert.contains(e.target as Node)) this.dismiss.focus();
  };

  private updateAlert(text: string) {
    if (this.alert.hidden) return;
    this.alert.querySelector('.rs-alert-sub')!.textContent = text;
  }

  /** Replay: the help moment as a red flash on the stage (visitors are watching, nobody needs help). */
  private flashHelp() {
    const st = this.r.stage;
    if (this.alertTimer) clearTimeout(this.alertTimer);
    st.dataset.moment = 'help';
    this.alertTimer = setTimeout(() => { delete st.dataset.moment; this.alertTimer = null; }, HELP_FLASH_MS);
  }

  private closeAlert() {
    if (this.alert.hidden) return;
    document.removeEventListener('keydown', this.alertKeyDown, true);
    document.removeEventListener('keyup', this.alertKeyUp, true);
    document.removeEventListener('focusin', this.alertFocus, true);
    for (const n of this.inerted) n.inert = false;
    this.inerted = [];
    this.spaceDownInAlert = false;
    this.alert.hidden = true;
    this.alertClosedAt = performance.now();
    document.body.classList.remove('rs-alert-open');
    this.dismiss.blur();
  }

  // ---------- demo screen ----------
  /** In page (no reload: the pairing token lives in memory only). Full screen if the browser allows it. */
  private enterDemo() {
    if (this.demoOn || this.app.mode !== 'classify') return;
    this.demoOn = true;
    document.documentElement.classList.add(DEMO_CLASS);
    this.el.dataset.demo = '1';
    this.wakeAudio(); // a click: the browser lets audio start now
    document.addEventListener('fullscreenchange', this.onFullscreen);
    addEventListener('keydown', this.demoKeyDown); // bubble phase: the help alert's capture handler goes first
    try {
      const root = document.documentElement;
      if (!document.fullscreenElement && root.requestFullscreen) void root.requestFullscreen().catch(() => { /* fills the window */ });
    } catch { /* no full screen: the demo screen still fills the window */ }
    this.renderDemoHint();
    this.renderIdle();
    this.renderArmed();
  }

  private exitDemo() {
    if (!this.demoOn) return;
    this.demoOn = false;
    document.documentElement.classList.remove(DEMO_CLASS);
    delete this.el.dataset.demo;
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    removeEventListener('keydown', this.demoKeyDown);
    this.hideBubble();
    try {
      if (document.fullscreenElement === document.documentElement) void document.exitFullscreen().catch(() => { /* ignore */ });
    } catch { /* ignore */ }
    try { void this.audio?.close().catch(() => { /* ignore */ }); } catch { /* ignore */ }
    this.audio = null;
    this.renderIdle();
  }

  /** Esc leaves the demo screen. While the help alert is open its own handler takes Esc first (it only closes the alert). */
  private demoKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.demoOn || !this.alert.hidden || e.defaultPrevented) return;
    e.preventDefault();
    this.exitDemo();
  };

  /** Leaving browser full screen (its own Esc, which the page may never see) leaves the demo screen too. */
  private onFullscreen = () => {
    if (!this.demoOn || document.fullscreenElement) return;
    if (!this.alert.hidden) { this.closeAlert(); return; } // Esc with the help alert open only closes the alert
    if (performance.now() - this.alertClosedAt < 600) return; // that same Esc already closed the alert
    this.exitDemo();
  };

  private renderDemoHint() {
    const replay = this.app.source?.kind === 'replay';
    this.r.demoHint.innerHTML = replay ? 'Watching a replay of Spiro’s real session' : 'Hold <kbd>Space</kbd> and mouth a sentence';
  }

  /** The text the demo screen shows instead of sending it. */
  private showBubble(action: string) {
    const b = demoBubble(action);
    if (!b) return; // help: the red alert is its moment
    const { r } = this;
    r.bubbleTo.textContent = b.to;
    r.bubbleMsg.textContent = b.text;
    r.bubble.dataset.action = action;
    r.bubble.hidden = true;
    void r.bubble.offsetWidth; // restart the pop in animation
    r.bubble.hidden = false;
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => this.hideBubble(), DEMO_BUBBLE_MS);
  }

  private hideBubble() {
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    this.bubbleTimer = null;
    this.r.bubble.hidden = true;
  }

  private wakeAudio() {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.audio ??= new AC();
      if (this.audio.state === 'suspended') void this.audio.resume().catch(() => { /* ignore */ });
    } catch (e) {
      console.warn('[result] no audio', e);
      this.audio = null;
    }
  }

  /** The demo screen's help moment: about 1 s of alarm beeps. */
  private alarm() {
    this.wakeAudio();
    playAlarm(this.audio);
    this.alert.dataset.alarms = String(++this.alarms); // test hook
  }

  private say(text: string) {
    try {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    } catch (e) { console.warn('[result] speech failed', e); }
  }
}

const panel: Panel = {
  id: 'result',
  order: 5,
  title: 'Recognize',
  mount(el, app) { new ResultPanel(el, app); },
};
export default panel;
