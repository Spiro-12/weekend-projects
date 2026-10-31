import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ClassDef, Dataset } from '../../web/src/core/contracts';
import { synthClip } from '../../web/src/core/synth';
import { validateDataset } from '../../web/src/core/validate';
import * as ml from '../../web/src/ml/index';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const classes = JSON.parse(read('../../shared/classes.json')) as ClassDef[];
const TINY = new URL('../../shared/fixtures/dataset.tiny.json', import.meta.url).pathname;
const tiny = JSON.parse(read('../../shared/fixtures/dataset.tiny.json')) as Dataset;
// The three fake sentences that are easiest to tell apart (see the accuracy test).
const PICK = ['text_mom', 'call_back', 'focus_music'];
const NO_SIGNAL = "No signal from the AirPods, check they're in your ears";

/** Track D's classifier is in once ml.evaluate stops throwing "not implemented". */
function mlReady(): boolean {
  const clips = PICK.flatMap((id, i) => [0, 1].map((rep) =>
    synthClip(classes.find((c) => c.id === id)!, 100 + 10 * i + rep, { rep, session: 's1' })));
  try { ml.evaluate(clips, {}, 'loo'); return true; } catch (e) { return !/not implemented/i.test(String(e)); }
}
const ML_READY = mlReady();

const stored = (page: Page) => page.evaluate(() => window.__ss.app.store.all().length);
const sessions = (page: Page) => page.evaluate(() => window.__ss.app.store.all().map((c) => c.session));
const msg = (page: Page) => page.getByTestId('enroll-msg');
const prompt = (page: Page) => page.getByTestId('enroll-prompt');
const clearMsg = (page: Page) => msg(page).evaluate((el) => { el.textContent = ''; });
/** A new sentence only counts once it has been on screen for a moment (data-ready). */
const ready = (page: Page) => expect(prompt(page)).toHaveAttribute('data-ready', '1');

async function hold(page: Page, ms = 1200) {
  await page.keyboard.down('Space');
  await page.waitForTimeout(ms);
  await page.keyboard.up('Space');
}

/** Picks reps per sentence + which sentences to record. */
async function settings(page: Page, reps: number, pick: string[]) {
  const summary = page.getByTestId('enroll-settings').locator('summary');
  await summary.click();
  await page.getByTestId('enroll-reps').fill(String(reps));
  await page.getByTestId('enroll-reps').press('Enter');
  for (const c of classes) if (!pick.includes(c.id)) await page.getByTestId(`enroll-class-${c.id}`).uncheck();
  await summary.click();
  await expect(page.getByTestId('enroll-progress')).toHaveAttribute('data-target', String(reps * pick.length));
}

/** Fake mode (practice with fake data). */
async function setup(page: Page, reps: number, pick: string[], query = '') {
  await page.goto(`./?mode=fake${query}`);
  await expect(page.getByTestId('source-pill')).toHaveText(/fake · open/);
  await expect(prompt(page)).toHaveAttribute('data-state', 'prompt');
  await settings(page, reps, pick);
  await ready(page);
}

/** Holds Space ~1.2 s per prompt, like a person would. Returns the prompts that were shown. */
async function record(page: Page, n: number): Promise<string[]> {
  const said: string[] = [];
  for (let i = 0; i < n; i++) {
    await expect(prompt(page)).toHaveAttribute('data-state', 'prompt');
    await ready(page);
    said.push((await prompt(page).getAttribute('data-label'))!);
    const before = await stored(page);
    await hold(page);
    await expect.poll(() => stored(page), { intervals: [50] }).toBe(before + 1);
  }
  return said;
}

async function exportFile(page: Page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('enroll-export').click()]);
  const ds = JSON.parse(readFileSync((await dl.path())!, 'utf8')) as Dataset;
  return { name: dl.suggestedFilename(), ds };
}

// ---------- a scripted "live" bridge (no live source in this branch yet, and the mock bridge says simulated) ----------
interface LiveCtl { on: boolean; headphones: 'connected' | 'disconnected'; simulated: boolean }
declare global { interface Window { __live?: LiveCtl } }

