// Sends ONE paired action to the running Mac app and prints the answer (SETUP.md Phase 2). Run from 01-silent-speech/:
//   npx tsx mac/fire-action.ts --action volume_up
//   npx tsx mac/fire-action.ts --action text_mom --yes-really     texts need --yes-really (only after Spiro said OK)
// Options: --port 8765 (default, the real app), --token-file ~/.silentspeech/token, --wait <seconds> to watch the
// app log for "<action> done" / "<action> failed" (default depends on the action), --log-file <path>.
// The token is read from the file and never printed. Exit 0 = the app answered ok (and, if real, the log says done).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import classesJson from '../shared/classes.json' with { type: 'json' };
import type { ClassDef, HelloMsg } from '../web/src/core/contracts';
import { parseServerFrame } from '../web/src/core/validate';

const REAL_APP_PORT = 8765;
const ORIGIN = 'https://spiro-12.github.io';
/** Same list as ProtocolV1.sensitiveActions: these send a real text to a real person. */
const MESSAGING = ['text_mom', 'call_back', 'help'];
/** How long to watch the app log after the reply, per action (seconds). */
const DEFAULT_WAIT: Record<string, number> = {
  text_mom: 20, call_back: 20, help: 20, focus_music: 20, calendar: 40, demo_48h: 10, volume_up: 2,
};

const argv = process.argv.slice(2);
const val = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const action = val('--action');
const port = Number(val('--port') ?? REAL_APP_PORT);
const tokenFile = val('--token-file') ?? path.join(os.homedir(), '.silentspeech', 'token');
const logFile = val('--log-file') ?? path.join(os.homedir(), 'Library', 'Logs', 'SilentSpeechBridge.log');
const yesReally = argv.includes('--yes-really');
const actions = (classesJson as ClassDef[]).filter((c) => c.action).map((c) => c.action as string);

function fail(text: string, code = 1): never {
  console.log(`FAILED: ${text}`);
  process.exit(code);
}

if (!action || !actions.includes(action)) fail(`--action must be one of: ${actions.join(', ')}`, 2);
if (MESSAGING.includes(action) && !yesReally) {
  fail(`${action} sends a real text. Ask Spiro first, then add --yes-really.`, 2);
}
const waitSec = Number(val('--wait') ?? DEFAULT_WAIT[action] ?? 5);

let token = '';
try {
  token = fs.readFileSync(tokenFile, 'utf8').trim();
} catch {
  fail(`no pairing token at ${tokenFile}. Launch the Mac app once (it makes the token).`);
}
if (!/^[0-9a-f]{16,128}$/.test(token)) fail(`${tokenFile} does not hold a token (expected lowercase hex).`);

const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
const frames: Record<string, unknown>[] = [];
const waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown> | null) => void }[] = [];
ws.on('message', (data: WebSocket.RawData) => {
  const parsed = parseServerFrame(data.toString());
  if (parsed.kind !== 'msg') return;
  const msg = parsed.msg as unknown as Record<string, unknown>;
  frames.push(msg);
  for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
});
const next = (pred: (m: Record<string, unknown>) => boolean, ms: number) => new Promise<Record<string, unknown> | null>((resolve) => {
  const hit = frames.find(pred);
  if (hit) return resolve(hit);
  const w = { pred, resolve };
  waiters.push(w);
  setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms);
});

const opened = await new Promise<string>((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 3000);
  ws.once('open', () => { clearTimeout(timer); resolve(''); });
  ws.once('error', (e: Error) => { clearTimeout(timer); resolve(e.message); });
});
if (opened) fail(`could not connect to ws://127.0.0.1:${port} (${opened}). Is the Mac app running?`);

const hello = (await next((m) => m.type === 'hello', 2000)) as unknown as HelloMsg | null;
if (!hello) fail('no hello from the app');
if (port === REAL_APP_PORT && hello.app !== 'SilentSpeechBridge') fail(`port ${port} is not the Mac app (${hello.app})`);
if (!hello.actions.includes(action)) fail(`the app does not offer ${action}`);
const status = await next((m) => m.type === 'status', 2000);
const armed = status ? status.armed === true : hello.armed;
console.log(`Connected to ${hello.app} ${hello.version}. Armed: ${armed ? 'yes (this really runs)' : 'no (this is a dry run)'}`);

const logStart = fs.existsSync(logFile) ? fs.statSync(logFile).size : -1;
const id = `fire-${randomBytes(4).toString('hex')}`;
const t0 = Date.now();
ws.send(JSON.stringify({ type: 'action', id, action, label: action, confidence: 1, token }));
const reply = await next((m) => m.id === id, 2000);
const ms = Date.now() - t0;
if (!reply) fail(`no reply to ${action} within 2 s`);

let ok = false;
if (reply.type === 'actionResult') {
  ok = reply.ok === true;
  const kind = reply.dryRun ? 'dry run' : 'REAL';
  console.log(`Reply in ${ms} ms: ${ok ? 'ok' : 'NOT ok'}, ${kind}, "${String(reply.message)}"${reply.error ? ` (error ${String(reply.error)})` : ''}`);
} else {
  console.log(`Reply in ${ms} ms: error ${String(reply.code)}, "${String(reply.message)}"`);
}
if (ms > 1000) console.log('WARNING: the reply took over 1 s (PROTOCOL §2 says under 1 s)');
ws.close();

// A real run that finishes in the background: watch the app log for its last line.
if (ok && reply.dryRun === false && waitSec > 0) {
  if (logStart < 0) {
    console.log(`(no log at ${logFile}, not waiting for the end)`);
  } else {
    const done = new RegExp(`\\b${action} (done|failed): `);
    const deadline = Date.now() + waitSec * 1000;
    let seen = 0;
    let end: string | undefined;
    while (Date.now() < deadline && !end) {
      await new Promise((r) => setTimeout(r, 250));
      const text = fs.readFileSync(logFile, 'utf8');
      const lines = Buffer.from(text, 'utf8').subarray(Math.max(0, logStart)).toString('utf8').split('\n');
      // Lines about this action only; never echo the pair link line.
      const mine = lines.filter((l) => l.includes(action) && !l.includes('#pair='));
      for (const line of mine.slice(seen)) console.log(`  log: ${line}`);
      seen = mine.length;
      end = mine.find((l) => done.test(l));
    }
    if (!end) {
      console.log(`No "${action} done" line in the log after ${waitSec} s (a popup may be waiting for a click).`);
      ok = false;
    } else if (/ failed: /.test(end)) {
      ok = false;
    }
  }
}
console.log(ok ? 'OK' : 'NOT OK');
process.exit(ok ? 0 : 1);
