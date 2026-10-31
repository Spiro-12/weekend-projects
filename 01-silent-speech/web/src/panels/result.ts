// Recognize screen (result panel): you mouth a sentence, it appears big, and (only when safe) the Mac
// does it. Track J brief.
//
// - Model (Recognize mode): your real AirPods clips for 2+ sentences → train "your model"; else
//   Spiro's public model (models/templates.json). Fake practice clips never train it. See result/model-source.ts.
// - Actions: one strict rule (result/rule.ts). Anything else shows a ghost chip "Would: …".
// - Moments: demo_48h → confetti, help → full screen red alert, optional "Say it out loud".
import './result/result.css';
import type { App, Panel } from '../core/app';
import type { ActionResultMsg, Classifier, HelloMsg, Prediction, StatusMsg } from '../core/contracts';
import { NONE } from '../core/contracts';
import * as ml from '../ml/index';
import { confetti } from './result/confetti';
import { demoClips } from './result/demo-model';
import {
  MIN_REAL_CLASSES, classCount, fetchPublicModel, fingerprint, planModel, realClips,
  type Provenance, type PublicModel,
} from './result/model-source';
import { ActionGuard, type BlockReason, type Decision, type GuardInput, type Sent } from './result/rule';
import {
  OUTCOME_UNKNOWN, UNPAIRED_TEXT, describeAction, ghostReason, recordings, sentenceOf, toastFor, type ToastText,
} from './result/text';

const HISTORY = 5;
const THINK_TIMEOUT_MS = 2600; // the shell cuts the clip at most 1.5 s after release
const SPEAK_KEY = 'ss.result.speak';
const RING_C = 2 * Math.PI * 52; // ring circumference (r = 52 in a 120 viewBox)