/** Real looking AirPods over the live source: 50 Hz, status every 250 ms. Unplug with on / headphones. */
async function scriptedLive(page: Page, init: Partial<LiveCtl> = {}) {
  await page.goto('./?mode=fake');
  await expect(page.getByTestId('source-pill')).toHaveText(/fake · open/);
  await page.evaluate(async (init) => {
    const c: LiveCtl = { on: true, headphones: 'connected', simulated: false, ...init };
    window.__live = c;
    const app = window.__ss.app;
    app.registerSource({
      kind: 'live',
      create: (a) => {
        const timers: ReturnType<typeof setInterval>[] = [];
        return {
          kind: 'live',
          async start() {
            a.bus.emit('conn', { state: 'open', url: 'scripted' });
            a.bus.emit('hello', { type: 'hello', v: 1, app: 'ScriptedLive', version: '0', actions: [], armed: false });
            const status = () => a.bus.emit('status', {
              type: 'status', headphones: c.headphones, auth: 'authorized', loc: 'right', hz: 50, gapPct: 0, clients: 1,
              armed: false, simulated: c.simulated,
            });
            status();
            timers.push(setInterval(status, 250));
            const t0 = performance.now();
            let k = 0;
            timers.push(setInterval(() => {
              for (const due = Math.floor((performance.now() - t0) / 20); k <= due; k++) {
                const t = Math.round((5000 + k * 0.02) * 1e5) / 1e5;
                if (c.on) a.bus.emit('motion', { seq: k, t, q: [1, 0, 0, 0], rr: [0.1 * Math.sin(7 * t), 0.1 * Math.cos(3 * t), 0], ua: [0, 0, 0.01 * Math.sin(5 * t)] });
              }
            }, 10));
          },
          stop() { timers.forEach(clearInterval); },
        };
      },
    });
    await app.setSource('live');
  }, init);
  await expect(page.getByTestId('source-pill')).toHaveText(/live · open/);
  await expect(prompt(page)).toHaveAttribute('data-state', 'prompt');
  await page.waitForTimeout(700); // some data in the buffer before the first press, like a person reading the prompt
  await ready(page);
}
const live = (page: Page, p: Partial<LiveCtl>) => page.evaluate((p) => { Object.assign(window.__live!, p); }, p);

