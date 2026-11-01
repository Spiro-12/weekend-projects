// Track J: the Recognize screen. Fake mode for visitors, and the strict action rule against mock
// bridges (never the real Mac app on 8765: every test that can send checks hello.app === 'MockBridge').
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { BASE, MOCK_WS } from '../../playwright.config';
import type { PressContext } from '../../web/src/core/app';
import type { ClassDef, Dataset, Prediction } from '../../web/src/core/contracts';
import * as ml from '../../web/src/ml/index';
import { clearsBar } from '../../web/src/panels/result/rule';
import { startMockBridge, type MockBridge, type MockBridgeOpts } from '../mock-bridge';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const classes = JSON.parse(read('../../shared/classes.json')) as ClassDef[];
const synthetic = JSON.parse(read('../../shared/fixtures/dataset.synthetic.json')) as Dataset;
/** Stand in for Track F's public model (live / replay without your recordings): trained on the synthetic fixture. */
const PUBLIC_MODEL = JSON.stringify(ml.train(synthetic.clips).toJSON());
/** The same clips, as if they were real AirPods recordings: 8 sentences, 15 takes each (5 per session). */
const REAL: Dataset = { ...synthetic, source: 'airpods', session: 'real' };
/** Session s1 only: every sentence 5 times (enough for "your model"), and light on the Record panel's live accuracy check. */
const REAL_S1: Dataset = { ...REAL, clips: REAL.clips.filter((c) => c.session === 's1') };
const PRACTICE: Dataset = { ...synthetic, source: 'fake', session: 'fake-1' };

const ORIGIN = new URL(BASE).origin;
const TOKEN = '0123456789abcdef0123456789abcdef';
const OTHER_TOKEN = 'ffffffffffffffffffffffffffffffff';
const sentence = (id: string) => classes.find((c) => c.id === id)!.sentence;

function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function servePublicModel(page: Page) {
  await page.route('**/models/templates.json', (r) => r.fulfill({ body: PUBLIC_MODEL, contentType: 'application/json' }));
}

async function recognize(page: Page) {
  await page.getByTestId('mode-toggle').click();
  await expect.poll(() => page.evaluate(() => window.__ss.app.mode)).toBe('classify');
}

/**
 * A prediction straight onto the bus, as the shell emits it after a take: made by the current model,
 * with a press context for a take started now (override with `press`). A push to talk down/up is
 * announced on the bus first (the panel tracks key downs itself) without cutting a real clip.
 */
const inject = (page: Page, p: Partial<Prediction> & { label: string; press?: Partial<PressContext>; ptt?: boolean }) => page.evaluate((p) => {
  const app = window.__ss.app;
  const press: PressContext = {
    mode: 'classify', source: app.source?.kind ?? null, conn: app.connSerial, simulated: app.lastStatus?.simulated ?? null, ...p.press,
  };
  if (p.ptt !== false) { // ptt: false = the prediction of a take whose key down the panel already saw
    app.bus.emit('ptt', { down: true, t: app.lastT });
    app.bus.emit('ptt', { down: false, t: app.lastT });
  }
  app.bus.emit('prediction', {
    confidence: 0.9, accepted: p.label !== 'none', top: [{ label: p.label, score: p.confidence ?? 0.9 }], ms: 1, clipId: 'test', ...p,
    model: app.model!, press,
  });
}, p);
const accepted = (label: string, confidence = 0.92) => ({ label, confidence, accepted: true, top: [{ label, score: confidence }] });

const actionResults = (page: Page) => page.evaluate(() => window.__ss.counts.actionResult ?? 0);
/** The page's own clock (the action rule's 3 s gap runs on it, not on the test runner's). */
const pageNow = (page: Page) => page.evaluate(() => performance.now());
/** Waits until `ms` have passed on the page's clock since `since`. */
const pageWait = async (page: Page, since: number, ms: number) => {
  await expect.poll(() => page.evaluate((s) => performance.now() - s, since), { intervals: [100], timeout: ms + 10_000 }).toBeGreaterThanOrEqual(ms);
};

/** Actions may only ever go to a mock. */
async function assertMockBridge(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__ss.app.lastHello?.app ?? null)).toBe('MockBridge');
}

/** Adds clips as if recorded in this browser with real AirPods (meta origin 'recorded'), like the Record panel does. */
const addRecorded = (page: Page, ds: Dataset) => page.evaluate(async (ds) => {
  const store = window.__ss.app.store;
  await store.ready;
  for (const c of ds.clips) {
    store.add({ ...c, session: c.session ?? ds.session }, { source: 'airpods', subject: 'spiro', device: { model: 'AirPods Pro 3', loc: 'left' }, hz: 25, origin: 'recorded' });
  }
}, ds);
/** Imports a dataset file (meta origin 'imported'). */
const addImported = (page: Page, ds: Dataset) => page.evaluate(async (ds) => {
  await window.__ss.app.store.ready;
  window.__ss.app.store.load(ds);
}, ds);

