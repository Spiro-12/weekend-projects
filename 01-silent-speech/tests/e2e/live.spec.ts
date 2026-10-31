// Live source against the mock bridge (never the real Mac app on 8765).
import { expect, test, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { BASE, MOCK_WS } from '../../playwright.config';
import { startMockBridge, type MockBridge } from '../mock-bridge';

const ORIGIN = new URL(BASE).origin;
const live = (ws: string) => `./?mode=live&ws=${encodeURIComponent(ws)}`;
const wsOf = (b: { port: number }) => `ws://127.0.0.1:${b.port}`;
const counts = (page: Page) => page.evaluate(() => ({ ...window.__ss.counts }));
const motionCount = (page: Page) => page.evaluate(() => window.__ss.counts.motion ?? 0);

function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** Actions may only ever go to the mock. Call before every sendAction. */
async function assertMockBridge(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__ss.app.lastHello?.app ?? null)).toBe('MockBridge');
}

const sendAction = (page: Page, action: string) =>
  page.evaluate((a) => window.__ss.app.sendAction({ action: a, label: a, confidence: 0.9 }), action);

test('connects to the mock bridge: ~25 Hz, status shown, 0 invalid frames', async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto(live(MOCK_WS));
  await expect(page.getByTestId('source-pill')).toHaveText('live · open');
  await assertMockBridge(page);
  await expect(page.getByTestId('status-conn')).toHaveText(`live · open · ${MOCK_WS}`);
  await expect(page.getByTestId('status-headphones')).toHaveText('Connected');
  await expect(page.getByTestId('status-bridge-hz')).toHaveText('25.0 Hz');

  // Rate measured independently of the panel: samples over 2 s.
  const n0 = await motionCount(page);
  await page.waitForTimeout(2000);
  const rate = ((await motionCount(page)) - n0) / 2;
  expect(rate).toBeGreaterThanOrEqual(22);
  expect(rate).toBeLessThanOrEqual(28);
  await expect(page.getByTestId('status-browser-hz')).toHaveText(/^2[3-7]\.\d Hz$/);
  await expect(page.getByTestId('status-gaps')).toContainText('· 0 missed');

  await expect(page.getByTestId('status-invalid')).toHaveText('0');
  expect((await counts(page)).invalid ?? 0).toBe(0);
  expect(errors).toEqual([]);
});

test('sendAction round trips with the mock: dry run, cooldown error, unknown action', async ({ page }) => {
  const bridge = await startMockBridge({ port: 0, allowOrigins: [ORIGIN] });
  try {
    await page.goto(live(wsOf(bridge)));
    await expect(page.getByTestId('source-pill')).toHaveText('live · open');
    await assertMockBridge(page);

    const r1 = await sendAction(page, 'volume_up');
    expect(r1).toMatchObject({ type: 'actionResult', action: 'volume_up', ok: true, dryRun: true });
    expect(bridge.actions).toEqual([{ action: 'volume_up', dryRun: true }]);

    await assertMockBridge(page);
    const r2 = await sendAction(page, 'volume_up'); // inside the mock's 3 s cooldown
    expect(r2).toMatchObject({ ok: false, dryRun: false, error: 'cooldown', action: 'volume_up' });

    await assertMockBridge(page);
    const r3 = await sendAction(page, 'launch_rockets');
    expect(r3).toMatchObject({ ok: false, error: 'unknown_action' });
    expect(bridge.actions).toHaveLength(1);
    expect(await page.evaluate(() => window.__ss.counts.actionResult)).toBe(3);
  } finally {
    await bridge.close();
  }
});