// ---------- the main flow ----------
test('records 3 sentences × 3 takes as fake practice, exports a valid file, and restores them after a reload', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page, 3, PICK);
  // fake data is practice: clearly labeled, own session (finding 3)
  const banner = page.getByTestId('enroll-banner');
  await expect(banner).toContainText('Fake AirPods data (no Mac app connected)');
  await expect(banner).toContainText('Practice with fake data (not saved as real training data)');
  await expect(prompt(page)).toHaveAttribute('data-session', 'fake-1');
  const said = await record(page, 9);

  // every clip got the prompt that was on screen, prompts come in shuffled blocks of every sentence once
  const clips = await page.evaluate(() => window.__ss.app.store.all().map((c) => ({ id: c.id, label: c.label, session: c.session, rep: c.rep })));
  expect(clips.map((c) => c.label)).toEqual(said);
  for (let b = 0; b < 3; b++) expect([...said.slice(3 * b, 3 * b + 3)].sort()).toEqual([...PICK].sort());
  expect(new Set(clips.map((c) => c.id)).size).toBe(9);
  expect(clips.every((c) => c.session === 'fake-1')).toBe(true);
  for (const id of PICK) expect(clips.filter((c) => c.label === id).map((c) => c.rep)).toEqual([0, 1, 2]);
  await expect(page.getByTestId('enroll-progress')).toHaveAttribute('data-total', '9');
  await expect(page.getByTestId('enroll-progress')).toContainText('9 of 9 recorded');
  await expect(prompt(page)).toHaveAttribute('data-state', 'done');

  // live accuracy settles: a number once Track D is in, "model not ready" until then
  const acc = page.getByTestId('enroll-accuracy');
  await expect(acc).toHaveAttribute('data-state', ML_READY ? 'ready' : 'not-ready', { timeout: 15_000 });
  if (!ML_READY) await expect(acc).toContainText('Model not ready');

  // export: current session only, valid ss-dataset v1, source/loc/hz saved with each clip (finding 9)
  const { name, ds } = await exportFile(page);
  expect(name).toMatch(/^ss-dataset-fake-1-\d{8}-\d{4}\.json$/);
  expect(validateDataset(ds)).toEqual([]);
  expect(ds).toMatchObject({ format: 'ss-dataset', v: 1, session: 'fake-1', subject: 'spiro', source: 'fake', hz: 25, device: { model: 'AirPods Pro 3', loc: 'left' } });
  expect(ds.classes).toEqual(classes);
  expect(ds.clips.map((c) => c.label)).toEqual(said);
  for (const c of ds.clips) {
    expect(Object.keys(c).sort()).toEqual(['id', 'label', 'loc', 'padSec', 'pressT', 'quality', 'releaseT', 'rep', 'samples', 'session', 'startedAt']);
    expect(['left', 'right', 'default', 'unknown']).toContain(c.loc);
    expect(c.quality.nSamples).toBe(c.samples.length);
    expect(c.samples[0].t).toBeLessThanOrEqual(c.pressT - c.padSec + 0.1);
    expect(c.samples.at(-1)!.t).toBeGreaterThanOrEqual(c.releaseT + c.padSec - 0.1);
    expect(c.releaseT - c.pressT).toBeGreaterThan(0.9);
  }
  const settingsJson = await page.evaluate(() => localStorage.getItem('ss.enroll') ?? '');
  expect(settingsJson).not.toMatch(/origin|source|"hz"|"loc"/);

  // reload: clips come back from IndexedDB, settings from localStorage
  await page.reload();
  await expect.poll(() => stored(page)).toBe(9);
  await expect(page.getByTestId('enroll-progress')).toHaveAttribute('data-total', '9');
  await expect(prompt(page)).toHaveAttribute('data-state', 'done');
  const back = await page.evaluate(() => window.__ss.app.store.all().map((c) => c.label));
  expect(back.sort()).toEqual([...said].sort());
  expect((await exportFile(page)).ds.source).toBe('fake');
  expect(errors).toEqual([]);
});

// 5 takes per sentence, not 3: with 9 clips a single miss is 8/9 = 0.89, so ">= 0.9" would demand a
// perfect score. Simulating this exact fake timing with Track D's DTW (150 runs each): 3 takes of these
// sentences scored < 0.9 about 1 run in 8; 5 takes never did (worst 0.93).
test('live accuracy is at least 0.9 on fake data, and Train & use switches to Recognize mode', async ({ page }) => {
  test.skip(!ML_READY, 'ml.evaluate is not implemented yet (Track D)');
  test.setTimeout(120_000);
  await setup(page, 5, PICK);
  await record(page, 15);
  const acc = page.getByTestId('enroll-accuracy');
  await expect(acc).toHaveAttribute('data-n', '15', { timeout: 20_000 });
  await expect(acc).toHaveAttribute('data-state', 'ready');
  expect(Number(await acc.getAttribute('data-acc'))).toBeGreaterThanOrEqual(0.9);
  await expect(acc.locator('tbody tr')).toHaveCount(3);
  await page.getByTestId('enroll-train').click();
  await expect.poll(() => page.evaluate(() => window.__ss.app.mode)).toBe('classify');
  expect(await page.evaluate(() => window.__ss.app.model !== null)).toBe(true);
  await expect(page.locator('[data-panel=enroll]')).toContainText('Trained on 15');
  // finding 10: back in Record mode, the old "Trained on N" note is gone
  await page.getByTestId('enroll-back').click();
  await expect(prompt(page)).toBeVisible();
  await expect(page.getByTestId('enroll-note')).toHaveText('');
});

