// Security + protocol check for the running Mac app (SETUP.md step 4). Prints PASS / FAIL lines, exits 1 on any FAIL.
// Run from 01-silent-speech/ (after `npm ci`):
//   npx tsx mac/check-bridge.ts                          normal run against the app on 8765
//   npx tsx mac/check-bridge.ts --expect-no-origin-open  when the app was launched with --allow-no-origin
//   npx tsx mac/check-bridge.ts --port 18765 --token-file <f>   against the mock bridge (npm run bridge -- --token <hex>)
// Pairing: the token comes from ~/.silentspeech/token (or --token-file) and is never printed.
// Safety: it only sends volume_up (plus one made up action name), and only while hello and the latest status both
// say armed: false, so it is always a dry run.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { HelloMsg, MotionMsg, StatusMsg } from '../web/src/core/contracts';
import { parseServerFrame } from '../web/src/core/validate';

const argv = process.argv.slice(2);
const portAt = argv.indexOf('--port');
const port = portAt >= 0 ? Number(argv[portAt + 1]) : 8765;
const expectNoOriginOpen = argv.includes('--expect-no-origin-open');
const tokenAt = argv.indexOf('--token-file');
const tokenFile = tokenAt >= 0 ? argv[tokenAt + 1] : path.join(os.homedir(), '.silentspeech', 'token');
const appLog = path.join(os.homedir(), 'Library', 'Logs', 'SilentSpeechBridge.log');
const REAL_APP_PORT = 8765;
const GOOD_ORIGIN = 'https://spiro-12.github.io';

let failed = 0;
function report(ok: boolean, what: string, extra = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? `  (${extra})` : ''}`);
}
const skip = (what: string) => console.log(`SKIP  ${what}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Frame = { kind: 'msg' | 'unknown' | 'invalid'; msg?: Record<string, unknown>; raw: string };

/** Every frame from the server, checked with parseServerFrame. next() waits for the first match. */
class Inbox {
  frames: Frame[] = [];
  private waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame | null) => void }[] = [];

  constructor(ws: WebSocket) {
    ws.on('message', (data: WebSocket.RawData) => {
      const raw = Buffer.isBuffer(data) ? data.toString('utf8')
        : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8');
      const parsed = parseServerFrame(raw);
      const frame: Frame = { kind: parsed.kind, raw };
      if (parsed.kind === 'msg') frame.msg = parsed.msg as unknown as Record<string, unknown>;
      this.frames.push(frame);
      for (const w of [...this.waiters]) {
        if (w.pred(frame)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(frame); }
      }
    });
  }

  ofType<T>(type: string): T[] {
    return this.frames.filter((f) => f.msg?.type === type).map((f) => f.msg as unknown as T);
  }

  next(pred: (f: Frame) => boolean, ms = 1500): Promise<Frame | null> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); resolve(null); }
      }, ms);
    });
  }
}

interface Conn { ws: WebSocket; box: Inbox; open: boolean; reason: string }

/** Opens a socket with this Origin (or none). The inbox listens before 'open': hello can come in the same read. */
function connect(url: string, origin: string | undefined, timeoutMs = 3000): Promise<Conn> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const box = new Inbox(ws);
    const timer = setTimeout(() => { ws.terminate(); resolve({ ws, box, open: false, reason: 'timeout' }); }, timeoutMs);
    ws.once('open', () => { clearTimeout(timer); resolve({ ws, box, open: true, reason: '' }); });
    ws.once('error', (e: Error) => { clearTimeout(timer); resolve({ ws, box, open: false, reason: e.message }); });
  });
}

const local = `ws://127.0.0.1:${port}`;

// (f) pairing token file: 32 lowercase hex, folder 0700, file 0600. Never printed.
let token: string | null = null;
try {
  const text = fs.readFileSync(tokenFile, 'utf8').trim();
  if (/^[0-9a-f]{16,128}$/.test(text)) token = text;
} catch { /* reported below */ }
report(token !== null, '(f) pairing token file holds a token', token ? tokenFile : `${tokenFile} missing or not hex (launch the app once)`);
if (port === REAL_APP_PORT && token) {
  report(token.length === 32, '(f) token is 32 hex chars', `${token.length}`);
  const fileMode = fs.statSync(tokenFile).mode & 0o777;
  const dirMode = fs.statSync(path.dirname(tokenFile)).mode & 0o777;
  report(fileMode === 0o600 && dirMode === 0o700, '(f) token file is 600 and its folder 700',
    `file ${fileMode.toString(8)}, folder ${dirMode.toString(8)}`);
  if (fs.existsSync(appLog)) {
    // Only the --print-pair-url line may hold it.
    const leaks = fs.readFileSync(appLog, 'utf8').split('\n').filter((l) => l.includes(token as string) && !l.includes('#pair='));
    report(leaks.length === 0, '(f) the token is not in the app log (except a --print-pair-url line)', `${leaks.length} line(s)`);
  }
}

