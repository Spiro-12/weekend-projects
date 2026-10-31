// Track J: the Recognize screen. Fake mode for visitors, and the strict action rule against mock
// bridges (never the real Mac app on 8765: every test that can send checks hello.app === 'MockBridge').
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { BASE, MOCK_WS } from '../../playwright.config';
import type { ClassDef, Dataset, Prediction } from '../../web/src/core/contracts';
import * as ml from '../../web/src/ml/index';
import { startMockBridge, type MockBridge, type MockBridgeOpts } from '../mock-bridge';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const classes = JSON.parse(read('../../shared/classes.json')) as ClassDef[];
const synthetic = JSON.parse(read('../../shared/fixtures/dataset.synthetic.json')) as Dataset;
/** Stand in for Track F's public model (live / replay without your recordings): trained on the synthetic fixture. */
const PUBLIC_MODEL = JSON.stringify(ml.train(synthetic.clips).toJSON());
/** The same clips, as if recorded with real AirPods (store meta source 'airpods'). */
const REAL: Dataset = { ...synthetic, source: 'airpods', session: 'real' };
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

/** A prediction straight onto the bus, as the shell emits it after a clip. */
const inject = (page: Page, p: Partial<Prediction> & { label: string }) => page.evaluate((p) => {
  window.__ss.app.bus.emit('prediction', {
    confidence: 0.9, accepted: p.label !== 'none', top: [{ label: p.label, score: p.confidence ?? 0.9 }], ms: 1, clipId: 'test', ...p,
  });
}, p);
const accepted = (label: string, confidence = 0.92) => ({ label, confidence, accepted: true, top: [{ label, score: confidence }] });

const actionResults = (page: Page) => page.evaluate(() => window.__ss.counts.actionResult ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Actions may only ever go to a mock. */
async function assertMockBridge(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__ss.app.lastHello?.app ?? null)).toBe('MockBridge');
}

/** Live page on its own mock bridge; real AirPods clips in the store; Recognize mode on. */
async function livePage(page: Page, o: MockBridgeOpts, opts: { pair?: string | null; realClips?: boolean } = {}): Promise<MockBridge> {
  const bridge = await startMockBridge({ port: 0, allowOrigins: [ORIGIN], utterEvery: 0, ...o });
  const pair = opts.pair === undefined ? TOKEN : opts.pair;
  await servePublicModel(page);
  await page.goto(`./?mode=live&ws=${encodeURIComponent(`ws://127.0.0.1:${bridge.port}`)}${pair ? `#pair=${pair}` : ''}`);
  await expect(page.getByTestId('source-pill')).toHaveText('live · open');
  await assertMockBridge(page);
  if (opts.realClips ?? true) {
    await page.evaluate(async (ds) => { await window.__ss.app.store.ready; window.__ss.app.store.load(ds); }, REAL);
  }
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
  await page.goto(liveDefault); // vite preview serves index.html for the missing file
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
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 120 recordings/);
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
    const t0 = Date.now();
    await inject(page, accepted('volume_up'));
    const toast = page.getByTestId('result-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('data-kind', 'ok');
    await expect(toast).toContainText('Done on your Mac');
    await expect(toast).toContainText('Mock ran volume_up');
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-state', 'done');
    await page.waitForTimeout(500);
    expect(bridge.actions).toEqual([{ action: 'volume_up', dryRun: false }]); // exactly one
    expect(await actionResults(page)).toBe(1);

    // Another accepted sentence within 3 s: ghost chip, nothing sent
    await inject(page, accepted('focus_music'));
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'too-soon');
    await expect(page.getByTestId('result-action')).toContainText('Would: Play focus music');
    expect(bridge.actions).toHaveLength(1);

    // After 3 s it sends again, once.
    await sleep(Math.max(0, 3100 - (Date.now() - t0)));
    await inject(page, accepted('focus_music'));
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-state', 'done');
    await expect(toast).toContainText('Mock ran focus_music');
    await page.waitForTimeout(300);
    expect(bridge.actions).toEqual([{ action: 'volume_up', dryRun: false }, { action: 'focus_music', dryRun: false }]);
    expect(await actionResults(page)).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await bridge.close();
  }
});

