import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ClassDef, Dataset } from '../../web/src/core/contracts';
import { synthClip } from '../../web/src/core/synth';
import { validateDataset } from '../../web/src/core/validate';
import * as ml from '../../web/src/ml/index';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const classes = JSON.parse(read('../../shared/classes.json')) as ClassDef[];
const TINY = new URL('../../shared/fixtures/dataset.tiny.json', import.meta.url).pathname;
// The three fake sentences that are easiest to tell apart (see the accuracy test).
const PICK = ['text_mom', 'call_back', 'focus_music'];

/** Track D's classifier is in once ml.evaluate stops throwing "not implemented". */
function mlReady(): boolean {
  const clips = PICK.flatMap((id, i) => [0, 1].map((rep) =>
    synthClip(classes.find((c) => c.id === id)!, 100 + 10 * i + rep, { rep, session: 's1' })));
  try { ml.evaluate(clips, {}, 'loo'); return true; } catch (e) { return !/not implemented/i.test(String(e)); }
}
const ML_READY = mlReady();

const stored = (page: Page) => page.evaluate(() => window.__ss.app.store.all().length);

/** Opens fake mode and sets reps per sentence + which sentences to record. */
async function setup(page: Page, reps: number, pick: string[], query = '') {
  await page.goto(`./?mode=fake${query}`);
  await expect(page.getByTestId('source-pill')).toHaveText(/fake · open/);
  await expect(page.getByTestId('enroll-prompt')).toHaveAttribute('data-state', 'prompt');
  const summary = page.getByTestId('enroll-settings').locator('summary');
  await summary.click();
  await page.getByTestId('enroll-reps').fill(String(reps));
  await page.getByTestId('enroll-reps').press('Enter');
  for (const c of classes) if (!pick.includes(c.id)) await page.getByTestId(`enroll-class-${c.id}`).uncheck();
  await summary.click();
  await expect(page.getByTestId('enroll-progress')).toHaveAttribute('data-target', String(reps * pick.length));
}

/** Holds Space ~1.2 s per prompt, like a person would. Returns the prompts that were shown. */
async function record(page: Page, n: number): Promise<string[]> {
  const said: string[] = [];
  const prompt = page.getByTestId('enroll-prompt');
  for (let i = 0; i < n; i++) {
    await expect(prompt).toHaveAttribute('data-state', 'prompt');
    said.push((await prompt.getAttribute('data-label'))!);
    const before = await stored(page);
    await page.keyboard.down('Space');
    await page.waitForTimeout(1200);
    await page.keyboard.up('Space');
    await expect.poll(() => stored(page)).toBe(before + 1);
  }
  return said;
}

test('records 3 sentences × 3 takes, exports a valid file, and restores them after a reload', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page, 3, PICK);
  const said = await record(page, 9);

  // every clip got the prompt that was on screen, prompts come in shuffled blocks of every sentence once
  const clips = await page.evaluate(() => window.__ss.app.store.all().map((c) => ({ id: c.id, label: c.label, session: c.session, rep: c.rep })));
  expect(clips.map((c) => c.label)).toEqual(said);
  for (let b = 0; b < 3; b++) expect([...said.slice(3 * b, 3 * b + 3)].sort()).toEqual([...PICK].sort());
  expect(new Set(clips.map((c) => c.id)).size).toBe(9);
  expect(clips.every((c) => c.session === 's1')).toBe(true);
  for (const id of PICK) expect(clips.filter((c) => c.label === id).map((c) => c.rep)).toEqual([0, 1, 2]);
  await expect(page.getByTestId('enroll-progress')).toHaveAttribute('data-total', '9');
  await expect(page.getByTestId('enroll-progress')).toContainText('9 of 9 recorded');
  await expect(page.getByTestId('enroll-prompt')).toHaveAttribute('data-state', 'done');

  // live accuracy settles: a number once Track D is in, "model not ready" until then
  const acc = page.getByTestId('enroll-accuracy');
  await expect(acc).toHaveAttribute('data-state', ML_READY ? 'ready' : 'not-ready', { timeout: 15_000 });
  if (!ML_READY) await expect(acc).toContainText('Model not ready');

  // export: current session only, valid ss-dataset v1
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('enroll-export').click()]);
  expect(dl.suggestedFilename()).toMatch(/^ss-dataset-s1-\d{8}-\d{4}\.json$/);
  const ds = JSON.parse(readFileSync((await dl.path())!, 'utf8')) as Dataset;
  expect(validateDataset(ds)).toEqual([]);
  expect(ds).toMatchObject({ format: 'ss-dataset', v: 1, session: 's1', source: 'fake', hz: 25, device: { model: 'AirPods Pro 3', loc: 'left' } });
  expect(ds.classes).toEqual(classes);
  expect(ds.clips.map((c) => c.label)).toEqual(said);
  for (const c of ds.clips) {
    expect(c.quality.nSamples).toBe(c.samples.length);
    expect(c.samples[0].t).toBeGreaterThanOrEqual(c.pressT - c.padSec - 1e-6);
    expect(c.samples.at(-1)!.t).toBeLessThanOrEqual(c.releaseT + c.padSec + 1e-6);
    expect(c.releaseT - c.pressT).toBeGreaterThan(0.9);
  }

  // reload: clips come back from IndexedDB, settings from localStorage
  await page.reload();
  await expect.poll(() => stored(page)).toBe(9);
  await expect(page.getByTestId('enroll-progress')).toHaveAttribute('data-total', '9');
  await expect(page.getByTestId('enroll-prompt')).toHaveAttribute('data-state', 'done');
  const back = await page.evaluate(() => window.__ss.app.store.all().map((c) => c.label));
  expect(back.sort()).toEqual([...said].sort());
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
});

