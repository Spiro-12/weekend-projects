// Visitor replay + session recorder (Track K).
// The model: there is no model loader on this branch (Track J), so tests load a real DTW model into the page
// themselves: web/src/ml is bundled with Vite's API into a script, and the model JSON comes from ml.train in Node.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { MOCK_WS } from '../../playwright.config';
import { App } from '../../web/src/core/app';
import type { ClassDef, Dataset, DtwKnnModelJSON, Session } from '../../web/src/core/contracts';
import { synthSession } from '../../web/src/core/synth';
import { validateSession } from '../../web/src/core/validate';
import * as ml from '../../web/src/ml/index';
import { mergeDatasets } from '../../web/src/ml/data';
import { verdict } from '../../web/src/panels/replay/score';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const classes = JSON.parse(read('../../shared/classes.json')) as ClassDef[];
const DEMO_TITLE = 'Replay of a real session: Spiro, AirPods Pro 3, Oct 31';
/** Adds `sec` of quiet motion at the end (copies of the last, quiet, 0.9 s), so a finished loop stays on screen a while. */
function withTail(s: Session, sec: number): Session {
  const last = s.samples.at(-1)!, dt = 0.04;
  const quiet = s.samples.filter((x) => x.t > last.t - 0.9);
  const extra = Array.from({ length: Math.round(sec / dt) }, (_, i) => ({
    ...quiet[i % quiet.length], seq: last.seq + 1 + i, t: Math.round((last.t + (i + 1) * dt) * 1e5) / 1e5,
  }));
  return { ...s, samples: [...s.samples, ...extra] };
}
/** 8 takes (each class once), 25 Hz, about 40 s: quick to watch at ?speed=8. */
const SHORT = withTail(synthSession(classes, 21, 1), 6);
const SHORT_URL = 'replay/test-short.json';

let SSML = '';
let MODEL: DtwKnnModelJSON;
test.beforeAll(async () => {
  const { build } = await import('vite');
  const out = await build({
    configFile: false, logLevel: 'silent',
    build: {
      write: false, minify: true, emptyOutDir: false, outDir: join(tmpdir(), 'ss-k-ml'),
      lib: { entry: fileURLToPath(new URL('../../web/src/ml/index.ts', import.meta.url)), formats: ['iife'], name: 'SSML', fileName: 'ssml' },
    },
  });
  const res = (Array.isArray(out) ? out[0] : out) as { output: { code?: string }[] };
  SSML = `${res.output[0].code};window.SSML = SSML;`;
  const ds = JSON.parse(read('../../shared/fixtures/dataset.synthetic.json')) as Dataset;
  MODEL = ml.train(mergeDatasets([ds]).clips).toJSON();
});

/** Records console errors, page errors and WebSockets. */
function watch(page: Page) {
  const errors: string[] = [];
  let sockets = 0;
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('websocket', () => { sockets++; });
  return { errors, sockets: () => sockets };
}

/** Puts a model into the app the moment main.ts creates it (before any source starts). */
async function withModel(page: Page, model: DtwKnnModelJSON | 'always-help') {
  if (model !== 'always-help') await page.addInitScript({ content: SSML });
  await page.addInitScript(({ json, labels }) => {
    let v: { app: { setModel(m: unknown): void } } | undefined;
    const w = window as unknown as { SSML?: { loadModel(j: unknown): unknown } };
    const stub = {
      name: 'always-help', labels,
      predict: () => ({ label: 'help', confidence: 0.9, accepted: true, top: [{ label: 'help', score: 0.9 }], ms: 0 }),
    };
    Object.defineProperty(window, '__ss', {
      configurable: true,
      get: () => v,
      set: (x) => { v = x; x.app.setModel(json ? w.SSML!.loadModel(json) : stub); },
    });
  }, { json: model === 'always-help' ? null : model, labels: classes.map((c) => c.id) });
}

const serveShort = (page: Page) => page.route(`**/${SHORT_URL}`, (r) => r.fulfill({ json: SHORT }));
/** The marks of loop 1, read on the first frame where every take has one. */
const finalStates = async (page: Page) => (await page.waitForFunction(() => {
  const s = [...document.querySelectorAll<HTMLElement>('[data-testid=replay-win]')].map((e) => e.dataset.state ?? '');
  return s.length > 0 && s.every((x) => ['right', 'wrong', 'unsure'].includes(x)) ? s : null;
}, null, { polling: 'raf', timeout: 15_000 })).jsonValue();
const score = (page: Page) => page.getByTestId('replay-score');