// ---------- finding 1: a stalled or dead stream never saves old samples under a new label ----------
test('finding 1: dead or stalled AirPods stream and AirPods out are rejected with a clear message', async ({ page }) => {
  test.setTimeout(60_000);
  await scriptedLive(page);
  const label = await prompt(page).getAttribute('data-label');

  // a) the stream dies right as Space goes down (AirPods out, Bluetooth hiccup)
  await live(page, { on: false });
  await hold(page);
  await expect(msg(page)).toContainText(NO_SIGNAL, { timeout: 5000 });
  await expect(msg(page)).toHaveAttribute('data-kind', 'bad');
  await expect(page.getByTestId('enroll-signal')).toHaveAttribute('data-ok', '0');
  expect(await stored(page)).toBe(0);

  // b) the stream stalls mid hold and only comes back after letting go
  await live(page, { on: true });
  await page.waitForTimeout(1100);
  await clearMsg(page);
  await page.keyboard.down('Space');
  await page.waitForTimeout(400);
  await live(page, { on: false });
  await page.waitForTimeout(1000);
  await page.keyboard.up('Space');
  await page.waitForTimeout(300);
  await live(page, { on: true });
  await expect(msg(page)).toContainText(NO_SIGNAL, { timeout: 5000 });
  expect(await stored(page)).toBe(0);

  // c) the Mac says the AirPods are disconnected
  await page.waitForTimeout(1100);
  await live(page, { headphones: 'disconnected' });
  await expect(page.getByTestId('enroll-banner')).toContainText('Not connected to AirPods. Recording real data is off.');
  await expect(page.getByTestId('enroll-banner')).toContainText("The AirPods aren't connected");
  await clearMsg(page);
  await hold(page);
  await expect(msg(page)).toContainText(NO_SIGNAL, { timeout: 5000 });
  expect(await stored(page)).toBe(0);
  await expect(prompt(page)).toHaveAttribute('data-label', label!); // still the same sentence

  // d) all good again: a take saves, labeled with the prompt
  await live(page, { headphones: 'connected' });
  await expect(page.getByTestId('enroll-banner')).toBeHidden();
  await page.waitForTimeout(1100);
  await ready(page);
  await hold(page);
  await expect.poll(() => stored(page)).toBe(1);
  expect(await page.evaluate(() => window.__ss.app.store.all()[0].label)).toBe(label);
});

// ---------- finding 2: finger slips ----------
test('finding 2: a quick re-press (finger slip) throws both takes away and keeps the prompt', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, 3, PICK);
  const label = await prompt(page).getAttribute('data-label');
  await hold(page);
  await page.waitForTimeout(80);
  await hold(page);
  await expect(msg(page)).toHaveText('Finger slipped, say it again.', { timeout: 5000 });
  await page.waitForTimeout(1500);
  expect(await stored(page)).toBe(0);
  await expect(prompt(page)).toHaveAttribute('data-label', label!);

  // lifting the finger for 60 ms mid sentence
  await clearMsg(page);
  await hold(page, 700);
  await page.waitForTimeout(60);
  await hold(page, 800);
  await expect(msg(page)).toHaveText('Finger slipped, say it again.', { timeout: 5000 });
  await page.waitForTimeout(1500);
  expect(await stored(page)).toBe(0);

  // pressing again 0.7 s after letting go ("let go too early, press again to finish") is a slip too
  await clearMsg(page);
  await hold(page);
  await page.waitForTimeout(700);
  await hold(page);
  await expect(msg(page)).toHaveText('Finger slipped, say it again.', { timeout: 5000 });
  await page.waitForTimeout(1500);
  expect(await stored(page)).toBe(0);
  await expect(prompt(page)).toHaveAttribute('data-label', label!);

  // a normal take afterwards still gets the prompt's label
  const [said] = await record(page, 1);
  expect(said).toBe(label);
  expect(await page.evaluate(() => window.__ss.app.store.all()[0].label)).toBe(label);
});

