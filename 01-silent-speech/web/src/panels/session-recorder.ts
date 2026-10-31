// Session recorder: in live mode, Record session / Stop / Export captures a whole run (motion, push to talk,
// predictions, action results) into an ss-session file, the format the visitor replay plays (PROTOCOL §4).
// For Phase 3's demo run. It prompts the sentence to say next, so every take gets a truth label and the replay
// can mark it right or wrong. Hidden unless the source is live (or a recording is waiting to be exported).
import './session-recorder/recorder.css';
import type { App, Panel } from '../core/app';
import { NONE } from '../core/contracts';
import { demoScript, MAX_SEC, SessionRecorder, sessionFileName } from './session-recorder/recorder';

const NONE_PROMPT = "Keep your mouth closed and still. Don't say anything.";

const fmtTime = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

const panel: Panel = {
  id: 'session-recorder',
  order: 60,
  title: 'Session recorder',
  mount(el: HTMLElement, app: App) {
    const card = el.closest('.card') as HTMLElement | null;
    if (card) card.hidden = true;
    el.innerHTML = `
      <div class="sr" data-testid="recorder" data-rec="0">
        <p>Records a whole run (motion, push to talk, what the model heard, actions) as a replay file for the website.
          Say each sentence when it's shown, so the replay can score it.</p>
        <div class="sr-btns">
          <button class="rec" data-testid="recorder-record">Record session</button>
          <button data-testid="recorder-stop" disabled>Stop</button>
          <button class="primary" data-testid="recorder-export" disabled>Export</button>
          <span class="sr-stats" data-testid="recorder-stats"></span>
        </div>
        <div class="sr-prompt" data-testid="recorder-prompt-box" hidden>
          <span class="k">Say next</span>
          <span class="s" data-testid="recorder-prompt"></span>
          <div class="row"><span data-testid="recorder-progress"></span>
            <button data-testid="recorder-skip">Skip</button>
            <button data-testid="recorder-undo" disabled>Undo last take</button></div>
        </div>
        <div class="sr-msg" data-testid="recorder-msg"></div>
      </div>`;
    const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector(sel) as T;
    const root = q('.sr');
    const recBtn = q<HTMLButtonElement>('[data-testid=recorder-record]');
    const stopBtn = q<HTMLButtonElement>('[data-testid=recorder-stop]');
    const expBtn = q<HTMLButtonElement>('[data-testid=recorder-export]');
    const stats = q('[data-testid=recorder-stats]');
    const promptBox = q('[data-testid=recorder-prompt-box]'), promptEl = q('[data-testid=recorder-prompt]');
    const progress = q('[data-testid=recorder-progress]');
    const skipBtn = q<HTMLButtonElement>('[data-testid=recorder-skip]'), undoBtn = q<HTMLButtonElement>('[data-testid=recorder-undo]');
    const msgEl = q('[data-testid=recorder-msg]');

    const rec = new SessionRecorder();
    let script: string[] = [];
    let idx = 0;
    let exported = true; // nothing to lose yet
    let conn = 'closed';

    const say = (kind: 'ok' | 'bad' | 'warn' | 'info', text: string) => { msgEl.dataset.kind = kind; msgEl.textContent = text; };
    const isLive = () => app.source?.kind === 'live';
    const canRecord = () => isLive() && conn === 'open' && !!app.lastHello && !!app.lastStatus;
    const current = () => script[idx] ?? null;
    const sentence = (id: string) => (id === NONE ? NONE_PROMPT : app.classes.find((c) => c.id === id)?.sentence ?? id);

    recBtn.onclick = () => {
      if (!canRecord() || rec.recording) return;
      rec.start(app.lastHello!, app.lastStatus!);
      script = demoScript(app.classes);
      idx = 0;
      exported = false;
      say('info', app.mode === 'classify' ? 'Recording.' : 'Recording. Tip: switch to Recognize mode so what the model hears is saved too.');
      render();
    };
    const stop = (why?: string) => {
      if (!rec.recording) return;
      rec.stop();
      if (rec.statusChanged) say('warn', 'Stopped. The sensor bud or Simulate changed during the recording; the file keeps the first setting. Consider recording again.');
      else say('ok', why ?? `Stopped. ${rec.nTakes} takes. Press Export to save the file.`);
      render();
    };
    stopBtn.onclick = () => stop();
    expBtn.onclick = () => {
      const r = rec.export();
      if (!r.ok) { say('bad', `Can't export: ${r.errors.slice(0, 2).join('; ')}`); return; }
      const url = URL.createObjectURL(new Blob([r.text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = sessionFileName();
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      exported = true;
      say('ok', `Exported ${a.download} (${Math.round(r.text.length / 1024)} KB, ${r.session.truth.length} scored takes).`);
      render();
    };
    skipBtn.onclick = () => { if (!rec.pttOpen && idx < script.length) { idx++; render(); } skipBtn.blur(); };
    undoBtn.onclick = () => {
      const r = rec.undoLast();
      if (r && r.label !== null && idx > 0) idx--;
      if (r) say('info', 'Last take removed. Say it again.');
      undoBtn.blur();
      render();
    };

    app.bus.on('conn', (c) => { conn = c.state; render(); });
    app.bus.on('hello', () => render()); // Record needs a hello and a status first
    app.bus.on('status', (st) => { rec.onStatus(st); if (recBtn.disabled !== (rec.recording || !canRecord())) render(); });
    app.bus.on('source', () => {
      if (rec.recording && !isLive()) stop('Stopped: the dashboard left live mode. Press Export to save what was recorded.');
      render();
    });
    app.bus.on('motion', (s) => {
      if (!rec.recording) return;
      if (!rec.motion(s)) stop(`Stopped at the ${MAX_SEC / 60} minute limit. Press Export to save the file.`);
    });
    app.bus.on('ptt', ({ down, t }) => {
      if (!rec.recording) return;
      if (down) { rec.ptt(true, t, current()); return; }
      const before = rec.nTakes;
      rec.ptt(false, t);
      if (rec.nTakes > before && current() !== null) idx++;
      render();
    });
    app.bus.on('prediction', (p) => rec.prediction(p.label, p.confidence, app.lastT));
    app.bus.on('actionResult', (r) => rec.action(r.action, r.ok, app.lastT));

    function render() {
      if (card) card.hidden = !isLive() && (exported || !rec.hasData);
      root.dataset.rec = rec.recording ? '1' : '0';
      recBtn.disabled = rec.recording || !canRecord();
      recBtn.textContent = rec.hasData && !rec.recording ? 'Record again (replaces this one)' : 'Record session';
      stopBtn.disabled = !rec.recording;
      expBtn.disabled = rec.recording || !rec.hasData;
      const parts = rec.hasData
        ? [fmtTime(rec.seconds), `${rec.nTakes} takes`, `${rec.samples.length.toLocaleString('en-US')} samples`, `${rec.nPredictions} heard`]
        : [canRecord() ? 'Ready' : 'Connect the Mac app to record'];
      if (rec.nActions) parts.push(`${rec.nActions} actions`);
      stats.textContent = parts.join(' · ');
      promptBox.hidden = !rec.recording;
      const cur = current();
      promptEl.textContent = cur ? sentence(cur) : 'All done. Press Stop, then Export.';
      promptEl.dataset.label = cur ?? '';
      progress.textContent = script.length ? `${Math.min(idx + 1, script.length)} of ${script.length}` : '';
      skipBtn.disabled = !cur || rec.pttOpen;
      undoBtn.disabled = !rec.nTakes || rec.pttOpen;
    }
    render();
    setInterval(() => { if (rec.recording) render(); }, 500);
  },
};
export default panel;