// (a) listening only on loopback: lsof, then an active probe of this Mac's network addresses
let lsofOut = '';
try {
  lsofOut = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
} catch (e) {
  const err = e as { code?: string; stdout?: string };
  lsofOut = err.code === 'ENOENT' ? '(no lsof)' : (err.stdout ?? '');
}
if (lsofOut === '(no lsof)') {
  skip('(a) lsof not found');
} else {
  const names = lsofOut.trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/).slice(8).join(' ')).filter(Boolean);
  const onlyLoopback = names.length > 0 && names.every((n) => n.startsWith('127.0.0.1:') || n.startsWith('[::1]:'));
  report(onlyLoopback, `(a) lsof: port ${port} listens on 127.0.0.1 only`, names.join(', ') || 'nothing is listening');
}
const lanAddresses = Object.values(os.networkInterfaces()).flat()
  .filter((a): a is os.NetworkInterfaceInfo => !!a && !a.internal && (a.family === 'IPv4' || (a.family as unknown) === 4))
  .map((a) => a.address);
if (lanAddresses.length === 0) skip('(a) no network addresses to probe (offline?)');
for (const ip of lanAddresses) {
  const probe = await connect(`ws://${ip}:${port}`, GOOD_ORIGIN, 1500);
  report(!probe.open, `(a) not reachable on this Mac's network address ${ip}`, probe.reason);
  if (probe.open) probe.ws.close();
}

// (b) a random website is rejected at the handshake
const evil = await connect(local, 'https://evil.example');
report(!evil.open, '(b) Origin https://evil.example is rejected', evil.reason);
if (evil.open) evil.ws.close();

// (d) no Origin: rejected unless the app was launched with --allow-no-origin
const none = await connect(local, undefined);
if (expectNoOriginOpen) report(none.open, '(d) no Origin connects (app launched with --allow-no-origin)', none.reason);
else report(!none.open, '(d) no Origin is rejected', none.reason);
if (none.open) none.ws.close();