test('round 2, finding 1: a press right as the next sentence appears is thrown away, not labeled with it', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, 3, PICK);
  // Press from inside the page the instant the next sentence appears. Doing it with Playwright round trips
  // missed the 400 ms "not readable yet" window on a busy machine (flaky), so the timing is deterministic now.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=enroll-prompt]')!;
    const first = el.getAttribute('data-label');
    const w = window as unknown as { __early: Promise<string> };
    w.__early = new Promise<string>((res) => {
      const mo = new MutationObserver(() => {
        const label = el.getAttribute('data-label');
        if (el.getAttribute('data-ready') !== '0' || !label || label === first) return;
        mo.disconnect();
        dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
        setTimeout(() => { dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ' })); res(label); }, 1200);
      });
      mo.observe(el, { attributes: true, attributeFilter: ['data-ready', 'data-label'] });
    });
  });
  await record(page, 1);
  const next = await page.evaluate(() => (window as unknown as { __early: Promise<string> }).__early);
  await expect(msg(page)).toContainText('Wait until the sentence turns solid white', { timeout: 5000 });
  await page.waitForTimeout(1200);
  expect(await stored(page)).toBe(1);
  await expect(prompt(page)).toHaveAttribute('data-label', next!); // same sentence, now readable
  await ready(page);
  const [said] = await record(page, 1);
  expect(said).toBe(next);
  expect((await page.evaluate(() => window.__ss.app.store.all().map((c) => c.label)))[1]).toBe(next);
});

// ---------- finding 3: real data only from live AirPods, never mixed with fake ----------
test('finding 3: real takes need live AirPods; simulated data goes to a separate practice session', async ({ page }) => {
  test.setTimeout(60_000);
  await scriptedLive(page);
  await settings(page, 3, PICK);
  await expect(page.getByTestId('enroll-banner')).toBeHidden();
  await expect(prompt(page)).toHaveAttribute('data-session', 's1');
  await record(page, 2);

  // the Mac app switches to Simulate: practice only, its own session
  await live(page, { simulated: true });
  await expect(page.getByTestId('enroll-banner')).toContainText('The Mac app is in Simulate mode. Real recording is off.');
  await expect(page.getByTestId('enroll-banner')).toContainText('Practice with fake data (not saved as real training data)');
  await expect(prompt(page)).toHaveAttribute('data-session', 'fake-1');
  await page.waitForTimeout(600);
  await record(page, 1);
  expect(await sessions(page)).toEqual(['s1', 's1', 'fake-1']);
  expect((await exportFile(page)).ds).toMatchObject({ session: 'fake-1', source: 'fake' });

  // back to real AirPods: s1 has only the real takes, marked airpods
  await live(page, { simulated: false });
  await expect(prompt(page)).toHaveAttribute('data-session', 's1');
  const { name, ds } = await exportFile(page);
  expect(name).toMatch(/^ss-dataset-s1-/);
  expect(validateDataset(ds)).toEqual([]);
  expect(ds).toMatchObject({ session: 's1', subject: 'spiro', source: 'airpods', hz: 50, device: { model: 'AirPods Pro 3', loc: 'right' } });
  expect(ds.clips).toHaveLength(2);

  // a practice name can't be used for real takes
  await page.getByTestId('enroll-settings').locator('summary').click();
  await page.getByTestId('enroll-session').fill('fake-9');
  await page.getByTestId('enroll-session').press('Enter');
  await expect(page.getByTestId('enroll-note')).toContainText('are for practice');
  await expect(prompt(page)).toHaveAttribute('data-session', 's1');
});

test('round 2, finding 3: Simulate switched on while Space is held does not save the take', async ({ page }) => {
  await scriptedLive(page);
  await page.keyboard.down('Space');
  await page.waitForTimeout(400);
  await live(page, { simulated: true });
  await page.waitForTimeout(800);
  await page.keyboard.up('Space');
  await expect(msg(page)).toContainText('the AirPods mode changed while you were recording', { timeout: 5000 });
  await page.waitForTimeout(500);
  expect(await stored(page)).toBe(0);
});