test('live push to talk end to end: a real prediction sends at most one action, only if accepted', async ({ page }) => {
  test.setTimeout(60_000);
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true, utterEvery: 1 });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model/);
    await page.waitForTimeout(1200);
    const next = page.evaluate(() => new Promise<{ label: string; accepted: boolean }>((res) => {
      const off = window.__ss.app.bus.on('prediction', (p) => { off(); res({ label: p.label, accepted: p.accepted }); });
    }));
    await assertMockBridge(page);
    await page.keyboard.down('Space');
    await page.waitForTimeout(2000);
    await page.keyboard.up('Space');
    const pred = await next;
    const action = classes.find((c) => c.id === pred.label)?.action ?? null;
    const shouldSend = pred.accepted && pred.label !== 'none' && !!action;
    await page.waitForTimeout(800);
    expect(bridge.actions).toEqual(shouldSend ? [{ action, dryRun: false }] : []);
    expect(await actionResults(page)).toBe(shouldSend ? 1 : 0);
    await expect(page.getByTestId('result-label')).toHaveAttribute('data-label', pred.label);
  } finally {
    await bridge.close();
  }
});

test('not armed: ghost chip only, nothing sent', async ({ page }) => {
  const bridge = await livePage(page, { armed: false, token: TOKEN, real: true });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model/);
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
    await expect(page.getByTestId('result-model')).toHaveText(/Your model/);
    await inject(page, accepted('volume_up'));
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'simulated');
    await page.waitForTimeout(500);
    expect(bridge.actions).toEqual([]);
    expect(await actionResults(page)).toBe(0);
  } finally {
    await bridge.close();
  }
});

test("Spiro's public model never runs actions, even when armed and paired", async ({ page }) => {
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true }, { realClips: false });
  try {
    await expect(page.getByTestId('result-model')).toContainText("Spiro's model (public)");
    await inject(page, accepted('volume_up'));
    await expect(page.getByTestId('result-action')).toHaveAttribute('data-reason', 'not-own-model');
    await expect(page.getByTestId('result-action')).toContainText('Only your own model can run actions');
    await page.waitForTimeout(500);
    expect(bridge.actions).toEqual([]);
    expect(await actionResults(page)).toBe(0);
  } finally {
    await bridge.close();
  }
});

test('unpaired: a wrong token gets the Mac\'s "unpaired" and the unpaired toast', async ({ page }) => {
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true }, { pair: OTHER_TOKEN });
  try {
    await expect(page.getByTestId('result-model')).toHaveText(/Your model/);
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
    await expect(page.getByTestId('result-model')).toHaveText(/Your model/);
    await expect(page.getByTestId('result-armed')).toContainText('Not paired');
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
    await expect(page.getByTestId('result-model')).toHaveText(/Your model/);
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

test('Re-train picks up new real recordings', async ({ page }) => {
  const bridge = await livePage(page, { armed: true, token: TOKEN, real: true }, { realClips: false });
  try {
    await expect(page.getByTestId('result-model')).toContainText("Spiro's model (public)");
    const half: Dataset = { ...REAL, clips: REAL.clips.filter((c) => c.session === 's1') };
    await page.evaluate((ds) => window.__ss.app.store.load(ds), half);
    await page.getByTestId('result-retrain').click();
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 40 recordings/);
    await page.evaluate((ds) => window.__ss.app.store.load(ds), REAL);
    await expect(page.getByTestId('result-model')).toContainText('New recordings since. Press Re-train.');
    await page.getByTestId('result-retrain').click();
    await expect(page.getByTestId('result-model')).toHaveText(/Your model: 120 recordings/);
    await expect(page.getByTestId('result-model')).not.toContainText('New recordings since');
  } finally {
    await bridge.close();
  }
});

// ---------- moments ----------

test('help: full screen red alert with a big Dismiss (Escape works too)', async ({ page }) => {
  await page.goto('./?mode=fake');
  await recognize(page);
  await expect(page.getByTestId('result-model')).toContainText('Demo model (fake data)');
  const alert = page.getByTestId('result-alert');
  await inject(page, { label: 'help', confidence: 0.4, accepted: false });
  await expect(alert).toBeHidden(); // only when it's sure
  await inject(page, accepted('help'));
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(sentence('help'));
  await expect(alert).toContainText('Would: Text your emergency contact');
  const box = await alert.boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.width).toBeGreaterThanOrEqual(vp.width - 1);
  expect(box!.height).toBeGreaterThanOrEqual(vp.height - 1);
  await expect(page.getByTestId('result-alert-dismiss')).toBeFocused();
  await page.keyboard.press('Space'); // presses Dismiss, not push to talk
  await expect(alert).toBeHidden();
  expect(await page.evaluate(() => window.__ss.counts.ptt ?? 0)).toBe(0);
  await inject(page, accepted('help'));
  await expect(alert).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(alert).toBeHidden();
  await inject(page, accepted('help'));
  await page.getByTestId('result-alert-dismiss').click();
  await expect(alert).toBeHidden();
});

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