/** What the shell + model will make of SHORT, computed in Node with the same model JSON. */
function expectedShort(model: DtwKnnModelJSON): string[] {
  const m = ml.loadModel(model);
  const app = new App(classes, { all: () => [] } as unknown as ConstructorParameters<typeof App>[1]);
  app.setMode('classify');
  app.setModel(m);
  app.bus.emit('status', SHORT.status);
  const preds: { label: string; accepted: boolean }[] = [];
  app.bus.on('prediction', (p) => preds.push(p));
  const ptts = SHORT.events.filter((e) => e.kind === 'ptt') as { t: number; down: boolean }[];
  let e = 0;
  for (const s of SHORT.samples) {
    while (e < ptts.length && ptts[e].t < s.t) { app.ptt(ptts[e].down, ptts[e].t); e++; }
    app.bus.emit('motion', s);
  }
  expect(preds).toHaveLength(SHORT.truth.length);
  return SHORT.truth.map((w, i) => verdict(w.label, preds[i]));
}

test('a visitor (no ?mode) gets the real replay within 2 s: no console errors, no WebSocket', async ({ page }) => {
  const w = watch(page);
  await page.goto('./');
  await expect(page.getByTestId('source-pill')).toHaveText('replay · open', { timeout: 2000 });
  await expect(page.getByTestId('replay-banner')).toBeVisible();
  await expect(page.getByTestId('replay-title')).toHaveText(DEMO_TITLE);
  await expect(page.getByTestId('replay-note')).toContainText('never trained on');
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'classify'); // Recognize mode
  await expect(page.getByTestId('replay-win')).toHaveCount(16);
  await expect(page.locator('[data-panel=session-recorder]')).toBeHidden();
  // The first take starts 1.3 s in: push to talk goes down and the banner says what is being mouthed.
  await expect(page.getByTestId('replay-now')).toContainText('silently mouths', { timeout: 3000 });
  await expect(page.getByTestId('ptt')).toHaveClass(/down/);
  // Track F's public model ships with the site now: Recognize loads it for the replay.
  await expect(page.getByTestId('result-model')).toContainText("Spiro's model (public)", { timeout: 15_000 });
  await expect(page.getByTestId('replay-score-detail')).toHaveText('16 takes');
  // The now line only changes when there is something new to say (it used to be rewritten 5 times a second).
  const mutations = await page.getByTestId('replay-now').evaluate((el) => new Promise<number>((res) => {
    let n = 0;
    const mo = new MutationObserver((ms) => { n += ms.length; });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    setTimeout(() => { mo.disconnect(); res(n); }, 1500);
  }));
  expect(mutations).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => window.__ss.counts.motion ?? 0)).toBeGreaterThan(50);
  expect(w.errors).toEqual([]);
  expect(w.sockets()).toBe(0);
});

test('fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto('./');
  await expect(page.getByTestId('replay-title')).toHaveText(DEMO_TITLE);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over).toBeLessThanOrEqual(0);
  const box = await page.getByTestId('replay-banner').boundingBox();
  expect(box!.width).toBeLessThanOrEqual(375);
  await expect(page.getByTestId('replay-play')).toBeInViewport();
});

test('with a real model, every take is marked exactly as the model scores it, and the score adds up', async ({ page }) => {
  const want = expectedShort(MODEL);
  const right = want.filter((v) => v === 'right').length;
  expect(right / want.length).toBeGreaterThanOrEqual(0.75); // sanity: the synthetic model is decent
  await serveShort(page);
  await withModel(page, MODEL);
  const w = watch(page);
  await page.goto(`./?session=${SHORT_URL}&speed=8`);
  await expect(page.getByTestId('replay-title')).toHaveText(/^Replay of a simulated session \(fake motion\)/);
  await expect(page.getByTestId('replay-win')).toHaveCount(8);
  expect(await finalStates(page)).toEqual(want);
  await expect(score(page)).toHaveAttribute('data-right', String(right));
  await expect(score(page)).toHaveAttribute('data-scored', '8');
  await expect(score(page).locator('.big')).toHaveText(`${right} of 8 right`);
  await expect(page.getByTestId('replay-score-detail')).toHaveText(
    `${want.filter((v) => v === 'wrong').length} wrong · ${want.filter((v) => v === 'unsure').length} not sure · 8 takes`);
  // screen readers get one short line per finished take
  await expect(page.getByTestId('replay-live')).toHaveAttribute('aria-live', 'polite');
  await expect(page.getByTestId('replay-live')).toHaveText(/^Take \d: (right|wrong|not sure)/);
  expect(w.errors).toEqual([]);
});

