// Replay banner: a slim strip on top while the replay source plays (hidden for other sources).
// Says what is playing, play/pause, 1×/2×, and a running score: every push to talk window is marked right,
// wrong or not sure against the session's truth (scoring in ./replay/score.ts). Honest by design: wrong ones
// show as wrong, and windows the model didn't run on are shown as not scored instead of being left out silently.
import './replay/replay.css';
import type { App, Panel } from '../core/app';
import { NONE } from '../core/contracts';
import { ReplaySource, SPEEDS } from '../sources/replay';
import { Scoreboard, type ScoredWindow } from './replay/score';

const RENDER_MS = 200;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "Oct 31" (UTC, so it reads the same everywhere and in tests). */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Banner title and note for a loaded session. Only a matching meta file can name a person or device. */
export function describe(src: ReplaySource): { title: string; note: string } {
  const s = src.session;
  if (!s) return { title: src.phase === 'error' ? 'Replay could not load' : 'Loading the replay…', note: '' };
  const date = shortDate(s.recordedAt);
  const m = src.meta;
  if (m?.real) return { title: `Replay of a real session: ${m.subject}, ${m.device}${date ? `, ${date}` : ''}`, note: m.note };
  if (m && !m.real) return { title: `Replay of a simulated session${date ? `, ${date}` : ''}`, note: m.note };
  // status.simulated as recorded in the file (the source itself always reports simulated to the app)
  return s.status.simulated
    ? { title: `Replay of a simulated session (fake motion)${date ? `, ${date}` : ''}`, note: '' }
    : { title: `Replay of a real recorded session${date ? `, ${date}` : ''}`, note: '' };
}