// (c) the GitHub Pages dashboard connects and gets hello, then status
const good = await connect(local, GOOD_ORIGIN);
report(good.open, `(c) Origin ${GOOD_ORIGIN} connects`, good.reason);
if (good.open) {
  const { ws, box } = good;
  const helloFrame = await box.next((f) => f.msg?.type === 'hello');
  const hello = helloFrame?.msg as unknown as HelloMsg | undefined;
  report(!!hello, '(c) hello v1 arrives', hello ? `app ${hello.app} ${hello.version}, armed ${hello.armed}` : 'none');
  report(box.frames[0]?.msg?.type === 'hello', '(c) hello comes before anything else', box.frames[0]?.raw.slice(0, 60));
  if (port === REAL_APP_PORT) report(hello?.app === 'SilentSpeechBridge', '(c) port 8765 is the real app', hello?.app);
  const statusFrame = await box.next((f) => f.msg?.type === 'status');
  report(!!statusFrame, '(c) status follows', statusFrame?.raw.slice(0, 120));

  const latestStatus = () => box.ofType<StatusMsg>('status').at(-1);
  /** Never send an action unless hello and the latest status both say "not armed". */
  const safeToSendAction = (what: string) => {
    const ok = hello?.armed === false && latestStatus()?.armed === false;
    if (!ok) report(false, `${what}: refused, the app is Armed (relaunch it: Armed is always off at launch)`);
    return ok;
  };

  // (e) motion rate and seq
  const before = box.ofType<MotionMsg>('motion').length;
  await sleep(2000);
  const motion = box.ofType<MotionMsg>('motion').slice(before);
  const hz = motion.length / 2;
  const steps = motion.slice(1).map((m, i) => m.seq - motion[i].seq);
  // The real app's Simulate mode streams at 50 Hz. The TS mock says simulated: true at 25 Hz, so only check the app.
  if (latestStatus()?.simulated && hello?.app === 'SilentSpeechBridge') {
    report(hz > 40, '(e) Simulate motion streams over 40 Hz', `${hz} Hz`);
    report(motion.length > 1 && steps.every((d) => d === 1), '(e) seq goes up by exactly 1', `steps seen: ${[...new Set(steps)].join(', ')}`);
  } else {
    report(steps.every((d) => d >= 1), '(e) seq only goes up', `${hz} Hz (real app: 0 = no AirPods, launch with --simulate)`);
  }

  // (e) protocol replies
  const errorsBefore = box.ofType<{ id?: string }>('error').length;
  ws.send(JSON.stringify({ type: 'hi-from-the-future', x: 1 }));
  await sleep(300);
  report(box.ofType('error').length === errorsBefore, '(e) unknown type is ignored silently');

  ws.send('{not json');
  const bad = await box.next((f) => f.msg?.type === 'error' && f.msg.code === 'bad_json');
  report(!!bad, '(e) broken JSON -> error bad_json');

  let n = 0;
  /** Sends one action. tok: the token to send, or null to leave the field out. Resolves with the reply frame
   * (with this id, or an error without id sent after it: that is how bad_json answers). */
  const act = async (name: string, tok: string | null) => {
    const id = `chk-${++n}`;
    const msg: Record<string, unknown> = { type: 'action', id, action: name, label: name, confidence: 0.9 };
    if (tok !== null) msg.token = tok;
    const before = box.frames.length;
    const t0 = Date.now();
    ws.send(JSON.stringify(msg));
    const res = await box.next((f) => f.msg?.id === id
      || (f.msg?.type === 'error' && f.msg.id === undefined && box.frames.indexOf(f) >= before));
    return { m: res?.msg, ms: Date.now() - t0 };
  };
  const describe = (r: { m?: Record<string, unknown>; ms: number }) =>
    r.m ? `${String(r.m.type)} ${String(r.m.code ?? '')} "${String(r.m.message)}" in ${r.ms} ms` : 'no reply';
  const isUnpaired = (r: { m?: Record<string, unknown> }) => r.m?.type === 'error' && r.m.code === 'unpaired';
  const isCooldown = (r: { m?: Record<string, unknown> }) => r.m?.type === 'error' && r.m.code === 'cooldown';
  const isDryRun = (r: { m?: Record<string, unknown> }) => r.m?.type === 'actionResult' && r.m.ok === true && r.m.dryRun === true;
  let wrong = randomBytes(16).toString('hex');
  while (wrong === token) wrong = randomBytes(16).toString('hex');

  // (f) pairing: checked before anything else about the action
  if (safeToSendAction('(f) pairing')) {
    const noField = await act('volume_up', null);
    report(isUnpaired(noField), '(f) action with no token -> error unpaired', describe(noField));
    const empty = await act('volume_up', '');
    report(isUnpaired(empty), '(f) action with an empty token -> error unpaired', describe(empty));
    const bad = await act('volume_up', wrong);
    report(isUnpaired(bad), '(f) action with a wrong token -> error unpaired', describe(bad));
    const badUnknown = await act('launch_rockets', wrong);
    report(isUnpaired(badUnknown), '(f) wrong token comes before unknown action -> error unpaired', describe(badUnknown));
  }

  if (token && safeToSendAction('(e) unknown action')) {
    const unknown = await act('launch_rockets', token);
    report(unknown.m?.code === 'unknown_action', '(e) unknown action (paired) -> error unknown_action', describe(unknown));
  }

  if (token && safeToSendAction('(e) dry run')) {
    let first = await act('volume_up', token);
    if (isCooldown(first)) {
      // An earlier run of this check may have used volume_up in the last 3 s: wait it out once.
      await sleep(3200);
      first = await act('volume_up', token);
    }
    report(isDryRun(first) && first.ms < 1000, '(e) volume_up (paired) while not armed -> dry run, reply under 1 s', describe(first));
  }

  if (token && safeToSendAction('(e) cooldown')) {
    const again = await act('volume_up', token);
    report(isCooldown(again), '(e) volume_up again right away -> error cooldown', describe(again));
    const badDuring = await act('volume_up', wrong);
    report(isUnpaired(badDuring), '(f) wrong token during the cooldown -> error unpaired (pairing first)', describe(badDuring));
  }

  if (token && safeToSendAction('(f) unpaired uses no cooldown')) {
    await sleep(3200); // let the 3 s cooldown run out
    const bad = await act('volume_up', wrong);
    const right = await act('volume_up', token);
    report(isUnpaired(bad) && isDryRun(right), '(f) an unpaired action does not use up the cooldown', `${describe(bad)}; then ${describe(right)}`);
  }

  const st = latestStatus();
  if (st) {
    console.log(`INFO  latest status: headphones ${st.headphones}, auth ${st.auth}, loc ${st.loc}, `
      + `hz ${st.hz}, gapPct ${st.gapPct}, clients ${st.clients}, armed ${st.armed}, simulated ${st.simulated}`);
  }
  const invalid = box.frames.filter((f) => f.kind === 'invalid');
  report(invalid.length === 0, `(e) all ${box.frames.length} frames are valid protocol v1`, invalid[0]?.raw.slice(0, 120));
  ws.close();
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