/** Live page on its own mock bridge; clips in the store (default: all 8 sentences recorded here); Recognize mode on. */
async function livePage(
  page: Page, o: MockBridgeOpts, opts: { pair?: string | null; clips?: 'recorded' | 'imported' | 'none' | Dataset } = {},
): Promise<MockBridge> {
  const bridge = await startMockBridge({ port: 0, allowOrigins: [ORIGIN], utterEvery: 0, ...o });
  const pair = opts.pair === undefined ? TOKEN : opts.pair;
  await servePublicModel(page);
  await page.goto(`./?mode=live&ws=${encodeURIComponent(`ws://127.0.0.1:${bridge.port}`)}${pair ? `#pair=${pair}` : ''}`);
  await expect(page.getByTestId('source-pill')).toHaveText('live · open');
  await assertMockBridge(page);
  const clips = opts.clips ?? 'recorded';
  if (clips === 'recorded') await addRecorded(page, REAL_S1);
  else if (clips === 'imported') await addImported(page, REAL_S1);
  else if (clips !== 'none') await addRecorded(page, clips);
  await recognize(page);
  return bridge;
}

// ---------- visitors: fake mode (demo model) ----------

/** How long the fake source takes to "say" a sentence, plus a natural pause before letting go (ms). */
const UTTER_SEC: Record<string, number> = { text_mom: 1.63, volume_up: 1.2, calendar: 2.11 }; // core/synth timing
const holdMs = (id: string) => Math.round(1000 * (0.15 + UTTER_SEC[id] * 1.15 + 0.35));

/** Picks a sentence in the header, holds Space like a person would; up to 3 tries in case it's unsure. */
async function sayFake(page: Page, id: string): Promise<Prediction> {
  await page.getByTestId('fake-label').selectOption(id);
  await page.waitForTimeout(500);
  let pred: Prediction | null = null;
  for (let i = 0; i < 3 && !(pred?.accepted && pred.label === id); i++) {
    const next = page.evaluate(() => new Promise<Prediction>((res) => {
      const off = window.__ss.app.bus.on('prediction', (p) => { off(); res(p); });
    }));
    await page.keyboard.down('Space');
    await expect(page.getByTestId('result-state')).toHaveAttribute('data-state', 'listening');
    await page.waitForTimeout(holdMs(id));
    await page.keyboard.up('Space');
    pred = await next;
  }
  return pred!;
}

test('fake mode: Recognize + pick a sentence + hold Space shows that sentence, accepted (demo model, ghost chip only)', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = pageErrors(page);
  const modelRequests: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/models/')) modelRequests.push(r.url()); });
  await page.goto('./?mode=fake');
  await expect(page.getByTestId('source-pill')).toHaveText(/fake · open/);
  await expect(page.locator('.card[data-panel=result]')).toBeVisible();
  await expect(page.getByTestId('result-go')).toBeVisible(); // Record mode: an invitation
  const top = (id: string) => page.locator(`.card[data-panel=${id}]`).evaluate((el) => el.getBoundingClientRect().top);
  expect(await top('enroll')).toBeLessThan(await top('result')); // Record mode: the Record panel first
  await recognize(page);
  for (const id of ['enroll', 'status', 'charts', 'about']) expect(await top('result')).toBeLessThan(await top(id)); // Recognize: this first
  await expect(page.locator('.card[data-panel=result]')).toHaveClass(/wide/);
  await expect(page.getByTestId('result-model')).toContainText('Demo model (fake data)');
  await expect(page.getByTestId('result-model')).toHaveAttribute('data-kind', 'demo');
  await expect(page.getByTestId('result-model')).toHaveAttribute('data-demo-built', 'worker'); // built off the main thread
  await expect(page.getByTestId('result-armed')).toHaveAttribute('data-live', '0');
  await expect(page.getByTestId('result-label')).toContainText('mouth a sentence');

  for (const id of ['text_mom', 'volume_up', 'calendar']) {
    const pred = await sayFake(page, id);
    expect(pred).toMatchObject({ label: id, accepted: true });
    await expect(page.getByTestId('result-label')).toHaveText(sentence(id));
    await expect(page.getByTestId('result-label')).toHaveAttribute('data-label', id);
    await expect(page.getByTestId('result-label')).toHaveAttribute('data-accepted', '1');
    await expect(page.getByTestId('result-state')).toHaveAttribute('data-state', 'accepted');
    expect(Number(await page.getByTestId('result-confidence').getAttribute('data-value'))).toBeGreaterThanOrEqual(0.5);
    await expect(page.getByTestId('result-top').locator('.rs-row').first()).toHaveAttribute('data-label', id);
    await expect(page.getByTestId('result-history').locator('.rs-hchip').first()).toHaveAttribute('data-label', id);
  }
  const chip = page.getByTestId('result-action');
  await expect(chip).toHaveAttribute('data-state', 'ghost');
  await expect(chip).toHaveAttribute('data-reason', 'not-live');
  await expect(chip).toContainText('Would: Read out today’s calendar');
  expect(await actionResults(page)).toBe(0);
  expect(modelRequests).toEqual([]); // fake mode never needs Spiro's public model
  expect(errors).toEqual([]);
});

test('switching sources swaps the model: fake → demo, live → public, back to fake → demo', async ({ page }) => {
  await servePublicModel(page);
  await page.goto('./?mode=fake');
  await recognize(page);
  await expect(page.getByTestId('result-model')).toContainText('Demo model (fake data)');
  await page.evaluate((ws) => window.__ss.app.setSource('live', { ws }), MOCK_WS);
  await expect(page.getByTestId('source-pill')).toHaveText('live · open');
  await expect(page.getByTestId('result-model')).toContainText("Spiro's model (public)");
  await page.evaluate(() => window.__ss.app.setSource('fake'));
  await expect(page.getByTestId('result-model')).toContainText('Demo model (fake data)');
});

