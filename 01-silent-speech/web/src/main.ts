// Shell: wires the App to the page. Panels (./panels/*.ts) and sources (./sources/*.ts) load themselves.
import './styles.css';
import classesJson from '../../shared/classes.json';
import { App, type Panel, type SourceDef, type SourceKind } from './core/app';
import type { ClassDef } from './core/contracts';
import { createStore } from './store';

const classes = classesJson as ClassDef[];
const app = new App(classes, createStore());
const params = Object.fromEntries(new URLSearchParams(location.search));

declare global { interface Window { __ss: { app: App; counts: App['counts'] } } }
window.__ss = { app, counts: app.counts };

for (const mod of Object.values(import.meta.glob<{ default: SourceDef }>('./sources/*.ts', { eager: true }))) {
  if (mod.default?.kind) app.registerSource(mod.default);
}

// ---------- header ----------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const pill = $('[data-testid=source-pill]');
const hzEl = $('[data-testid=hz-browser]');
const nEl = $('[data-testid=sample-count]');
const pttBtn = $<HTMLButtonElement>('[data-testid=ptt]');
const modeBtn = $<HTMLButtonElement>('[data-testid=mode-toggle]');
const fakeSel = $<HTMLSelectElement>('[data-testid=fake-label]');

let conn = 'connecting';
const renderPill = () => {
  const kind = app.source?.kind ?? '…';
  pill.textContent = `${kind} · ${conn}`;
  pill.dataset.state = conn;
  pill.dataset.kind = kind;
  fakeSel.hidden = kind !== 'fake' || app.mode === 'enroll'; // in Record mode the enroll panel picks the fake sentence
};
app.bus.on('conn', (c) => { conn = c.state; renderPill(); });
app.bus.on('source', renderPill);

const arrivals: number[] = [];
app.bus.on('motion', () => {
  const now = performance.now();
  arrivals.push(now);
  while (arrivals.length && arrivals[0] < now - 2000) arrivals.shift();
});
setInterval(() => {
  const now = performance.now();
  while (arrivals.length && arrivals[0] < now - 2000) arrivals.shift(); // also trims when data stops
  hzEl.textContent = `${(arrivals.length / 2).toFixed(1)} Hz`;
  nEl.textContent = String(app.counts.motion ?? 0);
}, 250);

fakeSel.innerHTML = `<option value="">random sentence</option>` +
  classes.map((c) => `<option value="${c.id}">${c.sentence}</option>`).join('');
fakeSel.onchange = () => { app.fakeLabel = fakeSel.value || null; fakeSel.blur(); };

const renderMode = () => {
  modeBtn.textContent = app.mode === 'enroll' ? 'Mode: Record' : 'Mode: Recognize';
  document.body.dataset.mode = app.mode;
};
modeBtn.onclick = () => app.setMode(app.mode === 'enroll' ? 'classify' : 'enroll');
app.bus.on('mode', renderMode);
app.bus.on('mode', renderPill);
renderMode();

// ---------- push to talk ----------
const typing = (e: Event) => (e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]');
// In a replay the recording presses push to talk itself; the visitor's Space, clicks and window blur must not.
const replaying = () => app.source?.kind === 'replay';
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || typing(e) || replaying()) return;
  e.preventDefault();
  app.ptt(true);
});
addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || (typing(e) && !app.pttDown) || replaying()) return;
  e.preventDefault();
  app.ptt(false);
});
addEventListener('blur', () => { if (!replaying()) app.ptt(false); });
pttBtn.addEventListener('pointerdown', (e) => { if (replaying()) return; e.preventDefault(); pttBtn.setPointerCapture(e.pointerId); app.ptt(true); });
pttBtn.addEventListener('pointerup', () => { if (!replaying()) app.ptt(false); });
pttBtn.addEventListener('pointercancel', () => { if (!replaying()) app.ptt(false); });
// In a replay the push to talk bar is hidden; a note (not inside the button) offers fake data instead.
const replayNote = document.createElement('div');
replayNote.className = 'replay-note';
replayNote.dataset.testid = 'replay-note-bar';
replayNote.hidden = true;
replayNote.innerHTML = `<span>Watching a replay of a real recorded session.</span> <button class="ghost" data-testid="try-fake">Try it yourself with fake data</button>`;
pttBtn.after(replayNote);
(replayNote.querySelector('[data-testid=try-fake]') as HTMLButtonElement).onclick = () => {
  history.replaceState(null, '', `${location.pathname}?mode=fake`);
  app.setSource('fake').then(() => app.setMode('classify')).catch((e) => console.error('[source fake]', e));
};
app.bus.on('source', (k) => {
  const r = k === 'replay';
  pttBtn.hidden = r;
  replayNote.hidden = !r;
});
app.bus.on('ptt', ({ down }) => {
  pttBtn.classList.toggle('down', down);
  document.body.classList.toggle('ptt-down', down);
});

// ---------- panels ----------
const grid = $('#panels');
const panels = Object.values(import.meta.glob<{ default: Panel }>('./panels/*.ts', { eager: true }))
  .map((m) => m.default)
  .filter((p) => p?.id)
  .sort((a, b) => a.order - b.order);
for (const p of panels) {
  const card = document.createElement('section');
  card.className = 'card';
  card.dataset.panel = p.id;
  card.innerHTML = `<h2>${p.title}</h2><div class="body"></div>`;
  grid.append(card);
  try { p.mount(card.querySelector('.body') as HTMLElement, app); } catch (e) { console.error(`[panel ${p.id}]`, e); }
}

// ---------- pick a source ----------
// ?mode=live|fake|replay forces one. Otherwise only people who have used the Mac app before
// (remembered flag) get a 1.5 s live probe; public visitors go straight to replay (or fake).
// This avoids a "local network access" prompt for every visitor.
const LIVE_FLAG = 'ss.liveSeen';
const store = { // localStorage throws for visitors who block site data
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
app.bus.on('hello', () => { if (app.source?.kind === 'live') store.set(LIVE_FLAG, '1'); });

// Pairing: the Mac app opens this page with #pair=<token>. The token lives in memory only (never in
// localStorage: every page on spiro-12.github.io shares that storage), then it's removed from the address bar.
// Reloading or reopening the tab means opening the dashboard from the Mac app again.
const pairMatch = /(?:^#|&)pair=([0-9a-f]{16,128})(?:&|$)/i.exec(location.hash);
try { localStorage.removeItem('ss.pair'); } catch { /* old builds stored it; clean up */ }
if (pairMatch) {
  app.pairToken = pairMatch[1].toLowerCase();
  store.set(LIVE_FLAG, '1'); // came from the Mac app: probe live next time too
  history.replaceState(null, '', location.pathname + location.search);
}

async function pickSource() {
  const forced = params.mode as SourceKind | undefined;
  if (forced && app.sources.has(forced)) return app.setSource(forced, params);
  if (app.sources.has('live') && store.get(LIVE_FLAG) === '1') {
    const gotHello = new Promise<boolean>((res) => {
      const off = app.bus.on('hello', () => { off(); res(true); });
      setTimeout(() => { off(); res(false); }, 1500);
    });
    // Not awaited: start() must not block or throw, but don't trust it.
    app.setSource('live', params).catch((e) => console.error('[source live]', e));
    if (await gotHello) return;
  }
  return app.setSource(app.sources.has('replay') ? 'replay' : 'fake', params);
}
pickSource().catch((e) => console.error('[source]', e));
