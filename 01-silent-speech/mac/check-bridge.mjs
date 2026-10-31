// Security + protocol check for the running Mac app (see SETUP.md step 8).
// Run from 01-silent-speech/ after `npm ci`:  node mac/check-bridge.mjs [port]   (default 8765)
// Also works against the mock bridge:          node mac/check-bridge.mjs 18765
// It only sends actions when hello.armed is false, so they are always dry runs.
import WebSocket from 'ws';

const port = Number(process.argv[2] ?? 8765);
const url = `ws://127.0.0.1:${port}`;
let failed = 0;
const report = (ok, what, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? `  (${extra})` : ''}`);
};

/** Opens a socket with this Origin (or none). Resolves { ws, box, open, reason }. */
function connect(origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const box = inbox(ws); // listen before 'open': hello can arrive in the same read as the handshake
    const timer = setTimeout(() => { ws.terminate(); resolve({ ws, box, open: false, reason: 'timeout' }); }, 3000);
    ws.once('open', () => { clearTimeout(timer); resolve({ ws, box, open: true, reason: '' }); });
    ws.once('error', (e) => { clearTimeout(timer); resolve({ ws, box, open: false, reason: e.message }); });
  });
}

/** Collects parsed frames; next(pred, ms) waits for the first matching one. */
function inbox(ws) {
  const frames = [];
  const waiters = [];
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(String(data)); } catch { m = { type: '(not json)', raw: String(data) }; }
    frames.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  return {
    frames,
    next(pred, ms = 1500) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms);
      });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// (b) a random website is rejected at the handshake
const evil = await connect('https://evil.example');
report(!evil.open, '(b) Origin https://evil.example is rejected', evil.reason);
if (evil.open) evil.ws.close();

// (d) no Origin is rejected while "Allow non browser clients" is off
const none = await connect(undefined);
report(!none.open, '(d) no Origin is rejected (dev toggle must be off)', none.reason);
if (none.open) none.ws.close();

// (c) the GitHub Pages dashboard connects and gets hello, then status
const good = await connect('https://spiro-12.github.io');
report(good.open, '(c) Origin https://spiro-12.github.io connects', good.reason);
if (good.open) {
  const { box } = good;
  const hello = await box.next((m) => m.type === 'hello');
  report(!!hello && hello.v === 1 && Array.isArray(hello.actions) && typeof hello.armed === 'boolean',
    '(c) first message is hello v1', hello ? `app ${hello.app} ${hello.version}, armed ${hello.armed}` : 'none');
  report(box.frames[0]?.type === 'hello', '(c) hello comes before anything else', box.frames[0]?.type);
  const status = await box.next((m) => m.type === 'status');
  report(!!status, '(c) status follows', status ? `headphones ${status.headphones}, auth ${status.auth}, simulated ${status.simulated}` : 'none');

  // (e) protocol: rate, unknown type ignored, bad JSON, unknown action, dry run, cooldown
  const before = box.frames.filter((m) => m.type === 'motion').length;
  await sleep(2000);
  const motion = box.frames.filter((m) => m.type === 'motion');
  const n = motion.length - before;
  const seqOk = motion.every((m, i) => i === 0 || m.seq > motion[i - 1].seq);
  report(seqOk, '(e) motion seq only goes up', `${n / 2} Hz over 2 s; turn on Simulate motion if this is 0`);

  const errorsBefore = box.frames.filter((m) => m.type === 'error').length;
  good.ws.send(JSON.stringify({ type: 'hi-from-the-future', x: 1 }));
  await sleep(300);
  report(box.frames.filter((m) => m.type === 'error').length === errorsBefore, '(e) unknown type is ignored silently');

  good.ws.send('{not json');
  const bad = await box.next((m) => m.type === 'error' && m.code === 'bad_json');
  report(!!bad, '(e) broken JSON -> error bad_json');

  good.ws.send(JSON.stringify({ type: 'action', id: 'chk-unknown', action: 'launch_rockets', label: 'x', confidence: 0.9 }));
  const unknown = await box.next((m) => m.type === 'error' && m.id === 'chk-unknown');
  report(unknown?.code === 'unknown_action', '(e) unknown action -> error unknown_action', unknown?.code);

  if (hello && hello.armed === false) {
    const t0 = Date.now();
    good.ws.send(JSON.stringify({ type: 'action', id: 'chk-1', action: 'volume_up', label: 'volume_up', confidence: 0.9 }));
    const res = await box.next((m) => m.id === 'chk-1');
    const ms = Date.now() - t0;
    // The app might still be cooling down from an earlier run of this check: that is fine too.
    const okRes = res?.type === 'actionResult' && res.ok === true && res.dryRun === true;
    const cooling = res?.type === 'error' && res.code === 'cooldown';
    report((okRes || cooling) && ms < 1000, '(e) action while not armed -> dry run, reply under 1 s',
      res ? `${res.type} ${res.message ?? ''} in ${ms} ms` : 'no reply');
    good.ws.send(JSON.stringify({ type: 'action', id: 'chk-2', action: 'volume_up', label: 'volume_up', confidence: 0.9 }));
    const again = await box.next((m) => m.id === 'chk-2');
    report(again?.type === 'error' && again.code === 'cooldown', '(e) same action again right away -> error cooldown', again?.code);
  } else if (hello) {
    console.log('SKIP  action checks: the app is Armed. Turn Armed off and run again.');
  }
  good.ws.close();
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
