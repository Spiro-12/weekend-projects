// Live source against mock bridges (never the real Mac app on 8765).
import { expect, test, type Page } from '@playwright/test';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { BASE, MOCK_WS } from '../../playwright.config';
import { startMockBridge, type MockBridge } from '../mock-bridge';

const ORIGIN = new URL(BASE).origin;
const live = (ws: string) => `./?mode=live&ws=${encodeURIComponent(ws)}`;
const wsOf = (b: { port: number }) => `ws://127.0.0.1:${b.port}`;
const counts = (page: Page) => page.evaluate(() => ({ ...window.__ss.counts }));
const motionCount = (page: Page) => page.evaluate(() => window.__ss.counts.motion ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** Actions may only ever go to a mock. Call before every sendAction. */
async function assertMockBridge(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__ss.app.lastHello?.app ?? null)).toBe('MockBridge');
}

const sendAction = (page: Page, action: string) =>
  page.evaluate((a) => window.__ss.app.sendAction({ action: a, label: a, confidence: 0.9 }), action);

// ---------- a tiny scriptable bridge (its hello says MockBridge) ----------
interface TestBridgeOpts {
  hello?: boolean; // default true
  statusEveryMs?: number; // default 1000, 0 = never
  motionHz?: number; // default 0 = no motion
  onAction?: 'ignore' | 'terminate'; // default ignore (never answers)
  closeOnConnect?: boolean; // accept, say hello (if on), then close right away
}
async function startTestBridge(o: TestBridgeOpts = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((res) => wss.once('listening', () => res()));
  const port = (wss.address() as AddressInfo).port;
  const state = { connections: 0, closed: [] as number[], received: [] as string[] };
  const status = JSON.stringify({
    type: 'status', headphones: 'connected', auth: 'authorized', loc: 'left', hz: 25, gapPct: 0, clients: 1, armed: false, simulated: true,
  });
  wss.on('connection', (ws: WsSocket) => {
    const id = state.connections++;
    ws.on('close', () => state.closed.push(id));
    if (o.hello ?? true) ws.send(JSON.stringify({ type: 'hello', v: 1, app: 'MockBridge', version: 'test', actions: ['volume_up'], armed: false }));
    if (o.closeOnConnect) { ws.close(); return; }
    ws.on('message', (d) => {
      state.received.push(d.toString());
      if (o.onAction === 'terminate') ws.terminate();
    });
  });
  const timers: ReturnType<typeof setInterval>[] = [];
  const every = o.statusEveryMs ?? 1000;
  if (every) timers.push(setInterval(() => wss.clients.forEach((c) => c.send(status)), every));
  let seq = 0;
  if (o.motionHz) {
    timers.push(setInterval(() => {
      const t = performance.now() / 1000;
      const m = JSON.stringify({ type: 'motion', seq: seq++, t, q: [1, 0, 0, 0], rr: [0.01, 0, 0], ua: [0, 0, 0.001], extra: 'must not pass' });
      wss.clients.forEach((c) => c.send(m));
    }, 1000 / o.motionHz));
  }
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    state,
    open: () => wss.clients.size,
    close: async () => {
      timers.forEach(clearInterval);
      wss.clients.forEach((c) => c.terminate());
      await new Promise<void>((res) => wss.close(() => res()));
    },
  };
}

// ---------- tests ----------

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