test('import dedupes by clip id and explains a bad file', async ({ page }) => {
  await page.goto('./?mode=fake');
  await expect(page.getByTestId('enroll-prompt')).toHaveAttribute('data-state', 'prompt');
  const note = page.getByTestId('enroll-note');
  const imp = page.getByTestId('enroll-import');
  await imp.setInputFiles(TINY);
  await expect(note).toHaveText(/Imported 6 recordings\./);
  expect(await stored(page)).toBe(6);
  await imp.setInputFiles(TINY);
  await expect(note).toHaveText(/Imported 0 recordings\. 6 were already here\./);
  expect(await stored(page)).toBe(6);
  await imp.setInputFiles({ name: 'junk.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"nope"}') });
  await expect(note).toContainText('junk.json is not a Silent Speech recording file');
  await expect(note).toHaveAttribute('data-kind', 'bad');
  expect(await stored(page)).toBe(6);

  // with ml missing, accuracy and Train say "model not ready" instead of breaking
  if (!ML_READY) {
    await expect(page.getByTestId('enroll-accuracy')).toHaveAttribute('data-state', 'not-ready', { timeout: 10_000 });
    await page.getByTestId('enroll-train').click();
    await expect(note).toContainText('Model not ready');
    expect(await page.evaluate(() => window.__ss.app.mode)).toBe('enroll');
  }
});

test('skip, redo last and clear session', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, 2, ['text_mom', 'volume_up']);
  const prompt = page.getByTestId('enroll-prompt');
  const first = await prompt.getAttribute('data-label');
  await page.getByTestId('enroll-skip').click();
  await expect(prompt).not.toHaveAttribute('data-label', first!);

  const [said] = await record(page, 1);
  await page.getByTestId('enroll-redo').click();
  await expect.poll(() => stored(page)).toBe(0);
  await expect(prompt).toHaveAttribute('data-label', said);
  await expect(page.getByTestId('enroll-msg')).toContainText('Say it again');

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
  await expect(page.getByTestId('enroll-prompt')).toHaveAttribute('data-label', /^(help|none)$/);
  await record(page, 2);
  await expect(page.getByTestId('enroll-prompt')).toHaveAttribute('data-state', 'done');
  await page.getByTestId('enroll-next-session').click();
  await expect(page.getByTestId('enroll-prompt')).toHaveAttribute('data-state', 'prompt');
  await expect(page.getByTestId('enroll-progress')).toContainText('0 of 2 recorded');
  await expect(page.getByTestId('enroll-progress')).toContainText('session s2');
  await expect(page.getByTestId('enroll-export')).toBeDisabled();
  await expect(page.getByTestId('enroll-saved')).toContainText('s1 (2)');
  await record(page, 1);
  const sessions = await page.evaluate(() => window.__ss.app.store.all().map((c) => c.session));
  expect(sessions).toEqual(['s1', 's1', 's2']);
});

test('a patchy signal is rejected with a clear message and the prompt stays', async ({ page }) => {
  await setup(page, 3, PICK, '&drop=0.6');
  const prompt = page.getByTestId('enroll-prompt');
  const before = await prompt.getAttribute('data-label');
  await page.keyboard.down('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.up('Space');
  const msg = page.getByTestId('enroll-msg');
  await expect(msg).toContainText('Not saved');
  await expect(msg).toContainText('patchy');
  await expect(msg).toHaveAttribute('data-kind', 'bad');
  expect(await stored(page)).toBe(0);
  await expect(prompt).toHaveAttribute('data-label', before!);
});

test('Recognize mode pauses recording', async ({ page }) => {
  await page.goto('./?mode=fake');
  await expect(page.getByTestId('enroll-prompt')).toHaveAttribute('data-state', 'prompt');
  await page.getByTestId('mode-toggle').click();
  await expect(page.getByTestId('enroll-back')).toBeVisible();
  await expect(page.getByTestId('enroll-prompt')).toBeHidden();
  await page.waitForTimeout(400);
  await page.keyboard.down('Space');
  await page.waitForTimeout(1000);
  await page.keyboard.up('Space');
  await expect.poll(() => page.evaluate(() => window.__ss.counts.clip ?? 0)).toBe(1);
  expect(await stored(page)).toBe(0);
  await page.getByTestId('enroll-back').click();
  await expect(page.getByTestId('enroll-prompt')).toBeVisible();
});
