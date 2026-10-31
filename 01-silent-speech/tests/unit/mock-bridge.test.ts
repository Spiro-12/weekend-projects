import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startMockBridge, type MockBridge } from '../mock-bridge';
import { parseServerMsg } from '../../web/src/core/validate';
import type { ServerMsg } from '../../web/src/core/contracts';

let bridge: MockBridge;
beforeAll(async () => { bridge = await startMockBridge({ port: 0, cooldownMs: 300, sensitiveCooldownMs: 600 }); });
afterAll(async () => { await bridge.close(); });

function connect(origin?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, origin ? { origin } : {});
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
    expect(c.msgs[0]).toMatchObject({ type: 'hello', app: 'MockBridge' });
    const motion = c.msgs.filter((m) => m.type === 'motion');
    expect(motion.length).toBeGreaterThanOrEqual(45);
    expect(motion.length).toBeLessThanOrEqual(55);
    expect(c.msgs.some((m) => m.type === 'status')).toBe(true);
    expect(c.bad()).toBe(0);
  });

  it('rejects unknown and missing origins', async () => {
    await expect(connect('https://evil.example').open).rejects.toThrow();
    await expect(connect().open).rejects.toThrow();
  });

  it('answers actions: dry run, unknown, cooldown', async () => {
    const c = connect('https://spiro-12.github.io');
    await c.open;
    const send = (action: string, id: string) => c.ws.send(JSON.stringify({ type: 'action', id, action, label: action, confidence: 0.9, token: '' }));
    send('volume_up', 'a1');
    send('volume_up', 'a2');
    send('launch_rockets', 'a3');
    c.ws.send('garbage');
    c.ws.send(JSON.stringify({ type: 'future_thing' })); // unknown type: ignored, no error
    send('help', 'h1');
    await new Promise((r) => setTimeout(r, 350)); // past the 300 ms normal cooldown
    send('help', 'h2'); // still inside the 600 ms sensitive cooldown
    await new Promise((r) => setTimeout(r, 300));
    c.ws.close();
    const byId = (id: string) => c.msgs.find((m) => 'id' in m && m.id === id);
    expect(byId('a1')).toMatchObject({ type: 'actionResult', ok: true, dryRun: true });
    expect(byId('a2')).toMatchObject({ type: 'error', code: 'cooldown' });
    expect(byId('a3')).toMatchObject({ type: 'error', code: 'unknown_action' });
    expect(c.msgs.filter((m) => m.type === 'error' && m.code === 'bad_json')).toHaveLength(1);
    expect(byId('h1')).toMatchObject({ type: 'actionResult', ok: true });
    expect(byId('h2')).toMatchObject({ type: 'error', code: 'cooldown' });
  });
});

describe('mock bridge pairing (token)', () => {
  it('rejects actions without the right token, accepts the right one', async () => {
    const b = await startMockBridge({ port: 0, token: 'abcdef0123456789abcdef0123456789', cooldownMs: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}`, { origin: 'http://localhost:4173' });
    const msgs: ServerMsg[] = [];
    ws.on('message', (d) => { const m = parseServerMsg(d.toString()); if (m) msgs.push(m); });
    await new Promise<void>((res) => ws.on('open', () => res()));
    const send = (id: string, token: string) => ws.send(JSON.stringify({ type: 'action', id, action: 'volume_up', label: 'v', confidence: 0.9, token }));
    ws.send(JSON.stringify({ type: 'action', id: 't0', action: 'volume_up', label: 'v', confidence: 0.9 })); // no token field
    send('t1', '');
    send('t2', 'ffff0123456789abcdef0123456789ab');
    send('t3', 'abcdef0123456789abcdef0123456789');
    await new Promise((r) => setTimeout(r, 300));
    ws.close();
    await b.close();
    const byId = (id: string) => msgs.find((m) => 'id' in m && m.id === id);
    expect(byId('t0')).toMatchObject({ type: 'error', code: 'unpaired' });
    expect(byId('t1')).toMatchObject({ type: 'error', code: 'unpaired' });
    expect(byId('t2')).toMatchObject({ type: 'error', code: 'unpaired' });
    expect(byId('t3')).toMatchObject({ type: 'actionResult', ok: true });
  });
});