test('results: ring, top 3, calm "not sure" state, and the last 5 in the history', async ({ page }) => {
  await page.goto('./?mode=fake');
  await recognize(page);
  await expect(page.getByTestId('result-model')).toContainText('Demo model (fake data)');

  await inject(page, { label: 'calendar', confidence: 0.31, accepted: false,
    top: [{ label: 'calendar', score: 0.31 }, { label: 'focus_music', score: 0.2 }, { label: 'none', score: 0.1 }] });
  await expect(page.getByTestId('result-label')).toHaveText('Not sure, try again');
  await expect(page.getByTestId('result-state')).toHaveAttribute('data-state', 'unsure');
  await expect(page.getByTestId('result-stage')).toContainText(`Best guess: ${sentence('calendar')} (31%)`);
  await expect(page.getByTestId('result-confidence')).toContainText('31%');
  await expect(page.getByTestId('result-top').locator('.rs-row')).toHaveCount(3);
  await expect(page.getByTestId('result-action')).toBeHidden(); // nothing would run

  for (const id of ['volume_up', 'focus_music', 'call_back', 'calendar', 'text_mom']) await inject(page, accepted(id));
  await expect(page.getByTestId('result-label')).toHaveText(sentence('text_mom'));
  await expect(page.getByTestId('result-confidence')).toHaveAttribute('data-value', '0.920');
  const chips = page.getByTestId('result-history').locator('.rs-hchip');
  await expect(chips).toHaveCount(5); // the unsure one fell off
  expect(await chips.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.label)))
    .toEqual(['text_mom', 'calendar', 'call_back', 'focus_music', 'volume_up']);

  await inject(page, { label: 'none', confidence: 0.95, accepted: false, top: [{ label: 'none', score: 0.95 }] });
  await expect(page.getByTestId('result-label')).toHaveText('Not sure, try again');
  await expect(page.getByTestId('result-stage')).toContainText('Looked like nothing was said.');
});

// ---------- live / replay without your recordings: Spiro's public model ----------

const liveDefault = `./?mode=live&ws=${encodeURIComponent(MOCK_WS)}`; // playwright's mock: simulated, not armed

test('no public model yet: says so calmly, with no page errors', async ({ page }) => {
  const errors = pageErrors(page);
  await page.route('**/models/templates.json', (r) => r.fulfill({ status: 404, body: 'Not found' }));
  await page.goto(liveDefault);
  await expect(page.getByTestId('source-pill')).toHaveText('live · open');
  await recognize(page);
  await expect(page.getByTestId('result-model')).toHaveText(/No public model yet/);
  await expect(page.getByTestId('result-model')).toHaveAttribute('data-kind', 'missing');
  await expect(page.getByTestId('result-state')).toHaveAttribute('data-state', 'nomodel');
  expect(await page.evaluate(() => window.__ss.app.model)).toBeNull();
  await page.keyboard.down('Space');
  await page.waitForTimeout(300);
  await page.keyboard.up('Space');
  await expect(page.getByTestId('result-state')).toHaveAttribute('data-state', 'nomodel');
  expect(errors).toEqual([]);
});

test('no public model file at all (dev server answers with the page): also "No public model yet"', async ({ page }) => {
  // The site ships a public model now, so fake the missing file the way a dev server answers it: with the page.
  await page.route('**/models/templates.json', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto(liveDefault);
  await recognize(page);
  await expect(page.getByTestId('result-model')).toHaveText(/No public model yet/);
});

test('practice clips never train your model; a practice model from Record is kept but is not yours', async ({ page }) => {
  await servePublicModel(page);
  await page.goto(liveDefault);
  await expect(page.getByTestId('source-pill')).toHaveText('live · open');
  await page.evaluate(async (ds) => { await window.__ss.app.store.ready; window.__ss.app.store.load(ds); }, PRACTICE);
  await recognize(page);
  await expect(page.getByTestId('result-model')).toContainText("Spiro's model (public)");
  // Record's "Train & use it" on practice data sets its own model, then switches to Recognize.
  await page.getByTestId('mode-toggle').click();
  await page.evaluate(() => {
    const app = window.__ss.app;
    app.setModel({ name: 'practice', labels: ['text_mom'], predict: () => ({ label: 'text_mom', confidence: 0.9, accepted: true, top: [], ms: 0 }) });
    app.setMode('classify');
  });
  await expect(page.getByTestId('result-model')).toContainText('Practice model from the Record screen');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__ss.app.model?.name)).toBe('practice'); // kept, not replaced
});

// ---------- the action rule against mock bridges ----------