test('wrong ones show as wrong (a model that always says "help")', async ({ page }) => {
  await serveShort(page);
  await withModel(page, 'always-help');
  await page.goto(`./?session=${SHORT_URL}&speed=8`);
  const want = SHORT.truth.map((t) => (t.label === 'help' ? 'right' : 'wrong'));
  expect(await finalStates(page)).toEqual(want);
  await expect(score(page).locator('.big')).toHaveText('1 of 8 right');
  await expect(page.getByTestId('replay-score-detail')).toHaveText('7 wrong · 0 not sure · 8 takes');
  await expect(page.getByTestId('replay-win').first()).toHaveAttribute('title', /heard “I need help right now”/);
});

test('without a model, finished takes are counted as not scored, never dropped', async ({ page }) => {
  await page.route('**/models/templates.json', (r) => r.fulfill({ status: 404, body: '' })); // no public model
  await serveShort(page);
  await page.goto(`./?session=${SHORT_URL}&speed=8`);
  await expect(score(page)).toHaveAttribute('data-unscored', '8', { timeout: 15_000 });
  await expect(score(page).locator('.big')).toHaveText('Waiting for the model…');
  await expect(page.getByTestId('replay-score-detail')).toHaveText('8 not scored · 8 takes');
  await expect(page.getByTestId('replay-live')).toHaveText(/^Take 8: not scored, said /);
});

test('loops forever without resetting the clock, and keeps scoring', async ({ page }) => {
  await serveShort(page);
  await withModel(page, 'always-help');
  await page.goto(`./?session=${SHORT_URL}&speed=8`);
  await expect(score(page)).toHaveAttribute('data-pass', '1', { timeout: 15_000 });
  const dur = SHORT.samples.at(-1)!.t - SHORT.samples[0].t;
  expect(await page.evaluate(() => window.__ss.app.lastT)).toBeGreaterThan(dur);
  await expect(page.getByTestId('replay-score-last')).toHaveText('last loop: 1 of 8 right', { timeout: 10_000 });
  // the ring was never reset by a clock jump, so it still holds the end of loop 1
  expect(await page.evaluate(() => window.__ss.app.ring[0].t)).toBeLessThan(dur);
  await expect(score(page)).toHaveAttribute('data-scored', /[1-8]/, { timeout: 10_000 });
});

test('2× plays twice as fast; pause stops the stream and play resumes it', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByTestId('replay-speed-1')).toHaveAttribute('aria-pressed', 'true');
  const rate = async () => {
    const a = await page.evaluate(() => window.__ss.counts.motion ?? 0);
    await page.waitForTimeout(2000);
    return ((await page.evaluate(() => window.__ss.counts.motion ?? 0)) - a) / 2;
  };
  await expect(page.getByTestId('source-pill')).toHaveText('replay · open');
  const r1 = await rate();
  expect(r1).toBeGreaterThan(40);
  expect(r1).toBeLessThan(70); // 50 Hz; the 2 s window is wall time, so a busy machine adds a little (still far below 2×)
  await page.getByTestId('replay-speed-2').click();
  await expect(page.getByTestId('replay-speed-2')).toHaveAttribute('aria-pressed', 'true');
  const r2 = await rate();
  expect(r2).toBeGreaterThan(85);
  expect(r2).toBeLessThan(115);

  await page.getByTestId('replay-play').click();
  await expect(page.getByTestId('replay-play')).toHaveAttribute('data-state', 'paused');
  await expect(page.getByTestId('replay-banner')).toHaveAttribute('data-phase', 'paused', { timeout: 2000 });
  expect(await rate()).toBe(0);
  await page.getByTestId('replay-play').click();
  await expect(page.getByTestId('replay-play')).toHaveAttribute('data-state', 'playing');
  expect(await rate()).toBeGreaterThan(85);
});

test('a missing replay file shows an error and a way out to fake data', async ({ page }) => {
  await page.goto('./?session=replay/missing.json');
  await expect(page.getByTestId('source-pill')).toHaveText('replay · closed');
  await expect(page.getByTestId('replay-error')).toContainText('Could not load the replay (the file is missing or broken).');
  await expect(page.getByTestId('replay-play')).toBeHidden();
  await page.getByTestId('replay-fallback').click();
  await expect(page.getByTestId('source-pill')).toHaveText('fake · open');
  await expect(page.getByTestId('replay-banner')).toBeHidden();
});

test('a replay file from another site is refused without loading it', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => { if (new URL(r.url()).hostname === 'evil.example') asked.push(r.url()); });
  await page.goto('./?session=https://evil.example/s.json');
  await expect(page.getByTestId('replay-error')).toContainText('must come from this site');
  expect(asked).toEqual([]);
});

