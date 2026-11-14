// End-to-end check of the Wind Test page in headless Chromium with a fake microphone.
// Run from the repo root:  node 04-wind-test/test/e2e.mjs [screenshot-dir]
// Needs Playwright with Chromium (set PLAYWRIGHT_MODULE to its path if it isn't installed here).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { voiceInWind } from '../demo.js';
import { wavBlob, analyze } from '../analyze.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] || os.tmpdir();
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

// Fake microphone: the made-up voice in wind, as a WAV the browser loops.
const micWav = path.join(os.tmpdir(), 'wind-test-fake-mic.wav');
fs.writeFileSync(micWav, Buffer.from(await wavBlob(voiceInWind(), 48000).arrayBuffer()));

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micWav}`],
});
const failures = [];
const check = (ok, what) => { console.log(`${ok ? '✔' : '✖'} ${what}`); if (!ok) failures.push(what); };
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${base}?demo`);
  await page.getByTestId('play-cleaned-demo').waitFor({ timeout: 120000 });
  check(true, 'demo recording gets cleaned by the AI');
  const demo = await page.evaluate(() => window.__windTest.summary().takes.find((t) => t.kind === 'demo'));
  check(demo.cleaned.lowRumblePercent < demo.original.lowRumblePercent, `AI cuts the fake wind (${demo.original.lowRumblePercent.toFixed(0)}% → ${demo.cleaned.lowRumblePercent.toFixed(0)}% rumble)`);
  check(demo.cleaned.levelDB > -60, `some sound survives (${demo.cleaned.levelDB.toFixed(1)} dB)`);
  check(demo.cleanSeconds < demo.original.seconds, `AI is faster than real time (${demo.cleanSeconds.toFixed(2)} s for ${demo.original.seconds} s)`);

  // Alignment: the cleaned copy lines up with the original (the model's 30 ms delay is removed).
  const lag = await page.evaluate(() => {
    const t = window.__windTest.takes.find((x) => x.kind === 'demo');
    const a = t.original, b = t.cleaned;
    let best = -Infinity, bestLag = 0;
    for (let lag = -2400; lag <= 2400; lag += 48) {
      let c = 0;
      for (let i = 3000; i < a.length - 3000; i += 4) c += a[i] * b[i + lag];
      if (c > best) { best = c; bestLag = lag; }
    }
    return bestLag;
  });
  check(Math.abs(lag) <= 480, `cleaned audio is time-aligned (lag ${lag} samples)`);

  await page.getByTestId('record-iphone').click();
  await page.getByTestId('play-cleaned-iphone').waitFor({ timeout: 60000 });
  const rec = await page.evaluate(() => window.__windTest.summary().takes.find((t) => t.kind === 'iphone'));
  check(rec.original.seconds === 8, `iPhone-mic take is 8 s (${rec.original.seconds} s, mic "${rec.mic}")`);
  check(rec.original.levelDB > -50, `the fake mic was actually recorded (${rec.original.levelDB.toFixed(1)} dB)`);

  await page.getByTestId('record-airpods').click();
  await page.locator('#status.error').waitFor({ timeout: 15000 });
  check((await page.locator('#status').innerText()).includes('AirPods'), 'no AirPods → a clear message');

  await page.getByTestId('play-cleaned-iphone').click();
  check((await page.getByTestId('play-cleaned-iphone').innerText()).includes('Stop'), 'play button turns into Stop');
  await page.getByTestId('play-cleaned-iphone').click();

  await page.screenshot({ path: path.join(shots, 'wind-test-light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(shots, 'wind-test-dark.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, 'no sideways scrolling at phone width');
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  // Same maths in Node and the browser.
  check(Math.abs(analyze(voiceInWind(), 48000).lowRumblePercent - demo.original.lowRumblePercent) < 0.5, 'analysis matches Node');
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