test('an action with no answer times out after 5 s; unknown message types are ignored', async ({ page }) => {
  // A bridge that says hello (as the mock), sends status every second, and never answers actions.
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((res) => wss.once('listening', () => res()));
  const received: string[] = [];
  const status = JSON.stringify({ type: 'status', headphones: 'connected', auth: 'authorized', loc: 'left', hz: 25, gapPct: 0, clients: 1, armed: false, simulated: true });
  const timer = setInterval(() => wss.clients.forEach((c) => c.send(status)), 1000);
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', v: 1, app: 'MockBridge', version: 'silent', actions: ['volume_up'], armed: false }));
    ws.send(JSON.stringify({ type: 'future_thing', x: 1 })); // newer bridge: must be ignored, not counted
    ws.on('message', (d) => received.push(d.toString()));
  });
  try {
    await page.goto(live(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`));
    await assertMockBridge(page);
    const t0 = Date.now();
    const r = await sendAction(page, 'volume_up');
    expect(r).toMatchObject({ ok: false, dryRun: false, error: 'timeout', action: 'volume_up' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4900);
    expect(received.map((m) => JSON.parse(m).type)).toEqual(['action']);
    expect((await counts(page)).invalid ?? 0).toBe(0);
    await expect(page.getByTestId('status-invalid')).toHaveText('0');
  } finally {
    clearInterval(timer);
    wss.clients.forEach((c) => c.terminate());
    await new Promise<void>((res) => wss.close(() => res()));
  }
});

test('bad frames are counted as invalid; dropped samples show as missed', async ({ page }) => {
  const bridge = await startMockBridge({ port: 0, allowOrigins: [ORIGIN], badEvery: 5, dropRate: 0.15 });
  try {
    await page.goto(live(wsOf(bridge)));
    await expect(page.getByTestId('source-pill')).toHaveText('live · open');
    await expect.poll(async () => (await counts(page)).invalid ?? 0).toBeGreaterThanOrEqual(5);
    const c = await counts(page);
    expect(c.motion ?? 0).toBeGreaterThan(15); // good frames still flow
    expect(c.invalid ?? 0).toBeLessThanOrEqual(bridge.sent.bad);
    await expect(page.getByTestId('status-invalid')).not.toHaveText('0');
    expect(Number(await page.getByTestId('status-invalid').textContent())).toBeGreaterThanOrEqual(5);
    await expect(page.getByTestId('status-gaps')).toContainText(/· [1-9]\d* missed/);
  } finally {
    await bridge.close();
  }
});

test('reconnects after the bridge restarts', async ({ page }) => {
  let bridge: MockBridge = await startMockBridge({ port: 0, allowOrigins: [ORIGIN] });
  const port = bridge.port;
  try {
    await page.goto(live(wsOf(bridge)));
    await expect(page.getByTestId('source-pill')).toHaveText('live · open');
    await expect.poll(() => motionCount(page)).toBeGreaterThan(10);

    await bridge.close();
    await expect(page.getByTestId('status-conn')).toContainText('closed');
    await expect(page.getByTestId('source-pill')).toHaveText(/live · (closed|connecting)/);
    const before = await motionCount(page);

    bridge = await startMockBridge({ port, allowOrigins: [ORIGIN] });
    await expect(page.getByTestId('source-pill')).toHaveText('live · open', { timeout: 10_000 });
    await expect.poll(() => motionCount(page)).toBeGreaterThan(before + 10);
    expect(await page.evaluate(() => window.__ss.counts.hello)).toBe(2);
  } finally {
    await bridge.close();
  }
});

test('a connection that goes silent is dropped and reopened', async ({ page }) => {
  // Accepts connections, says hello once, then says nothing at all.
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((res) => wss.once('listening', () => res()));
  let connections = 0;
  wss.on('connection', (ws) => {
    connections++;
    ws.send(JSON.stringify({ type: 'hello', v: 1, app: 'MockBridge', version: 'mute', actions: [], armed: false }));
  });
  try {
    await page.goto(live(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`));
    await expect(page.getByTestId('source-pill')).toHaveText('live · open');
    await expect.poll(() => connections, { timeout: 12_000 }).toBeGreaterThanOrEqual(2);
  } finally {
    wss.clients.forEach((c) => c.terminate());
    await new Promise<void>((res) => wss.close(() => res()));
  }
});

test('after stop() the live source emits nothing', async ({ page }) => {
  const bridge = await startMockBridge({ port: 0, allowOrigins: [ORIGIN] });
  try {
    await page.goto(live(wsOf(bridge)));
    await expect.poll(() => motionCount(page)).toBeGreaterThan(10);
    const [after, later] = await page.evaluate(async () => {
      const app = window.__ss.app;
      app.source!.stop();
      const a = JSON.stringify(app.counts);
      await new Promise((r) => setTimeout(r, 1500)); // the bridge keeps streaming at 25 Hz
      return [a, JSON.stringify(app.counts)];
    });
    expect(later).toEqual(after);
    await expect(page.getByTestId('source-pill')).toHaveText('live · closed');
  } finally {
    await bridge.close();
  }
});

test('a malformed ?ws= URL never breaks the page and keeps retrying', async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto('./?mode=live&ws=not-a-websocket-url');
  await expect(page.getByTestId('source-pill')).toHaveText(/live · (closed|connecting)/);
  await expect(page.getByTestId('status-conn')).toContainText('not-a-websocket-url');
  await expect.poll(async () => (await counts(page)).conn ?? 0, { timeout: 5000 }).toBeGreaterThanOrEqual(6);
  expect(errors).toEqual([]);
});

test('remembered Mac user with no bridge running falls back to fake (or replay) within 2.5 s', async ({ page }) => {
  const errors = pageErrors(page);
  await page.addInitScript(() => localStorage.setItem('ss.liveSeen', '1'));
  await page.goto('./?ws=ws://127.0.0.1:1');
  await expect(page.getByTestId('source-pill')).toHaveText(/(fake|replay) · open/, { timeout: 2500 });
  expect(await page.evaluate(() => window.__ss.counts.source)).toBe(2); // live was tried first
  await expect.poll(() => motionCount(page)).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});