// ---------- finding 4: no prompt on screen = nothing saved ----------
test('finding 4: a press while loading is thrown away, recording starts once saved takes are back', async ({ page }) => {
  // IndexedDB answers 2.5 s late
  await page.addInitScript(() => {
    const realOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
      const proxy: Record<string, unknown> = {};
      setTimeout(() => {
        const r = realOpen.call(this, name, version);
        const handlers = r as unknown as Record<string, unknown>;
        for (const ev of ['onupgradeneeded', 'onsuccess', 'onerror', 'onblocked']) {
          handlers[ev] = (e: Event) => {
            Object.defineProperty(proxy, 'result', { get: () => r.result, configurable: true });
            Object.defineProperty(proxy, 'error', { get: () => r.error, configurable: true });
            (proxy[ev] as ((e: Event) => void) | undefined)?.(e);
          };
        }
      }, 2500);
      return proxy as unknown as IDBOpenDBRequest;
    };
  });
  await page.goto('./?mode=fake');
  await expect(page.getByTestId('source-pill')).toHaveText(/fake · open/);
  await expect(prompt(page)).toHaveAttribute('data-state', 'loading');
  await expect(prompt(page)).toHaveText('Loading your recordings…');
  await page.waitForTimeout(500);
  await hold(page, 1400); // the restore lands while Space is held
  await expect(msg(page)).toContainText('Wait for a sentence to show', { timeout: 5000 });
  await expect(prompt(page)).toHaveAttribute('data-state', 'prompt');
  await page.waitForTimeout(800);
  expect(await stored(page)).toBe(0);
});

test('finding 4: a press on the done screen is thrown away', async ({ page }) => {
  await setup(page, 1, ['help']);
  await record(page, 1);
  await expect(prompt(page)).toHaveAttribute('data-state', 'done');
  await page.waitForTimeout(1100);
  await hold(page);
  await expect(msg(page)).toContainText('is done', { timeout: 5000 });
  await page.waitForTimeout(500);
  expect(await stored(page)).toBe(1);
});

test('Recognize mode pauses recording, even when switching back while a take lands', async ({ page }) => {
  await page.goto('./?mode=fake');
  await expect(prompt(page)).toHaveAttribute('data-state', 'prompt');
  await page.getByTestId('mode-toggle').click();
  await expect(page.getByTestId('enroll-back')).toBeVisible();
  await expect(prompt(page)).toBeHidden();
  await page.waitForTimeout(400);
  await hold(page, 1000);
  await page.getByTestId('enroll-back').click();
  await expect.poll(() => page.evaluate(() => window.__ss.counts.clip ?? 0)).toBe(1);
  await page.waitForTimeout(1000);
  expect(await stored(page)).toBe(0);
  await expect(prompt(page)).toBeVisible();
});

test('round 2, finding 2: switching to Recognize right after letting go keeps the take', async ({ page }) => {
  await setup(page, 3, PICK);
  const label = await prompt(page).getAttribute('data-label');
  await hold(page);
  await page.getByTestId('mode-toggle').click(); // within ~0.1 s of release
  await expect.poll(() => page.evaluate(() => window.__ss.app.mode)).toBe('classify');
  await expect.poll(() => stored(page)).toBe(1);
  expect(await page.evaluate(() => window.__ss.app.store.all()[0].label)).toBe(label);
});

test('round 2, finding 2: Train & use waits for the take that is landing and includes it', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, 3, ['text_mom', 'call_back']);
  await record(page, 4);
  const train = page.getByTestId('enroll-train');
  await expect(train).toBeEnabled();
  await ready(page);
  await hold(page);
  await expect(train).toBeDisabled(); // the 5th take is still landing
  await expect.poll(() => stored(page)).toBe(5);
  await expect(train).toBeEnabled();
  await train.click();
  await expect.poll(() => page.evaluate(() => window.__ss.app.mode)).toBe('classify');
  await expect(page.locator('[data-panel=enroll]')).toContainText('Trained on 5 recordings');
});