test('armed, paired, real AirPods, your own model: exactly one action per accepted prediction, with its toast', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = pageErrors(page);
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40 recordings/);
    await expect(page.getByTestId('result-model')).toHaveAttribute('data-kind', 'own');
    await expect(page.getByTestId('result-armed')).toHaveAttribute('data-live', '1');

    // none never sends, not even a (broken) model that calls it accepted
    await inject(page, { label: 'none', confidence: 0.97, accepted: false });
    await inject(page, { label: 'none', confidence: 0.97, accepted: true });
    await expect(page.getByTestId('result-action')).toBeHidden();
    // an unsure sentence doesn't send either
    await inject(page, { label: 'volume_up', confidence: 0.3, accepted: false });
    await page.waitForTimeout(400);
    expect(bridge.actions).toEqual([]);
    expect(await actionResults(page)).toBe(0);

    await assertMockBridge(page);
    // 1. One accepted sentence: exactly one action, with its toast.
    await inject(page, accepted('volume_up'));
    let sentAt = await pageNow(page); // the send happened before this (the prediction is handled synchronously)
    const toast = page.getByTestId('result-toast');
    const chip = page.getByTestId('result-action');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('data-kind', 'ok');
    await expect(toast).toContainText('Done on your Mac');
    await expect(toast).toContainText('Turn the Mac’s volume up');
    await expect(chip).toHaveAttribute('data-state', 'done');
    await page.waitForTimeout(500);
    expect(bridge.actions).toEqual([{ action: 'volume_up', dryRun: false }]); // exactly one
    expect(await actionResults(page)).toBe(1);

    // 2. Two accepted sentences back to back (3 s after the first): the first sends, the second is too soon.
    //    The first one's answer arrives later and must not overwrite the second one's chip.
    await pageWait(page, sentAt, 3100);
    await inject(page, accepted('focus_music'));
    sentAt = await pageNow(page);
    await inject(page, accepted('text_mom'));
    await expect(chip).toHaveAttribute('data-reason', /^(busy|too-soon)$/); // the first may still be waiting for its answer
    await expect(chip).toContainText('Would: Text Mom');
    await expect(toast).toContainText('Your Mac is on it'); // music is only STARTED when the Mac answers
    await page.waitForTimeout(300);
    await expect(chip).toHaveAttribute('data-reason', /^(busy|too-soon)$/); // not overwritten by the first one's answer
    await expect(chip).toHaveAttribute('data-state', 'ghost');
    expect(bridge.actions).toEqual([{ action: 'volume_up', dryRun: false }, { action: 'focus_music', dryRun: false }]);
    expect(await actionResults(page)).toBe(2);

    // 3. A text, once allowed again: the Mac has only STARTED sending it.
    await pageWait(page, sentAt, 3100);
    await inject(page, accepted('text_mom'));
    await expect(chip).toHaveAttribute('data-state', 'started');
    await expect(chip).toContainText('Sending: Text Mom');
    await expect(toast).toContainText('Your Mac is sending the text');
    await expect(toast).not.toContainText('Done');
    expect(bridge.actions).toHaveLength(3);
    expect(errors).toEqual([]);
  } finally {
    await bridge.close();
  }
});

