import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startMockBridge, type MockBridge } from '../mock-bridge';
import { parseServerMsg } from '../../web/src/core/validate';
import type { ServerMsg } from '../../web/src/core/contracts';

const PORT = 18765;
let bridge: MockBridge;
beforeAll(async () => { bridge = await startMockBridge({ port: PORT, cooldownMs: 300 }); });
afterAll(async () => { await bridge.close(); });

function connect(origin?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, origin ? { origin } : {});
  const msgs: ServerMsg[] = [];
  let bad = 0;
  ws.on('message', (d) => { const m = parseServerMsg(d.toString()); if (m) msgs.push(m); else bad++; });
  return { ws, msgs, bad: () => bad, open: new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); }) };
}

describe('mock bridge speaks protocol v1', () => {
  it('sends hello, status and ~25 Hz motion', async () => {
    const c = connect('http://localhost:4173');
    await c.open;
    await new Promise((r) => setTimeout(r, 2000));
    c.ws.close();
    expect(c.msgs[0].type).toBe('hello');
    const motion = c.msgs.filter((m) => m.type === 'motion');
    expect(motion.length).toBeGreaterThanOrEqual(45);
    expect(motion.length).toBeLessThanOrEqual(55);
    expect(c.msgs.some((m) => m.type === 'status')).toBe(true);
    expect(c.bad()).toBe(0);
  });

  it('rejects unknown origins', async () => {
    const c = connect('https://evil.example');
    await expect(c.open).rejects.toThrow();
  });

  it('answers actions: dry run, unknown, cooldown', async () => {
    const c = connect();
    await c.open;
    const send = (action: string, id: string) => c.ws.send(JSON.stringify({ type: 'action', id, action, label: action, confidence: 0.9 }));
    send('volume_up', 'a1');
    send('volume_up', 'a2');
    send('launch_rockets', 'a3');
    c.ws.send('garbage');
    await new Promise((r) => setTimeout(r, 300));
    c.ws.close();
    const byId = (id: string) => c.msgs.find((m) => 'id' in m && m.id === id);
    expect(byId('a1')).toMatchObject({ type: 'actionResult', ok: true, dryRun: true });
    expect(byId('a2')).toMatchObject({ type: 'error', code: 'cooldown' });
    expect(byId('a3')).toMatchObject({ type: 'error', code: 'unknown_action' });
    expect(c.msgs.some((m) => m.type === 'error' && m.code === 'bad_json')).toBe(true);
  });
});
