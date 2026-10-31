// Mock of the Mac app ("SilentSpeechBridge"). Speaks PROTOCOL.md v1 over ws://localhost:PORT.
// CLI: npx tsx tests/mock-bridge.ts [--port 8765] [--armed] [--drop 0.05] [--bad 50] [--seed 7] [--every 4]
// Programmatic: const b = await startMockBridge({ port: 9000 }); ...; await b.close();
import { WebSocketServer, type WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import classesJson from '../shared/classes.json' with { type: 'json' };
import type { ActionResultMsg, ClassDef, ErrorMsg, ServerMsg } from '../web/src/core/contracts';
import { NONE } from '../web/src/core/contracts';
import { parseClientMsg } from '../web/src/core/validate';
import { MotionSynth, fakeHello, fakeStatus } from '../web/src/core/synth';

export const ALLOWED_ORIGINS = ['https://spiro-12.github.io', 'http://localhost:5173', 'http://localhost:4173'];

export interface MockBridgeOpts {
  port?: number;
  hz?: number;
  armed?: boolean;
  dropRate?: number;
  badEvery?: number; // send an invalid frame every N motion frames (0 = never)
  utterEvery?: number; // seconds between random fake sentences (0 = never)
  seed?: number;
  cooldownMs?: number;
}

export interface MockBridge {
  port: number;
  close(): Promise<void>;
  sent: { motion: number; bad: number };
  actions: { action: string; dryRun: boolean }[];
}

export async function startMockBridge(o: MockBridgeOpts = {}): Promise<MockBridge> {
  const port = o.port ?? 8765, hz = o.hz ?? 25, armed = o.armed ?? false, cooldownMs = o.cooldownMs ?? 3000;
  const classes = classesJson as ClassDef[];
  const actions = classes.filter((c) => c.action).map((c) => c.action as string);
  const synth = new MotionSynth(o.seed ?? 7, { hz, dropRate: o.dropRate ?? 0 });
  const wss = new WebSocketServer({
    port,
    host: '127.0.0.1',
    verifyClient: ({ origin }: { origin?: string }) => !origin || ALLOWED_ORIGINS.includes(origin),
  });
  await new Promise<void>((res) => wss.once('listening', () => res()));
  const state: MockBridge = { port, sent: { motion: 0, bad: 0 }, actions: [], close: async () => {} };
  const lastRun = new Map<string, number>();
  const send = (ws: WebSocket, m: ServerMsg | string) => ws.readyState === ws.OPEN && ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  const broadcast = (m: ServerMsg | string) => wss.clients.forEach((ws) => send(ws, m));
  const status = () => fakeStatus({ armed, clients: wss.clients.size, simulated: true, hz });

  wss.on('connection', (ws) => {
    send(ws, fakeHello(actions, armed));
    send(ws, status());
    ws.on('message', (data) => {
      const req = parseClientMsg(data.toString());
      if (!req) return send(ws, { type: 'error', code: 'bad_json', message: 'could not parse message' } satisfies ErrorMsg);
      if (!actions.includes(req.action))
        return send(ws, { type: 'error', code: 'unknown_action', message: `unknown action ${req.action}`, id: req.id } satisfies ErrorMsg);
      const now = Date.now();
      if (now - (lastRun.get(req.action) ?? 0) < cooldownMs)
        return send(ws, { type: 'error', code: 'cooldown', message: 'too soon', id: req.id } satisfies ErrorMsg);
      lastRun.set(req.action, now);
      state.actions.push({ action: req.action, dryRun: !armed });
      send(ws, {
        type: 'actionResult', id: req.id, action: req.action, ok: true, dryRun: !armed,
        message: armed ? `Mock ran ${req.action}` : `Dry run: ${req.action}`, ms: 5,
      } satisfies ActionResultMsg);
    });
  });

  // Stream motion on the hz grid in real time.
  const t0 = performance.now(), T0 = 5000;
  let k = 0, nextUtter = o.utterEvery ?? 4;
  const pool = classes.filter((c) => c.id !== NONE);
  const rng = () => Math.random();
  const motionTimer = setInterval(() => {
    const el = (performance.now() - t0) / 1000;
    if ((o.utterEvery ?? 4) > 0 && el > nextUtter) {
      synth.utter(pool[Math.floor(rng() * pool.length)], T0 + el + 0.1);
      nextUtter += o.utterEvery ?? 4;
      synth.prune(T0 + el - 5);
    }
    for (; k <= Math.floor(el * hz); k++) {
      const s = synth.sampleAt(T0 + k / hz);
      if (!s) continue;
      broadcast({ type: 'motion', ...s });
      state.sent.motion++;
      if (o.badEvery && state.sent.motion % o.badEvery === 0) { broadcast('{"type":"motion","seq":"oops"}'); state.sent.bad++; }
    }
  }, 20);
  const statusTimer = setInterval(() => broadcast(status()), 1000);

  state.close = async () => {
    clearInterval(motionTimer);
    clearInterval(statusTimer);
    wss.clients.forEach((ws) => ws.terminate());
    await new Promise<void>((res) => wss.close(() => res()));
  };
  return state;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const num = (k: string) => (val(k) !== undefined ? Number(val(k)) : undefined);
  startMockBridge({
    port: num('--port'), armed: a.includes('--armed'), dropRate: num('--drop'), badEvery: num('--bad'),
    seed: num('--seed'), utterEvery: num('--every'),
  }).then((b) => console.log(`mock bridge on ws://127.0.0.1:${b.port}`));
}