test('confidence bars: "Probably" from 0.5; other actions may run from 0.5, texts need the model to be sure (0.7)', async ({ page }) => {
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40/);
    const label = page.getByTestId('result-label');
    const chip = page.getByTestId('result-action');
    const state = page.getByTestId('result-state');
    await assertMockBridge(page);
    // Below 0.5: "Not sure", nothing would run.
    await inject(page, { label: 'volume_up', confidence: 0.4, accepted: false });
    await expect(label).toHaveText('Not sure, try again');
    await expect(chip).toBeHidden();
    // 0.6, not accepted by the model: shown softly as "Probably". A text is never sent from that.
    await inject(page, { label: 'text_mom', confidence: 0.6, accepted: false });
    await expect(label).toHaveText(sentence('text_mom'));
    await expect(label).toHaveAttribute('data-probable', '1');
    await expect(state).toHaveAttribute('data-state', 'probable');
    await expect(state).toContainText('Probably');
    await expect(chip).toHaveAttribute('data-reason', 'low-confidence');
    await expect(chip).toContainText('Texts need it to be very sure');
    // Accepted by a model, but below 0.7: still no text.
    await inject(page, { label: 'call_back', confidence: 0.65, accepted: true });
    await expect(state).toHaveAttribute('data-state', 'accepted');
    await expect(chip).toHaveAttribute('data-reason', 'low-confidence');
    await page.waitForTimeout(300);
    expect(bridge.actions).toEqual([]);
    expect(await actionResults(page)).toBe(0);
    // "Probably" turning the volume up is fine: it runs.
    await inject(page, { label: 'volume_up', confidence: 0.6, accepted: false });
    await expect(state).toHaveAttribute('data-state', 'probable');
    await expect(page.getByTestId('result-toast')).toContainText('Done on your Mac');
    await page.waitForTimeout(300);
    expect(bridge.actions).toEqual([{ action: 'volume_up', dryRun: false }]);
    const chips = page.getByTestId('result-history').locator('.rs-hchip');
    expect(await chips.evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.label}:${(e as HTMLElement).dataset.ok}${(e as HTMLElement).dataset.probable}`)))
      .toEqual(['volume_up:01', 'call_back:10', 'text_mom:01', 'volume_up:00']);
  } finally {
    await bridge.close();
  }
});

test('live push to talk end to end: a real prediction sends at most one action, only if accepted', async ({ page }) => {
  test.setTimeout(60_000);
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true, utterEvery: 1 });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40/);
    await page.waitForTimeout(1200);
    const next = page.evaluate(() => new Promise<{ label: string; accepted: boolean; confidence: number; mode: string }>((res) => {
      const off = window.__ss.app.bus.on('prediction', (p) => { off(); res({ label: p.label, accepted: p.accepted, confidence: p.confidence, mode: p.press.mode }); });
    }));
    await assertMockBridge(page);
    await page.keyboard.down('Space');
    await page.waitForTimeout(2000);
    await page.keyboard.up('Space');
    const pred = await next;
    expect(pred.mode).toBe('classify');
    const action = classes.find((c) => c.id === pred.label)?.action ?? null;
    // the real rule's bar: harmless actions fire from 0.5, texts need accepted and 0.7
    const shouldSend = pred.label !== 'none' && !!action && clearsBar(action, pred);
    await page.waitForTimeout(800);
    expect(bridge.actions).toEqual(shouldSend ? [{ action, dryRun: false }] : []);
    expect(await actionResults(page)).toBe(shouldSend ? 1 : 0);
    await expect(page.getByTestId('result-label')).toHaveAttribute('data-label', pred.label);
  } finally {
    await bridge.close();
  }
});

test('a take started in Record mode and let go in Recognize mode sends nothing', async ({ page }) => {
  test.setTimeout(60_000);
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true, utterEvery: 1 });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40/);
    await expect(page.getByTestId('result-armed')).toHaveAttribute('data-live', '1');
    await page.getByTestId('mode-toggle').click(); // back to Record
    await expect.poll(() => page.evaluate(() => window.__ss.app.mode)).toBe('enroll');
    await page.waitForTimeout(800);
    const predictions = () => page.evaluate(() => window.__ss.counts.prediction ?? 0);
    const before = await predictions();
    await assertMockBridge(page);
    await page.keyboard.down('Space'); // started in Record mode
    await page.waitForTimeout(700);
    await page.getByTestId('mode-toggle').click(); // switched to Recognize while holding
    await expect.poll(() => page.evaluate(() => window.__ss.app.mode)).toBe('classify');
    await page.waitForTimeout(900);
    await page.keyboard.up('Space'); // let go in Recognize mode
    await page.waitForTimeout(2500);
    expect(await predictions()).toBe(before); // the shell doesn't even predict
    expect(bridge.actions).toEqual([]);
    expect(await actionResults(page)).toBe(0);
    // And if a prediction for such a take ever arrived, the rule blocks it.
    await inject(page, { ...accepted('volume_up'), press: { mode: 'enroll' } });
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'press-mode');
    await page.waitForTimeout(400);
    expect(bridge.actions).toEqual([]);
  } finally {
    await bridge.close();
  }
});

test('a take from another connection, or started while simulated, sends nothing', async ({ page }) => {
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40/);
    const serial = await page.evaluate(() => window.__ss.app.connSerial);
    await inject(page, { ...accepted('volume_up'), press: { conn: serial - 1 } });
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'press-changed');
    await inject(page, { ...accepted('volume_up'), press: { simulated: true } });
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'simulated');
    await inject(page, { ...accepted('volume_up'), press: { source: 'fake' } });
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'press-changed');
    // The panel's own tracking: a connection event after the key went down blocks it too.
    await page.evaluate(() => {
      const app = window.__ss.app;
      app.bus.emit('ptt', { down: true, t: app.lastT });
      app.bus.emit('conn', { state: 'open', url: 'again' });
      app.bus.emit('prediction', {
        label: 'volume_up', confidence: 0.9, accepted: true, top: [], ms: 1, clipId: 'x', model: app.model!,
        press: { mode: 'classify', source: 'live', conn: app.connSerial, simulated: false },
      });
    });
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', /press-changed|not-connected/);
    await page.waitForTimeout(400);
    expect(bridge.actions).toEqual([]);
    expect(await actionResults(page)).toBe(0);
  } finally {
    await bridge.close();
  }
});

test('not armed: ghost chip only, nothing sent', async ({ page }) => {
  const bridge = await livePage(page, { armed: false, token: TOKEN, real: true });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40/);
    await expect(page.getByTestId('result-armed')).toHaveAttribute('data-live', '0');
    await expect(page.getByTestId('result-armed')).toContainText('Safe mode');
    await inject(page, accepted('text_mom'));
    const chip = page.getByTestId('result-action');
    await expect(chip).toHaveAttribute('data-state', 'ghost');
    await expect(chip).toHaveAttribute('data-reason', 'not-armed');
    await expect(chip).toContainText('Would: Text Mom');
    await expect(chip).toContainText('turn on Armed in the Mac app');
    await page.waitForTimeout(500);
    expect(bridge.actions).toEqual([]);
    expect(await actionResults(page)).toBe(0);
    await expect(page.getByTestId('result-toast')).toBeHidden();
  } finally {
    await bridge.close();
  }
});

test('Simulate mode on the Mac: ghost chip only', async ({ page }) => {
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: false });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40/);
    await inject(page, accepted('volume_up'));
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'simulated');
    await page.waitForTimeout(500);
    expect(bridge.actions).toEqual([]);
    expect(await actionResults(page)).toBe(0);
  } finally {
    await bridge.close();
  }
});

const RECORD_ALL = 'Record all 8 sentences (5 each) to run actions';

test("Spiro's public model never runs actions, even when armed and paired", async ({ page }) => {
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true }, { clips: 'none' });
  try {
    await expect(page.getByTestId('result-model')).toContainText("Spiro's model (public)");
    await inject(page, accepted('volume_up'));
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'not-own-model');
    await expect(page.getByTestId('result-action')).toContainText(RECORD_ALL);
    await page.waitForTimeout(500);
    expect(bridge.actions).toEqual([]);
    expect(await actionResults(page)).toBe(0);
  } finally {
    await bridge.close();
  }
});

test('imported recordings make a preview model only: shown, never acts', async ({ page }) => {
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true }, { clips: 'imported' });
  try {
    await expect(page.getByTestId('result-model')).toHaveAttribute('data-kind', 'preview');
    await expect(page.getByTestId('result-model')).toContainText('Your model (preview): 40 recordings');
    await expect(page.getByTestId('result-model')).toContainText(`${RECORD_ALL} (0 of 8 done in this browser)`);
    await expect(page.getByTestId('result-armed')).toContainText(RECORD_ALL);
    await inject(page, accepted('volume_up'));
    await expect(page.getByTestId('result-label')).toHaveText(sentence('volume_up')); // still shown big
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'not-own-model');
    await page.waitForTimeout(500);
    expect(bridge.actions).toEqual([]);
    expect(await actionResults(page)).toBe(0);
  } finally {
    await bridge.close();
  }
});

test('your model also learns from imported sessions, once this browser has a full set of its own', async ({ page }) => {
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true }); // s1 recorded here: 40
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40 recordings/);
    await addImported(page, { ...REAL, session: 's2', clips: REAL.clips.filter((c) => c.session === 's2') });
    await expect(page.getByTestId('result-model')).toContainText('New recordings since. Press Re-train.');
    await page.getByTestId('result-retrain').click();
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 80 recordings/);
    await expect(page.getByTestId('result-model')).toHaveAttribute('data-kind', 'own');
    // trained to accept at the text bar, so "You said" and "sure enough to text" agree
    expect(await page.evaluate(() => (window.__ss.app.model as unknown as { toJSON(): { opts: { threshold: number } } }).toJSON().opts.threshold)).toBe(0.7);
    await expect(page.getByTestId('result-model')).toContainText('Can run actions on your Mac');
  } finally {
    await bridge.close();
  }
});

test('only 2 sentences recorded: a preview model that never acts, even for a sure, real looking prediction', async ({ page }) => {
  const two: Dataset = { ...REAL_S1, clips: REAL_S1.clips.filter((c) => c.label === 'none' || c.label === 'text_mom') };
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true }, { clips: two });
  try {
    await expect(page.getByTestId('result-model')).toContainText('Your model (preview): 10 recordings');
    await expect(page.getByTestId('result-model')).toContainText('(2 of 8 done in this browser)');
    await inject(page, accepted('text_mom', 0.99));
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'not-own-model');
    await expect(page.getByTestId('result-action')).toContainText(RECORD_ALL);
    // Recording the rest makes it ready: Re-train turns it into your model, which may act.
    await addRecorded(page, { ...REAL_S1, clips: REAL_S1.clips.filter((c) => c.label !== 'none' && c.label !== 'text_mom') });
    await expect(page.getByTestId('result-model')).toContainText('New recordings since. Press Re-train.');
    await page.getByTestId('result-retrain').click();
    await expect(page.getByTestId('result-model')).toHaveAttribute('data-kind', 'own');
    await expect(page.getByTestId('result-armed')).toHaveAttribute('data-live', '1');
    await page.waitForTimeout(300);
    expect(bridge.actions).toEqual([]);
  } finally {
    await bridge.close();
  }
});

test('replay always uses Spiro\'s public model, never your recordings', async ({ page }) => {
  await servePublicModel(page);
  await page.goto('./?mode=fake');
  await addRecorded(page, REAL_S1);
  await page.evaluate(async () => {
    const app = window.__ss.app;
    app.registerSource({ // a stand in for Track K's replay source
      kind: 'replay',
      create: (a) => ({
        kind: 'replay',
        async start() {
          a.bus.emit('conn', { state: 'open', url: 'replay' });
          a.bus.emit('status', { type: 'status', headphones: 'connected', auth: 'authorized', loc: 'left', hz: 50, gapPct: 0, clients: 1, armed: false, simulated: true });
        },
        stop() { a.bus.emit('conn', { state: 'closed', url: 'replay' }); },
      }),
    });
    await app.setSource('live', { ws: 'ws://127.0.0.1:9' }); // nowhere: no connection
  });
  await recognize(page);
  await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40/); // live: yours
  await page.evaluate(() => window.__ss.app.setSource('replay'));
  await expect(page.getByTestId('result-model')).toContainText("Spiro's model (public)");
  await expect(page.getByTestId('result-model')).toHaveAttribute('data-kind', 'public');
  // The help moment in a replay: a red flash on the stage, not a full screen modal over the demo.
  await inject(page, accepted('help'));
  await expect(page.getByTestId('result-stage')).toHaveAttribute('data-moment', 'help');
  await expect(page.getByTestId('result-alert')).toBeHidden();
  await expect(page.getByTestId('result-stage')).not.toHaveAttribute('data-moment', 'help', { timeout: 6000 });
});

test('unpaired: a wrong token gets the Mac\'s "unpaired" and the unpaired toast', async ({ page }) => {
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true }, { pair: OTHER_TOKEN });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40/);
    await inject(page, accepted('volume_up'));
    const toast = page.getByTestId('result-toast');
    await expect(toast).toHaveAttribute('data-kind', 'bad');
    await expect(page.getByTestId('result-toast-body'))
      .toHaveText("This dashboard isn't paired with your Mac app. Open it from the Mac app's link.");
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-state', 'failed');
    expect(bridge.actions).toEqual([]); // the Mac refused it
    expect(await actionResults(page)).toBe(1);
  } finally {
    await bridge.close();
  }
});

test('unpaired: with no token at all nothing is sent and the unpaired toast shows', async ({ page }) => {
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true }, { pair: null });
  try {
    expect(await page.evaluate(() => window.__ss.app.pairToken)).toBeNull();
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40/);
    await expect(page.getByTestId('result-armed')).toContainText('Open this page from the Mac app’s link');
    await inject(page, accepted('volume_up'));
    await expect(page.getByTestId('result-toast-body'))
      .toHaveText("This dashboard isn't paired with your Mac app. Open it from the Mac app's link.");
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'unpaired');
    await page.waitForTimeout(500);
    expect(bridge.actions).toEqual([]);
    expect(await actionResults(page)).toBe(0);
  } finally {
    await bridge.close();
  }
});

test('a dropped connection is never retried: one send, "may have run" toast', async ({ page }) => {
  // A bridge that takes the action and then dies without answering.
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40/);
    const sent: string[] = [];
    await page.exposeFunction('__sent', (a: string) => { sent.push(a); });
    await page.evaluate(() => {
      const src = window.__ss.app.source!;
      src.sendAction = async (r) => {
        (window as unknown as { __sent: (a: string) => void }).__sent(r.action);
        return { type: 'actionResult', id: r.id, action: r.action, ok: false, dryRun: false, error: 'disconnected', message: 'Lost the connection', ms: 3 };
      };
    });
    await inject(page, accepted('volume_up'));
    await expect(page.getByTestId('result-toast')).toContainText('No answer from the Mac');
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-state', 'unknown');
    await page.waitForTimeout(1500);
    expect(sent).toEqual(['volume_up']); // once, never again
  } finally {
    await bridge.close();
  }
});

test('Re-train picks up new recordings', async ({ page }) => {
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true }, { clips: 'none' });
  try {
    await expect(page.getByTestId('result-model')).toContainText("Spiro's model (public)");
    await addRecorded(page, { ...REAL, clips: REAL.clips.filter((c) => c.session === 's1') }); // 8 sentences × 5
    // Complete, but Spiro's model is still on: the hint says to Re-train, not to record more.
    await inject(page, accepted('volume_up'));
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'not-own-model');
    await expect(page.getByTestId('result-action')).toContainText('Re-train to use your model');
    await expect(page.getByTestId('result-armed')).toContainText('Re-train to use your model');
    await page.getByTestId('result-retrain').click();
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40 recordings/);
    await expect(page.getByTestId('result-model')).toHaveAttribute('data-kind', 'own');
    await addRecorded(page, REAL);
    await expect(page.getByTestId('result-model')).toContainText('New recordings since. Press Re-train.');
    await page.getByTestId('result-retrain').click();
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 120 recordings/);
    await expect(page.getByTestId('result-model')).not.toContainText('New recordings since');
  } finally {
    await bridge.close();
  }
});

// ---------- moments ----------

async function helpPage(page: Page) {
  await page.goto('./?mode=fake');
  await recognize(page);
  await expect(page.getByTestId('result-model')).toContainText('Demo model (fake data)');
  return page.getByTestId('result-alert');
}
const pttEvents = (page: Page) => page.evaluate(() => window.__ss.counts.ptt ?? 0);
const pttDown = (page: Page) => page.evaluate(() => window.__ss.app.pttDown);

test('help: full screen red alert with a big Dismiss; Space, Enter and Escape close it', async ({ page }) => {
  const alert = await helpPage(page);
  await inject(page, { label: 'help', confidence: 0.4, accepted: false });
  await expect(alert).toBeHidden(); // only when it's sure
  await inject(page, { label: 'help', confidence: 0.65, accepted: true });
  await expect(alert).toBeHidden(); // as sure as a text must be: accepted and 0.7
  await expect(page.getByTestId('result-label')).toHaveText(sentence('help')); // but it is shown
  await inject(page, accepted('help'));
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(sentence('help'));
  await expect(alert).toContainText('Would: Text your emergency contact');
  await expect(alert).not.toContainText('on the way');
  const box = await alert.boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.width).toBeGreaterThanOrEqual(vp.width - 1);
  expect(box!.height).toBeGreaterThanOrEqual(vp.height - 1);
  await expect(page.getByTestId('result-alert-dismiss')).toBeFocused();
  const n = await pttEvents(page);
  await page.keyboard.press('Space'); // presses Dismiss, not push to talk
  await expect(alert).toBeHidden();
  expect(await pttEvents(page)).toBe(n);
  for (const key of ['Escape', 'Enter']) {
    await inject(page, accepted('help'));
    await expect(alert).toBeVisible();
    const m = await pttEvents(page);
    await page.keyboard.press(key);
    await expect(alert).toBeHidden();
    expect(await pttEvents(page)).toBe(m);
  }
  await inject(page, accepted('help'));
  await page.getByTestId('result-alert-dismiss').click();
  await expect(alert).toBeHidden();
});

test('help alert: push to talk held when it opens is ended, can\'t act behind it, and its key up is not swallowed', async ({ page }) => {
  // Live, armed, paired, your model: the worst case for a take cut short by the alert.
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true, utterEvery: 1 });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40/);
    const alert = page.getByTestId('result-alert');
    const predictions = () => page.evaluate(() => window.__ss.counts.prediction ?? 0);
    await page.waitForTimeout(500);
    await page.keyboard.down('Space');
    await expect.poll(() => pttDown(page)).toBe(true);
    await page.waitForTimeout(800);
    const before = await predictions();
    // The alert opens while Space is still held (this help itself is blocked: started while simulated).
    await inject(page, { ...accepted('help'), press: { simulated: true }, ptt: false });
    await expect(alert).toBeVisible();
    expect(await pttDown(page)).toBe(false); // the take was ended...
    await expect.poll(predictions, { timeout: 5000 }).toBeGreaterThanOrEqual(before + 2); // ...and the shell predicted it
    // ...but nothing from that take may act behind the alert: a late, sure prediction for it is blocked.
    await inject(page, { ...accepted('volume_up'), ptt: false });
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'press-changed');
    await expect(page.getByTestId('result-action')).toContainText('Say it again');
    await page.waitForTimeout(500);
    expect(bridge.actions).toEqual([]);
    expect(await actionResults(page)).toBe(0);
    await page.keyboard.up('Space'); // the key up of a press that started before the alert
    await page.waitForTimeout(300);
    await expect(alert).toBeVisible(); // ...does not close it
    expect(await pttDown(page)).toBe(false);
    await page.keyboard.press('Space'); // a press on the alert does
    await expect(alert).toBeHidden();
    expect(await pttDown(page)).toBe(false);
    // After the alert, a fresh take is fine again.
    await inject(page, accepted('volume_up'));
    await expect(page.getByTestId('result-toast')).toContainText('Done on your Mac');
    await page.waitForTimeout(300);
    expect(bridge.actions).toEqual([{ action: 'volume_up', dryRun: false }]);
  } finally {
    await bridge.close();
  }
});

test('help alert: nothing behind it works (inert, no push to talk button, focus stays on Dismiss)', async ({ page }) => {
  const alert = await helpPage(page);
  const ptt = page.getByTestId('ptt');
  const pttBox = (await ptt.boundingBox())!;
  await inject(page, accepted('help'));
  await expect(alert).toBeVisible();
  // Header and panels are inert while it is open.
  const inert = () => page.evaluate(() => ['header.top', 'main'].map((s) => (document.querySelector(s) as HTMLElement).inert));
  expect(await inert()).toEqual([true, true]);
  // Clicking where the push to talk button is (behind the alert) does nothing.
  const n = await pttEvents(page);
  await page.mouse.move(pttBox.x + pttBox.width / 2, pttBox.y + pttBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(300);
  expect(await pttDown(page)).toBe(false);
  await page.mouse.up();
  expect(await pttEvents(page)).toBe(n);
  // Clicks elsewhere on the alert keep focus on Dismiss.
  await page.mouse.click(20, vpHeight(page) - 20);
  await expect(page.getByTestId('result-alert-dismiss')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('result-alert-dismiss')).toBeFocused();
  // Space still dismisses (focus never left), and everything works again after.
  await page.keyboard.press('Space');
  await expect(alert).toBeHidden();
  expect(await inert()).toEqual([false, false]);
  await page.keyboard.down('Space');
  await expect.poll(() => pttDown(page)).toBe(true);
  await page.keyboard.up('Space');
});
const vpHeight = (page: Page) => page.viewportSize()!.height;

test('demo_48h throws confetti; "Say it out loud" (off by default) speaks the sentence', async ({ page }) => {
  await page.addInitScript(() => {
    const said: string[] = [];
    (window as unknown as { __said: string[] }).__said = said;
    speechSynthesis.speak = (u: SpeechSynthesisUtterance) => { said.push(u.text); };
  });
  await page.goto('./?mode=fake');
  await recognize(page);
  await expect(page.getByTestId('result-model')).toContainText('Demo model (fake data)');
  await inject(page, accepted('demo_48h'));
  await expect(page.getByTestId('result-confetti')).toBeAttached();
  expect(await page.getByTestId('result-confetti').evaluate((c: HTMLCanvasElement) => c.width)).toBe(page.viewportSize()!.width); // DPR 1
  await expect(page.getByTestId('result-confetti')).not.toBeAttached({ timeout: 6000 }); // cleans up
  const said = () => page.evaluate(() => (window as unknown as { __said: string[] }).__said);
  expect(await said()).toEqual([]); // off by default
  await expect(page.getByTestId('result-speak')).not.toBeChecked();
  await page.locator('.rs-speak').click();
  await expect(page.getByTestId('result-speak')).toBeChecked();
  await expect(page.getByTestId('result-speak')).not.toBeFocused(); // Space stays push to talk
  await inject(page, accepted('volume_up'));
  await inject(page, { label: 'calendar', confidence: 0.2, accepted: false });
  expect(await said()).toEqual([sentence('volume_up')]); // only sure results
  expect(await page.evaluate(() => localStorage.getItem('ss.result.speak'))).toBe('1');
});