test('live: the session recorder exports a session that passes validateSession and plays back', async ({ page }) => {
  await page.goto(`./?mode=live&ws=${MOCK_WS}`);
  await expect(page.getByTestId('source-pill')).toHaveText('live · open');
  await expect.poll(() => page.evaluate(() => window.__ss.app.lastHello?.app)).toBe('MockBridge');
  await expect(page.getByTestId('replay-banner')).toBeHidden();
  await expect(page.getByTestId('recorder')).toBeVisible();
  // Recognize mode with a stand-in model, so a prediction is recorded too (the mock bridge is not armed).
  await page.evaluate((labels) => {
    const app = window.__ss.app;
    app.setModel({ name: 'stub', labels, predict: () => ({ label: 'volume_up', confidence: 0.8, accepted: true, top: [], ms: 0 }) });
    app.setMode('classify');
  }, classes.map((c) => c.id));
  await page.getByTestId('recorder-record').click();
  await expect(page.getByTestId('recorder-stop')).toBeEnabled();
  const said = await page.getByTestId('recorder-prompt').getAttribute('data-label');
  expect(classes.map((c) => c.id)).toContain(said);
  await page.waitForTimeout(500);
  await page.keyboard.down('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.up('Space');
  await expect(page.getByTestId('recorder-stats')).toContainText('1 take ·');
  await expect(page.getByTestId('recorder-stats')).toContainText('1 heard');
  await expect(page.getByTestId('recorder-progress')).toHaveText('2 of 16');
  await page.waitForTimeout(500);
  await page.getByTestId('recorder-stop').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('recorder-export').click()]);
  expect(dl.suggestedFilename()).toMatch(/^ss-session-\d{8}-\d{4}\.json$/);
  const s = JSON.parse(readFileSync((await dl.path())!, 'utf8')) as Session;
  expect(validateSession(s)).toEqual([]);
  expect(s.hello.app).toBe('MockBridge');
  expect(s.samples.length).toBeGreaterThan(40);
  expect(s.truth).toHaveLength(1);
  expect(s.truth[0].label).toBe(said);
  expect(s.events.filter((e) => e.kind === 'ptt').map((e) => (e as { down: boolean }).down)).toEqual([true, false]);
  expect(s.events.filter((e) => e.kind === 'prediction')).toEqual([expect.objectContaining({ label: 'volume_up', confidence: 0.8 })]);
  await expect(page.getByTestId('recorder-msg')).toContainText('Exported');

  // ...and that file plays in the replay, with its one take scored.
  await page.route('**/replay/recorded.json', (r) => r.fulfill({ json: s }));
  await withModel(page, 'always-help');
  await page.goto('./?session=replay/recorded.json&speed=4');
  await expect(page.getByTestId('replay-title')).toHaveText(/^Replay of a simulated session/); // the mock bridge simulates
  await expect(page.getByTestId('replay-win')).toHaveCount(1);
  await expect(score(page)).toHaveAttribute('data-scored', '1', { timeout: 10_000 });
});

test('visitor: the push to talk bar is hidden in the replay, and "Try it yourself" switches to fake data in Recognize mode', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByTestId('source-pill')).toHaveText('replay · open', { timeout: 2000 });
  await expect(page.getByTestId('ptt')).toBeHidden();
  await expect(page.getByTestId('result-label')).toContainText("Watching Spiro's real session");
  await page.getByTestId('try-fake').click();
  await expect(page.getByTestId('source-pill')).toHaveText('fake · open');
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'classify');
  await expect(page.getByTestId('ptt')).toBeVisible();
  await expect(page.getByTestId('replay-note-bar')).toBeHidden();
  expect(new URL(page.url()).search).toBe('?mode=fake');
  await expect(page.getByTestId('result-model')).toContainText('Demo model', { timeout: 20_000 });
  // Nothing left over from the replay: idle, empty history.
  await expect(page.getByTestId('result-state')).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('result-history')).toContainText('Nothing yet');
  await page.getByTestId('fake-label').selectOption('calendar');
  await page.waitForTimeout(600);
  // "What's on my calendar today?" takes about 2 s to mouth; hold a little longer, like a person would. Up to 3 tries.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.down('Space');
    await page.waitForTimeout(2600);
    await page.keyboard.up('Space');
    await page.waitForTimeout(1500);
    if (/calendar/i.test((await page.getByTestId('result-label').textContent()) ?? '')) break;
    await page.waitForTimeout(800);
  }
  await expect(page.getByTestId('result-label')).toContainText('calendar', { ignoreCase: true, timeout: 5000 });
});
