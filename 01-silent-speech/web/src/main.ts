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
  fakeSel.hidden = kind !== 'fake';
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
  hzEl.textContent = `${(arrivals.length / 2).toFixed(1)} Hz`;
  nEl.textContent = String(app.counts.motion ?? 0);
}, 250);

fakeSel.innerHTML = `<option value="">random sentence</option>` +
  classes.map((c) => `<option value="${c.id}">${c.sentence}</option>`).join('');
fakeSel.onchange = () => { app.fakeLabel = fakeSel.value || null; };

const renderMode = () => {
  modeBtn.textContent = app.mode === 'enroll' ? 'Mode: Record' : 'Mode: Recognize';
  document.body.dataset.mode = app.mode;
};
modeBtn.onclick = () => app.setMode(app.mode === 'enroll' ? 'classify' : 'enroll');
app.bus.on('mode', renderMode);
renderMode();

// ---------- push to talk ----------
const typing = (e: Event) => (e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]');
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || typing(e)) return;
  e.preventDefault();
  app.ptt(true);
});
addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || typing(e)) return;
  e.preventDefault();
  app.ptt(false);
});
addEventListener('blur', () => app.ptt(false));
pttBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); pttBtn.setPointerCapture(e.pointerId); app.ptt(true); });
pttBtn.addEventListener('pointerup', () => app.ptt(false));
pttBtn.addEventListener('pointercancel', () => app.ptt(false));
app.bus.on('ptt', ({ down }) => {
  pttBtn.classList.toggle('down', down);
  document.body.classList.toggle('ptt', down);
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
// ?mode=live|fake|replay forces one. Otherwise: try live for 1.5 s, then replay, then fake.
async function pickSource() {
  const forced = params.mode as SourceKind | undefined;
  if (forced && app.sources.has(forced)) return app.setSource(forced, params);
  if (app.sources.has('live')) {
    const gotHello = new Promise<boolean>((res) => {
      const off = app.bus.on('hello', () => { off(); res(true); });
      setTimeout(() => { off(); res(false); }, 1500);
    });
    await app.setSource('live', params);
    if (await gotHello) return;
  }
  return app.setSource(app.sources.has('replay') ? 'replay' : 'fake', params);
}
pickSource().catch((e) => console.error('[source]', e));