const panel: Panel = {
  id: 'replay',
  order: 1,
  title: 'Replay',
  mount(el: HTMLElement, app: App) {
    const card = el.closest('.card') as HTMLElement | null;
    card?.classList.add('wide');
    if (card) card.hidden = true;
    el.innerHTML = `
      <div class="rp" data-testid="replay-banner" data-phase="loading">
        <div class="rp-row">
          <span class="rp-badge"><i></i>Replay</span>
          <div class="rp-title"><b data-testid="replay-title">Loading the replay…</b><span class="rp-note" data-testid="replay-note"></span></div>
          <div class="rp-score" data-testid="replay-score" data-scored="0"><span class="big"></span>
            <small data-testid="replay-score-detail"></small><small data-testid="replay-score-last"></small></div>
          <div class="rp-ctl">
            <button class="rp-play" data-testid="replay-play" disabled>Pause</button>
            <div class="rp-speed" role="group" aria-label="Playback speed">
              ${SPEEDS.map((x) => `<button data-speed="${x}" data-testid="replay-speed-${x}" aria-pressed="false">${x}×</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="rp-track" data-testid="replay-track" role="img" aria-label="Takes in this replay"><span class="rp-head"></span></div>
        <div class="rp-now" data-testid="replay-now"></div>
        <div class="rp-sr" data-testid="replay-live" aria-live="polite"></div>
        <div class="rp-err" data-testid="replay-error" hidden><span></span>
          <button data-testid="replay-fallback">Use fake data instead</button></div>
      </div>`;
    const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector(sel) as T;
    const root = q('.rp'), titleEl = q('[data-testid=replay-title]'), noteEl = q('[data-testid=replay-note]');
    const scoreEl = q('[data-testid=replay-score]'), playBtn = q<HTMLButtonElement>('[data-testid=replay-play]');
    const track = q('[data-testid=replay-track]'), head = q('.rp-head'), nowEl = q('[data-testid=replay-now]');
    const errEl = q('[data-testid=replay-error]'), ctl = q('.rp-ctl'), liveEl = q('[data-testid=replay-live]');
    const detailEl = q('[data-testid=replay-score-detail]'), lastEl = q('[data-testid=replay-score-last]');
    const speedBtns = [...el.querySelectorAll<HTMLButtonElement>('.rp-speed button')];

    let src: ReplaySource | null = null;
    let off: (() => void) | null = null;
    let board = new Scoreboard();
    let segs: HTMLElement[] = [];
    let segPass = -1;
    let timer: ReturnType<typeof setInterval> | null = null;

    const sentence = (id: string) => app.classes.find((c) => c.id === id)?.sentence ?? id;
    const quoted = (id: string) => `“${esc(sentence(id))}”`;
    const pct = (c?: number) => `${Math.round((c ?? 0) * 100)}%`;
    const setText = (n: Element, t: string) => { if (n.textContent !== t) n.textContent = t; };
    // Compare with what we last set, not innerHTML (the browser normalizes entities, so that never matches).
    const lastHtml = new WeakMap<Element, string>();
    const setHtml = (n: Element, h: string) => { if (lastHtml.get(n) !== h) { lastHtml.set(n, h); n.innerHTML = h; } };

    playBtn.onclick = () => { if (!src) return; if (src.paused) src.play(); else src.pause(); render(); };
    for (const b of speedBtns) b.onclick = () => { src?.setSpeed(Number(b.dataset.speed)); render(); };
    q('[data-testid=replay-fallback]').onclick = () => { app.setSource('fake').catch((e) => console.error('[replay] fallback', e)); };

    /** Catch up the scoreboard with the source's loop count. */
    const syncPasses = () => {
      if (!src?.session) return;
      for (let p = board.pass + 1; p <= src.pass; p++) board.setPass(p, src.truthFor(p));
    };

    const attach = () => {
      off?.();
      off = null;
      src = app.source instanceof ReplaySource ? app.source : null;
      board = new Scoreboard();
      segPass = -1;
      if (card) card.hidden = !src;
      if (timer) clearInterval(timer);
      timer = null;
      if (!src) return;
      const s = src;
      off = s.onChange(() => { if (app.source === s) { syncPasses(); render(); } });
      timer = setInterval(render, RENDER_MS);
      render();
    };

    app.bus.on('source', attach);
    app.bus.on('clip', (c) => {
      if (!src?.session) return;
      syncPasses();
      const willPredict = app.mode === 'classify' && !!app.model;
      const w = board.clip(c.id, c.pressT, c.releaseT, willPredict);
      // The shell predicts right after emitting the clip. Nothing by the next microtask = the model threw.
      if (w && !willPredict) announce(w);
      if (w && willPredict) queueMicrotask(() => { board.noPrediction(c.id); if (w.state === 'unscored') announce(w); render(); });
      render();
    });
    app.bus.on('prediction', (p) => {
      const w = src ? board.prediction(p.clipId, p) : null;
      if (!w) return;
      announce(w);
      render();
    });

    /** One short line per finished take for screen readers (polite live region). */
    function announce(w: ScoredWindow) {
      const said = w.label === NONE ? 'no sentence' : sentence(w.label);
      const heard = w.predicted === NONE ? 'no sentence' : sentence(w.predicted ?? '');
      const what = w.state === 'right' ? (w.label === NONE ? 'right, nothing triggered' : `right, heard ${heard}`)
        : w.state === 'wrong' ? `wrong, heard ${heard}, said ${said}`
          : w.state === 'unsure' ? `not sure, said ${said}` : `not scored, said ${said}`;
      liveEl.textContent = `Take ${w.idx + 1}: ${what}.`;
    }
    app.bus.on('model', () => render());
    app.bus.on('mode', () => render());

    function buildSegs() {
      if (!src?.session || segPass === board.pass) return;
      segPass = board.pass;
      for (const s of segs) s.remove();
      const start = src.passStart(board.pass), dur = src.duration || 1;
      segs = board.of(board.pass).map((w) => {
        const d = document.createElement('span');
        d.className = 'rp-win';
        d.dataset.testid = 'replay-win';
        d.dataset.i = String(w.idx);
        d.style.left = `${(100 * (w.t0 - start)) / dur}%`;
        d.style.width = `${(100 * (w.t1 - w.t0)) / dur}%`;
        track.insertBefore(d, head);
        return d;
      });
    }

    function winTitle(w: ScoredWindow): string {
      const said = w.label === NONE ? 'no sentence' : `“${sentence(w.label)}”`;
      if (w.predicted === undefined) return `${w.idx + 1}. ${said}: ${w.state === 'skipped' ? 'interrupted, not scored' : w.state === 'unscored' ? 'not scored (no model)' : 'coming up'}`;
      const heard = w.predicted === NONE ? 'no sentence' : `“${sentence(w.predicted)}”`;
      return `${w.idx + 1}. ${said}: heard ${heard} ${pct(w.confidence)} (${w.state === 'unsure' ? 'not sure' : w.state})`;
    }

    function nowLine(w: ScoredWindow | null): [string, string] {
      if (!w) return ['', '<span class="muted">The first take starts in a moment.</span>'];
      const who = esc(src?.meta?.subject ?? 'The wearer');
      const said = w.label === NONE ? 'nothing (a nod, swallow or glance)' : quoted(w.label);
      const heard = w.predicted === undefined ? '' : w.predicted === NONE ? 'no sentence' : quoted(w.predicted);
      switch (w.state) {
        case 'now': return ['now', w.label === NONE
          ? `<span class="mk">●</span> ${who} isn’t saying anything this time (a nod, swallow or glance)…`
          : `<span class="mk">●</span> ${who} silently mouths ${quoted(w.label)}…`];
        case 'waiting': return ['waiting', '<span class="mk">…</span> Reading the motion…'];
        case 'right': return ['right', w.label === NONE
          ? '<span class="mk">✓</span> Right: nothing was triggered.'
          : `<span class="mk">✓</span> Right: heard ${heard} <span class="muted">${pct(w.confidence)} sure</span>`];
        case 'wrong': return ['wrong', `<span class="mk">✗</span> Wrong: heard ${heard} <span class="muted">${pct(w.confidence)} sure</span>, but ${who} said ${said}.`];
        case 'unsure': return ['unsure', `<span class="mk">?</span> Not sure, so nothing was triggered. ${who} said ${said}${heard ? ` <span class="muted">(best guess ${heard}, ${pct(w.confidence)})</span>` : ''}.`];
        case 'unscored': return ['unscored', `<span class="mk">–</span> Not scored: the model didn’t run on this one${app.model ? '' : ' (none loaded yet)'}. ${who} said ${said}.`];
        case 'skipped': return ['skipped', `<span class="mk">–</span> Interrupted, not scored. ${who} said ${said}.`];
        default: return ['', ''];
      }
    }

    function render() {
      const s = src;
      if (!s) return;
      root.dataset.phase = s.phase;
      const { title, note } = describe(s);
      setText(titleEl, title);
      setText(noteEl, note);
      noteEl.hidden = !note;
      errEl.hidden = s.phase !== 'error';
      setText(errEl.querySelector('span')!, s.phase === 'error' ? s.error : '');
      playBtn.disabled = s.phase === 'loading' || s.phase === 'error';
      ctl.hidden = s.phase === 'error';
      const paused = s.paused;
      setText(playBtn, paused ? '▶ Play' : '❚❚ Pause');
      playBtn.setAttribute('aria-label', paused ? 'Play the replay' : 'Pause the replay');
      playBtn.dataset.state = paused ? 'paused' : 'playing';
      for (const b of speedBtns) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === s.speed));
      track.hidden = nowEl.hidden = !s.session;
      if (!s.session) { setHtml(scoreEl.querySelector('.big')!, ''); setText(scoreEl.querySelector('small')!, ''); return; }

      syncPasses();
      board.update(s.headT);
      buildSegs();
      const ws = board.of(board.pass);
      ws.forEach((w, i) => {
        const d = segs[i];
        if (!d) return;
        if (d.dataset.state !== w.state) d.dataset.state = w.state;
        const t = winTitle(w);
        if (d.title !== t) { d.title = t; d.setAttribute('aria-label', t); }
      });
      head.style.left = `${100 * s.progress}%`;

      // score: this loop so far; after the first loop also the last full loop
      const sum = board.summary();
      const last = board.pass > 0 ? board.summary(board.pass - 1) : null;
      scoreEl.dataset.right = String(sum.right);
      scoreEl.dataset.wrong = String(sum.wrong);
      scoreEl.dataset.unsure = String(sum.unsure);
      scoreEl.dataset.scored = String(sum.scored);
      scoreEl.dataset.unscored = String(sum.unscored);
      scoreEl.dataset.pass = String(board.pass);
      const big = scoreEl.querySelector('.big')!;
      // Every take is accounted for: right + wrong + not sure + not scored + still to come = all takes.
      const detail = sum.scored ? [`${sum.wrong} wrong`, `${sum.unsure} not sure`] : [];
      if (sum.unscored) detail.push(`${sum.unscored} not scored`);
      detail.push(`${sum.total} takes`);
      setText(detailEl, detail.join(' · '));
      setText(lastEl, last?.done ? `last loop: ${last.right} of ${last.scored} right${last.unscored ? `, ${last.unscored} not scored` : ''}` : '');
      lastEl.hidden = !lastEl.textContent;
      if (sum.scored) setHtml(big, `<b>${sum.right}</b> of ${sum.scored} right`);
      else setHtml(big, !app.model ? 'Waiting for the model…' : app.mode !== 'classify' ? 'Switch to Recognize to score' : 'Score: first take coming up');
      const [state, html] = nowLine(board.focus());
      nowEl.dataset.state = state;
      setHtml(nowEl, html);
    }
  },
};
export default panel;