// ---------- finding 5: Redo while a take is landing ----------
test('finding 5: Redo waits for the take that is landing and deletes that one', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, 3, PICK);
  await record(page, 1);
  const first = await page.evaluate(() => window.__ss.app.store.all()[0].id);
  const redo = page.getByTestId('enroll-redo');
  await ready(page);
  await page.keyboard.down('Space');
  await expect(redo).toBeDisabled();
  await page.waitForTimeout(1200);
  await page.keyboard.up('Space');
  await expect(redo).toBeDisabled(); // the take is still landing
  await expect.poll(() => stored(page)).toBe(2);
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect.poll(() => stored(page)).toBe(1);
  expect(await page.evaluate(() => window.__ss.app.store.all()[0].id)).toBe(first);
  await expect(msg(page)).toContainText('Deleted the last recording');
  await page.waitForTimeout(1500);
  await expect(msg(page)).toContainText('Deleted the last recording'); // not overwritten by a late "Saved"
});

// ---------- finding 6: import never merges into a session just because the name matches ----------
test('finding 6: import dedupes by id, renames sessions that would mix, and explains a bad file', async ({ page }) => {
  await page.goto('./?mode=fake');
  await expect(prompt(page)).toHaveAttribute('data-state', 'prompt');
  const note = page.getByTestId('enroll-note');
  const imp = page.getByTestId('enroll-import');
  await imp.setInputFiles(TINY); // someone else's fake data, session s1
  await expect(note).toContainText('Imported 6 recordings.');
  await expect(note).toContainText('Renamed session s1 → synthetic-s1');
  expect(new Set(await sessions(page))).toEqual(new Set(['synthetic-s1']));
  await imp.setInputFiles(TINY);
  await expect(note).toHaveText(/Imported 0 recordings\. 6 were already here\./);
  expect(await stored(page)).toBe(6);
  await imp.setInputFiles({ name: 'junk.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"nope"}') });
  await expect(note).toContainText('junk.json is not a Silent Speech recording file');
  await expect(note).toHaveAttribute('data-kind', 'bad');
  expect(await stored(page)).toBe(6);

  // with ml missing, Train says "model not ready" instead of breaking
  if (!ML_READY) {
    await page.getByTestId('enroll-train').click();
    await expect(note).toContainText('Model not ready');
    expect(await page.evaluate(() => window.__ss.app.mode)).toBe('enroll');
  }
});

test('finding 6: a real session from another browser with the same name gets its own name', async ({ page }) => {
  test.setTimeout(60_000);
  await scriptedLive(page);
  await record(page, 1); // local real s1
  const other: Dataset = {
    ...tiny, subject: 'spiro', source: 'airpods', session: 's1',
    clips: tiny.clips.map((c) => ({ ...c, id: `other-${c.id}`, session: 's1' })),
  };
  await page.getByTestId('enroll-import').setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(other)) });
  await expect(page.getByTestId('enroll-note')).toContainText('Renamed session s1 → spiro-s1');
  expect((await sessions(page)).sort()).toEqual(['s1', ...Array<string>(6).fill('spiro-s1')]);
  expect((await exportFile(page)).ds.clips).toHaveLength(1); // s1 is still only the local take
});

test('round 2, finding 6: IndexedDB that never answers falls back to memory with a clear message', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    IDBFactory.prototype.open = function () { return {} as IDBOpenDBRequest; }; // never fires anything
  });
  await page.goto('./?mode=fake');
  await expect(prompt(page)).toHaveAttribute('data-state', 'loading');
  await expect(prompt(page)).toHaveAttribute('data-state', 'prompt', { timeout: 12_000 });
  await expect(page.getByTestId('enroll-alert')).toContainText("This browser's storage isn't answering");
  await expect(page.getByTestId('enroll-saved')).toContainText('Autosave is off in this browser');
  await ready(page);
  await hold(page);
  await expect.poll(() => stored(page)).toBe(1);
  await expect(msg(page)).toContainText('Not autosaved: export before you close the page');
});