type Tag = { kind: 'own'; n: number; fp: string } | { kind: 'public'; n: number } | { kind: 'demo'; n: number };
type StageState = 'idle' | 'listening' | 'thinking' | 'accepted' | 'unsure' | 'nomodel';
type ChipState = 'ghost' | 'sending' | 'done' | 'dry' | 'failed' | 'unknown';
interface Seen { label: string; accepted: boolean; confidence: number }

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
  private realNow: { n: number; classes: number; fp: string } = { n: 0, classes: 0, fp: '' };
  private conn = 'connecting';
  private hello: HelloMsg | null = null; // from the current connection only
  private status: StatusMsg | null = null; // from the current connection only
  private guard = new ActionGuard();
  private history: Seen[] = [];
  private thinkTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private speak = false;
  private toast!: HTMLElement;
  private alert!: HTMLElement;

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
      else this.closeAlert();
    });
    app.bus.on('model', (m) => {
      if (m && !this.tags.has(m)) this.gen++; // another panel set a model: drop any load in flight
      this.renderModel();
      this.renderIdle();
      this.renderArmed();
    });
    app.bus.on('source', () => {
      this.hello = null;
      this.status = null;
      this.conn = 'connecting';
      this.renderArmed();
      this.renderIdle();
      if (app.mode === 'classify') void this.ensureModel(false); // fake ↔ live/replay need different models
    });
    app.bus.on('conn', (c) => {
      this.conn = c.state;
      if (c.state !== 'open') { this.hello = null; this.status = null; } // only trust what this connection says
      this.renderArmed();
    });
    app.bus.on('hello', (h) => { this.hello = h; this.renderArmed(); });
    app.bus.on('status', (s) => { this.status = s; this.renderArmed(); });
    app.bus.on('ptt', ({ down }) => this.onPtt(down));
    app.bus.on('prediction', (p) => this.onPrediction(p));
    app.bus.on('actionResult', (res) => this.showToast(toastFor(res)));
    app.store.onChange(() => { this.refreshReal(); this.renderModel(); });
    void app.store.ready.then(() => { this.refreshReal(); this.renderModel(); });
  }

  // ---------- model source ----------
  private real() { return realClips(this.app.store.all(), (id) => this.app.store.meta(id), this.app.classes.map((c) => c.id)); }

  private refreshReal() {
    const real = this.real();
    this.realNow = { n: real.length, classes: classCount(real), fp: fingerprint(real) };
  }

  private provenance(): Provenance | null {
    const m = this.app.model;
    return m ? this.tags.get(m)?.kind ?? 'other' : null;
  }

  private get ownModel(): boolean {
    const m = this.app.model;
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
    const fp = fingerprint(real);
    const tag = app.model ? this.tags.get(app.model) : undefined;
    const plan = planModel({
      fake: app.source?.kind === 'fake', realClasses: classCount(real), current: this.provenance(),
      fresh: tag?.kind === 'own' && tag.fp === fp, force,
    });
    this.trainError = null;
    if (plan === 'keep') { this.setLoading(null); return; }
    if (plan === 'demo') {
      if (!this.demo) {
        this.setLoading('Building the demo model…');
        await nextFrame();
        if (gen !== this.gen) return;
        try {
          const t0 = performance.now();
          const clips = demoClips(app.classes);
          this.demo = ml.train(clips);
          this.tags.set(this.demo, { kind: 'demo', n: clips.length });
          console.info(`[result] demo model: ${clips.length} made-up takes in ${Math.round(performance.now() - t0)} ms`);
        } catch (e) {
          console.error('[result] building the demo model failed', e);
          this.loading = null;
          this.failure = { why: 'error', message: 'The demo model didn’t build' };
          if (this.provenance() !== 'other') app.setModel(null); else this.renderModel();
          return;
        }
      }
      this.failure = null;
      this.loading = null;
      app.setModel(this.demo);
      return;
    }
    if (plan === 'train') {
      this.setLoading(`Training on your ${recordings(real.length)}…`);
      await nextFrame();
      if (gen !== this.gen) return;
      try {
        const model = ml.train(real);
        this.tags.set(model, { kind: 'own', n: real.length, fp });
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
    // No public model. Your model whose recordings are gone, or the fake data demo, shouldn't linger.
    const prov = this.provenance();
    if (prov === 'own' || prov === 'demo') app.setModel(null);
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
    if (down) { this.setState('listening', 'Listening… let go when you finish'); return; }
    this.setState('thinking', 'Reading your lips…');
    this.thinkTimer = setTimeout(() => {
      this.thinkTimer = null;
      this.setState('unsure', 'Didn’t catch that');
      this.r.guess.textContent = 'Hold Space the whole time you mouth the sentence.';
      this.r.stage.dataset.state = 'unsure';
    }, THINK_TIMEOUT_MS);
  }

  private onPrediction(p: Prediction & { clipId?: string }) {
    if (this.app.mode !== 'classify') return;
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    this.thinkTimer = null;
    const { app, r } = this;
    const accepted = p.accepted === true && p.label !== NONE;
    const conf = Number.isFinite(p.confidence) ? Math.max(0, Math.min(1, p.confidence)) : 0;
    const sentence = sentenceOf(app.classes, p.label);

    // big sentence
    r.label.dataset.label = p.label;
    r.label.dataset.accepted = accepted ? '1' : '0';
    if (accepted) {
      r.label.innerHTML = sentence.split(/\s+/).map((w, i) => `<span class="rs-w" style="--i:${i}">${esc(w)}</span>`).join(' ');
      r.guess.textContent = '';
      this.setState('accepted', 'You said');
    } else {
      r.label.innerHTML = `<span class="rs-w rs-calm">Not sure, try again</span>`;
      r.guess.textContent = p.label === NONE ? 'Looked like nothing was said.' : `Best guess: ${sentence} (${pct(conf)})`;
      this.setState('unsure', 'Not sure');
    }
    r.stage.dataset.state = accepted ? 'accepted' : 'unsure';
    r.stage.classList.remove('rs-pop');
    void r.stage.offsetWidth; // restart the glow animation
    r.stage.classList.add('rs-pop');

    // confidence ring + top 3
    r.ring.dataset.value = conf.toFixed(3);
    r.ring.dataset.accepted = accepted ? '1' : '0';
    r.ringNum.textContent = pct(conf);
    r.arc.style.strokeDashoffset = `${RING_C * (1 - conf)}`;
    const top = (Array.isArray(p.top) ? p.top : []).slice(0, 3);
    r.top.innerHTML = top.length ? top.map((t, i) => {
      const s = Number.isFinite(t.score) ? Math.max(0, Math.min(1, t.score)) : 0;
      return `<div class="rs-row" data-first="${i === 0 ? 1 : 0}" data-ok="${i === 0 && accepted ? 1 : 0}" data-label="${esc(t.label)}">
        <span class="rs-name" title="${esc(sentenceOf(app.classes, t.label))}">${esc(sentenceOf(app.classes, t.label))}</span>
        <span class="rs-track"><i style="--w:${(s * 100).toFixed(1)}%"></i></span>
        <span class="rs-pct">${pct(s)}</span></div>`;
    }).join('') : '<div class="rs-empty">No guesses</div>';

    // history
    this.history.unshift({ label: p.label, accepted, confidence: conf });
    this.history.length = Math.min(this.history.length, HISTORY);
    r.history.innerHTML = this.history.map((h, i) => {
      const s = sentenceOf(app.classes, h.label);
      return `<span class="rs-hchip${i === 0 ? ' rs-new' : ''}" data-ok="${h.accepted ? 1 : 0}" data-label="${esc(h.label)}" title="${esc(s)} · ${pct(h.confidence)}">
        <i aria-hidden="true">${h.accepted ? '✓' : '?'}</i><span>${esc(h.accepted ? s : 'Not sure')}</span></span>`;
    }).join('');

    // action (the strict rule), then moments
    const action = app.classes.find((c) => c.id === p.label)?.action ?? null;
    const input = this.guardInput({ label: p.label, accepted: p.accepted, confidence: p.confidence }, action);
    const run = this.guard.run(input, (a) => app.sendAction({ action: a, label: p.label, confidence: p.confidence }));
    this.renderChip(run.decision, action);
    if (run.sent) void run.sent.then((s) => this.onSent(s, action!));
    else if (!run.decision.send && run.decision.reason === 'unpaired') this.showToast({ kind: 'bad', title: 'Not paired', body: UNPAIRED_TEXT });
    this.renderArmed();

    if (accepted && p.label === 'demo_48h') confetti();
    if (accepted && p.label === 'help') this.openAlert(sentence, run.decision, action);
    if (accepted && this.speak) this.say(sentence);
  }

  private guardInput(pred: GuardInput['pred'], action: string | null): GuardInput {
    const { app } = this;
    return {
      mode: app.mode, source: app.source?.kind ?? null, connOpen: this.conn === 'open',
      hello: this.hello, status: this.status, ownModel: this.ownModel, pred, action, token: app.pairToken,
    };
  }

  private onSent(s: Sent, action: string) {
    if (s.error !== undefined || !s.result) {
      console.error('[result] sending the action failed', s.error);
      this.setChip('failed', `Didn’t run: ${describeAction(action)}`, 'Couldn’t reach the Mac app');
      this.showToast({ kind: 'bad', title: 'Not sent', body: 'Couldn’t reach the Mac app, so nothing happened.' });
      this.updateAlert('Couldn’t reach the Mac app.');
      return;
    }
    const res: ActionResultMsg = s.result;
    const what = describeAction(action);
    if (res.ok && !res.dryRun) {
      const t = toastFor(res);
      this.setChip('done', `${t.title === 'Your Mac is on it' ? 'On it' : 'Done'}: ${what}`, t.title === 'Your Mac is on it' ? 'Your Mac is working on it' : res.message);
      this.updateAlert('Sent. Help is on the way.');
    }
    else if (res.ok) { this.setChip('dry', `Dry run: ${what}`, 'Safe mode is on in the Mac app'); this.updateAlert('Dry run: safe mode is on, nothing was sent.'); }
    else if (OUTCOME_UNKNOWN.includes(res.error ?? '')) { this.setChip('unknown', `Maybe: ${what}`, 'No answer from the Mac. Not trying again.'); this.updateAlert('No answer from the Mac. It may have been sent.'); }
    else { this.setChip('failed', `Didn’t run: ${what}`, toastFor(res).body); this.updateAlert(`Not sent: ${toastFor(res).body}`); }
    this.renderArmed();
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
    r.label.innerHTML = `<span class="rs-w rs-calm">Hold <kbd>Space</kbd> and mouth a sentence</span>`;
    const kind = app.source?.kind;
    r.guess.textContent = kind === 'fake' ? 'Fake AirPods: pick a sentence at the top, then hold Space.'
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
      sub = tag.fp !== this.realNow.fp && this.realNow.classes >= MIN_REAL_CLASSES ? 'New recordings since. Press Re-train.' : 'Actions can run from this one';
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
    const d = this.guard.decide(this.guardInput({ label: action, accepted: true, confidence: 1 }, action));
    const live = d.send || d.reason === 'busy' || d.reason === 'too-soon';
    r.armed.dataset.live = live ? '1' : '0';
    const text = live ? 'Live: sentences run on your Mac' : `Preview only · ${ghostReason((d as { reason: BlockReason }).reason, app.source?.kind ?? null)}`;
    if (r.armedText.textContent !== text) r.armedText.textContent = text;
  }

  private renderChip(d: Decision, action: string | null) {
    if (d.send) { this.setChip('sending', `Doing: ${describeAction(d.action)}`, 'Sent to your Mac…'); return; }
    if (d.reason === 'not-accepted' || d.reason === 'no-action' || !action) { this.r.chip.hidden = true; return; }
    this.setChip('ghost', `Would: ${describeAction(action)}`, ghostReason(d.reason, this.app.source?.kind ?? null));
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
    const dismiss = this.alert.querySelector('button')!;
    dismiss.addEventListener('click', () => this.closeAlert());
    // While the alert is up, keys belong to it: Space/Enter press Dismiss, Escape closes, no push to talk.
    const keys = (e: KeyboardEvent) => {
      if (this.alert.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); this.closeAlert(); }
      if (e.code === 'Space' || e.key === 'Escape' || e.key === 'Tab') e.stopPropagation();
      if (e.key === 'Tab') { e.preventDefault(); dismiss.focus(); } // keep focus inside
    };
    this.alert.addEventListener('keydown', keys);
    this.alert.addEventListener('keyup', (e) => { if (e.code === 'Space') e.stopPropagation(); });
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
    const sub = d.send ? 'Texting your emergency contact…'
      : action ? `Would: ${describeAction(action)}. ${ghostReason(d.reason, this.app.source?.kind ?? null)}.` : '';
    a.querySelector('.rs-alert-sub')!.textContent = sub;
    a.hidden = false;
    document.body.classList.add('rs-alert-open');
    (a.querySelector('button') as HTMLButtonElement).focus();
  }

  private updateAlert(text: string) {
    if (this.alert.hidden) return;
    this.alert.querySelector('.rs-alert-sub')!.textContent = text;
  }

  private closeAlert() {
    if (this.alert.hidden) return;
    this.alert.hidden = true;
    document.body.classList.remove('rs-alert-open');
    (this.alert.querySelector('button') as HTMLButtonElement).blur();
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