test('motion reaches the bus without `type` or unknown fields', async ({ page }) => {
  const bridge = await startTestBridge({ motionHz: 25 });
  try {
    await page.goto(live(bridge.url));
    const keys = await page.evaluate(() => new Promise<string[]>((res) => {
      const off = window.__ss.app.bus.on('motion', (s) => { off(); res(Object.keys(s).sort()); });
    }));
    expect(keys).toEqual(['q', 'rr', 'seq', 't', 'ua']);
  } finally {
    await bridge.close();
  }
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

test('no answer: times out after 5 s, and a duplicate request id is refused without sending', async ({ page }) => {
  const bridge = await startTestBridge(); // hello + status every 1 s, never answers actions
  try {
    await page.goto(live(bridge.url));
    await assertMockBridge(page);
    const t0 = Date.now();
    const [first, dup] = await page.evaluate(() => {
      const src = window.__ss.app.source!;
      const req = { type: 'action' as const, id: 'same-id', action: 'volume_up', label: 'volume_up', confidence: 0.9, token: '' };
      return Promise.all([src.sendAction!(req), src.sendAction!(req)]);
    });
    expect(dup).toMatchObject({ ok: false, error: 'duplicate_id', id: 'same-id' });
    expect(first).toMatchObject({ ok: false, dryRun: false, error: 'timeout', action: 'volume_up', id: 'same-id' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4900);
    expect(bridge.state.received.map((m) => JSON.parse(m).type)).toEqual(['action']); // the duplicate was not sent
  } finally {
    await bridge.close();
  }
});

test('unknown message types are ignored, not counted as invalid', async ({ page }) => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((res) => wss.once('listening', () => res()));
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', v: 1, app: 'MockBridge', version: 'future', actions: [], armed: false }));
    ws.send(JSON.stringify({ type: 'future_thing', x: 1 }));
    ws.send(JSON.stringify({ type: 'motion', seq: 0, t: 1, q: [1, 0, 0, 0], rr: [0, 0, 0], ua: [0, 0, 0] }));
  });
  try {
    await page.goto(live(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`));
    await expect.poll(() => motionCount(page)).toBe(1);
    expect((await counts(page)).invalid ?? 0).toBe(0);
    await expect(page.getByTestId('status-invalid')).toHaveText('0');
  } finally {
    wss.clients.forEach((c) => c.terminate());
    await new Promise<void>((res) => wss.close(() => res()));
  }
});

test('a connection lost mid action resolves right away as disconnected (outcome unknown)', async ({ page }) => {
  const bridge = await startTestBridge({ onAction: 'terminate' });
  try {
    await page.goto(live(bridge.url));
    await assertMockBridge(page);
    const r = await sendAction(page, 'volume_up');
    expect(r).toMatchObject({ ok: false, dryRun: false, error: 'disconnected', action: 'volume_up' });
    expect(r.ms).toBeLessThan(2000);
  } finally {
    await bridge.close();
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
    expect(Number(await page.getByTestId('status-invalid').textContent())).toBeGreaterThanOrEqual(5);
    await expect(page.getByTestId('status-gaps')).toContainText(/· [1-9]\d* missed/);
  } finally {
    await bridge.close();
  }
});

test('reconnects after the bridge restarts; device rows clear while it is down', async ({ page }) => {
  let bridge: MockBridge = await startMockBridge({ port: 0, allowOrigins: [ORIGIN] });
  const port = bridge.port;
  try {
    await page.goto(live(wsOf(bridge)));
    await expect(page.getByTestId('source-pill')).toHaveText('live · open');
    await expect(page.getByTestId('status-headphones')).toHaveText('Connected');
    await expect.poll(() => motionCount(page)).toBeGreaterThan(10);

    await bridge.close();
    await expect(page.getByTestId('status-conn')).toContainText('closed');
    await expect(page.getByTestId('status-headphones')).toHaveText('–'); // no stale "Connected"
    const before = await motionCount(page);

    bridge = await startMockBridge({ port, allowOrigins: [ORIGIN] });
    await expect(page.getByTestId('source-pill')).toHaveText('live · open', { timeout: 10_000 });
    await expect.poll(() => motionCount(page)).toBeGreaterThan(before + 10);
    expect(await page.evaluate(() => window.__ss.counts.hello)).toBe(2);
  } finally {
    await bridge.close();
  }
});

test('a stuck handshake (TCP accepted, no upgrade answer) is dropped after 5 s and retried', async ({ page }) => {
  const sockets: { s: Socket; closed: boolean }[] = [];
  const server = createServer((s) => {
    const rec = { s, closed: false };
    sockets.push(rec);
    s.on('close', () => { rec.closed = true; });
    s.on('error', () => {});
    s.resume(); // read (and ignore) the upgrade request; a paused socket never reports 'close'
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const port = (server.address() as AddressInfo).port;
  try {
    await page.goto(live(`ws://127.0.0.1:${port}`));
    await expect(page.getByTestId('source-pill')).toHaveText('live · connecting');
    await expect.poll(() => sockets.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => sockets[0].closed).toBe(true); // the stuck socket was given up
    expect(await page.evaluate(() => window.__ss.counts.conn)).toBeGreaterThanOrEqual(3); // connecting, closed, connecting
  } finally {
    sockets.forEach((r) => r.s.destroy());
    await new Promise<void>((res) => server.close(() => res()));
  }
});

test('a server that accepts then closes right away is retried with backoff, not every 0.5 s', async ({ page }) => {
  const bridge = await startTestBridge({ closeOnConnect: true, statusEveryMs: 0 }); // even says hello first
  try {
    await page.goto(live(bridge.url));
    await sleep(6000);
    // Backoff 0.5, 1, 2, 4 s: connections at about 0, 0.5, 1.5, 3.5 s. Resetting on open would make ~12.
    expect(bridge.state.connections).toBeGreaterThanOrEqual(3);
    expect(bridge.state.connections).toBeLessThanOrEqual(5);
  } finally {
    await bridge.close();
  }
});

test('a connection that goes silent is dropped (old socket closed) and reopened', async ({ page }) => {
  const bridge = await startTestBridge({ statusEveryMs: 0 }); // says hello once, then nothing
  try {
    await page.goto(live(bridge.url));
    await expect(page.getByTestId('source-pill')).toHaveText('live · open');
    await expect.poll(() => bridge.state.connections, { timeout: 12_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => bridge.state.closed).toContain(0); // the silent socket was closed
    expect(bridge.open()).toBeLessThanOrEqual(1);
  } finally {
    await bridge.close();
  }
});

test('after stop() the live source emits nothing and leaves no socket open', async ({ page }) => {
  const bridge = await startTestBridge({ motionHz: 25 });
  try {
    await page.goto(live(bridge.url));
    await expect.poll(() => motionCount(page)).toBeGreaterThan(10);
    expect(bridge.open()).toBe(1);
    const conns = bridge.state.connections;
    const [after, later] = await page.evaluate(async () => {
      const app = window.__ss.app;
      app.source!.stop();
      const a = JSON.stringify(app.counts);
      await new Promise((r) => setTimeout(r, 2000)); // the bridge keeps streaming at 25 Hz
      return [a, JSON.stringify(app.counts)];
    });
    expect(later).toEqual(after);
    await expect.poll(() => bridge.open()).toBe(0);
    expect(bridge.state.connections).toBe(conns); // no reconnect after stop()
    await expect(page.getByTestId('source-pill')).toHaveText('live · closed');
  } finally {
    await bridge.close();
  }
});

test('switching sources quickly leaks no sockets', async ({ page }) => {
  const bridge = await startTestBridge({ motionHz: 25 });
  try {
    await page.goto('./?mode=fake');
    await expect(page.getByTestId('source-pill')).toHaveText('fake · open');
    await page.evaluate(async (ws) => {
      const app = window.__ss.app;
      for (let i = 0; i < 10; i++) {
        await app.setSource('live', { ws });
        await app.setSource('fake');
      }
      await app.setSource('live', { ws });
    }, bridge.url);
    await expect(page.getByTestId('source-pill')).toHaveText('live · open');
    await expect.poll(() => bridge.open()).toBe(1);
    await sleep(1500);
    expect(bridge.open()).toBe(1);
    expect(bridge.state.connections).toBeLessThanOrEqual(11);
    await page.evaluate(() => window.__ss.app.setSource('fake'));
    await expect.poll(() => bridge.open()).toBe(0);
  } finally {
    await bridge.close();
  }
});

test('a malformed ?ws= URL (constructor throws) never breaks the page and keeps retrying', async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto(live('ws://['));
  await expect(page.getByTestId('source-pill')).toHaveText(/live · (closed|connecting)/);
  await expect(page.getByTestId('status-conn')).toContainText('ws://[');
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