// ---------- finding 8: a failed save is loud ----------
test('finding 8: when IndexedDB writes fail, the main area says NOT saved', async ({ page }) => {
  await page.addInitScript(() => {
    const real = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, s: string | string[], mode?: IDBTransactionMode) {
      if (mode === 'readwrite') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return real.call(this, s, mode);
    } as typeof real;
  });
  await setup(page, 3, PICK);
  await hold(page);
  await expect.poll(() => stored(page)).toBe(1);
  await expect(msg(page)).toHaveText('Recorded but NOT saved in this browser. Press Export now.');
  await expect(msg(page)).toHaveAttribute('data-kind', 'bad');
  await expect(page.getByTestId('enroll-alert')).toHaveText('Recorded but NOT saved in this browser. Press Export now.');
  await expect(page.getByTestId('enroll-export-done')).toBeVisible();
  await ready(page);
  await hold(page);
  await expect.poll(() => stored(page)).toBe(2);
  await page.waitForTimeout(300);
  await expect(msg(page)).toHaveText('Recorded but NOT saved in this browser. Press Export now.'); // never "Saved"
});

// ---------- the rest ----------
test('skip, redo last and clear session', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, 2, ['text_mom', 'volume_up']);
  const first = await prompt(page).getAttribute('data-label');
  await page.getByTestId('enroll-skip').click();
  await expect(prompt(page)).not.toHaveAttribute('data-label', first!);

  const [said] = await record(page, 1);
  await page.getByTestId('enroll-redo').click();
  await expect.poll(() => stored(page)).toBe(0);
  await expect(prompt(page)).toHaveAttribute('data-label', said);
  await expect(msg(page)).toContainText('Say it again');

  await record(page, 2);
  await page.getByTestId('enroll-settings').locator('summary').click();
  await page.getByTestId('enroll-clear').click();
  await expect(page.getByTestId('enroll-clear-yes')).toBeVisible();
  await page.getByTestId('enroll-clear-no').click();
  expect(await stored(page)).toBe(2);
  await page.getByTestId('enroll-clear').click();
  await page.getByTestId('enroll-clear-yes').click();
  await expect.poll(() => stored(page)).toBe(0);
  await expect(page.getByTestId('enroll-progress')).toHaveAttribute('data-total', '0');
});

test('a finished session offers the next one, and old sessions stay saved', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, 1, ['help', 'none']);
  await expect(prompt(page)).toHaveAttribute('data-label', /^(help|none)$/);
  await record(page, 2);
  await expect(prompt(page)).toHaveAttribute('data-state', 'done');
  await page.getByTestId('enroll-next-session').click();
  await expect(prompt(page)).toHaveAttribute('data-state', 'prompt');
  await expect(page.getByTestId('enroll-progress')).toContainText('0 of 2 recorded');
  await expect(page.getByTestId('enroll-progress')).toContainText('session fake-2');
  await expect(page.getByTestId('enroll-export')).toBeDisabled();
  await expect(page.getByTestId('enroll-saved')).toContainText('fake-1 (2, fake)');
  await record(page, 1);
  expect(await sessions(page)).toEqual(['fake-1', 'fake-1', 'fake-2']);
});

test('a patchy signal is rejected with a clear message and the prompt stays', async ({ page }) => {
  await setup(page, 3, PICK, '&drop=0.6');
  const before = await prompt(page).getAttribute('data-label');
  await hold(page);
  await expect(msg(page)).toContainText('Not saved');
  await expect(msg(page)).toContainText('patchy');
  await expect(msg(page)).toHaveAttribute('data-kind', 'bad');
  expect(await stored(page)).toBe(0);
  await expect(prompt(page)).toHaveAttribute('data-label', before!);
});
