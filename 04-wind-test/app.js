import { analyze, windWords, overloadWords, wavBlob } from './analyze.js';
import { voiceInWind } from './demo.js';

const SECONDS = 8;
const RATE = 48000;
const SENTENCES = [
  'The birch canoe slid on the smooth planks.',
  'Glue the sheet to the dark blue background.',
  "It's easy to tell the depth of a well.",
  'These days a chicken leg is a rare dish.',
  'Rice is often served in round bowls.',
];
const params = new URLSearchParams(location.search);
// The iPhone's own mic is called "iPhone Microphone" on iOS. Any other named input (AirPods, Beats, ...) counts
// as the headset, whatever the user named it. `?builtin=` overrides the pattern for automated tests.
const BUILT_IN = new RegExp(params.get('builtin') || 'iphone|built-?in', 'i');

const takes = [];
let busy = false;
let statusText = '';
let statusIsError = false;
let countdown = null; // null = idle, 0 = getting ready, 1..8 = seconds left
let player = null; // { audio, key }
let nextId = 1;

// ---- AI workers: one per recording (see cleaner-worker.js), the next one always warming up. ----
let spare = null;
let ai = 'loading'; // loading | ready | error
let aiError = '';

function newWorker() {
  const h = { w: new Worker(new URL('./cleaner-worker.js', import.meta.url), { type: 'module' }), take: null };
  h.w.onmessage = (e) => onWorker(h, e.data);
  h.w.onerror = (e) => { e.preventDefault(); workerFailed(h, e.message || 'The AI stopped working.'); };
  h.w.onmessageerror = () => workerFailed(h, 'The AI sent back something unreadable.');
  return h;
}

function warmSpare() {
  spare = newWorker();
  if (ai !== 'ready') ai = 'loading';
  render();
}

function onWorker(h, m) {
  if (m.type === 'ready') {
    if (h === spare) { ai = 'ready'; aiError = ''; render(); }
  } else if (m.type === 'loadError') {
    if (h === spare) { ai = 'error'; aiError = m.error; render(); }
  } else if (m.type === 'result') {
    const t = h.take;
    if (t && t.id === m.id) {
      if (m.error) t.error = `The AI couldn't clean this one: ${m.error}`;
      else Object.assign(t, { cleaned: m.cleaned, cleanedAnalysis: m.cleanedAnalysis, cleanSeconds: m.cleanSeconds, loadSeconds: m.loadSeconds });
    }
    h.w.terminate();
    render();
  }
}

function workerFailed(h, msg) {
  h.w.terminate();
  if (h.take && !h.take.cleaned && !h.take.error) h.take.error = `The AI couldn't clean this one: ${msg}`;
  if (h === spare) { ai = 'error'; aiError = msg; spare = null; }
  render();
}

function sendToAI(take) {
  const h = spare || newWorker();
  warmSpare(); // the next recording gets a fresh one
  h.take = take;
  const copy = take.original.slice();
  h.w.postMessage({ id: take.id, samples: copy }, [copy.buffer]);
}

// ---- helpers ----
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function setStatus(text, isError = false) {
  statusText = text;
  statusIsError = isError;
  render();
}

function stem(t) {
  const d = t.date.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  return `${d}-${t.kind}`;
}

/** Resamples to 48 kHz if the browser ignored our requested rate. */
async function to48k(x, rate) {
  if (rate === RATE) return x;
  const len = Math.ceil((x.length * RATE) / rate);
  const off = new OfflineAudioContext(1, len, RATE);
  const buf = off.createBuffer(1, x.length, rate);
  buf.copyToChannel(x, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}

function newAudioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  try { return new AC({ sampleRate: RATE }); } catch { return new AC(); }
}

async function openMic(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      // On iPhone, echo cancellation switches on the same voice processing a call uses.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
}

// ---- recording ----
async function record(kind) {
  if (busy) return;
  busy = true;
  stopPlayback();
  countdown = 0;
  setStatus('');
  // A fresh audio context per recording, created inside the tap, closed afterwards: reusing one across
  // Bluetooth route changes is unreliable on iPhone, and a live one can keep the AirPods in call mode.
  const ac = newAudioContext();
  let stream = null;
  let src = null;
  let node = null;
  try {
    await ac.resume();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser can’t use the microphone. On iPhone, open this page in Safari.');
    }
    stream = await openMic();
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const real = inputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
    const builtIn = real.find((d) => BUILT_IN.test(d.label));
    const headset = real.find((d) => d.label && !BUILT_IN.test(d.label));
    const want = kind === 'iphone' ? builtIn : headset;
    if (kind === 'iphone' && !want) throw new Error('Couldn’t find the iPhone’s own mic.');

    let track = stream.getAudioTracks()[0];
    if (want && track.getSettings().deviceId !== want.deviceId) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await openMic(want.deviceId);
      track = stream.getAudioTracks()[0];
    }
    const label = track.label || '';
    if (kind === 'airpods' && BUILT_IN.test(label)) {
      throw new Error('This is using the iPhone mic, not your AirPods. Put them in, check they’re connected, then try again.');
    }
    if (kind === 'iphone' && label && !BUILT_IN.test(label)) {
      throw new Error(`Safari wouldn’t switch to the iPhone mic while “${label}” is connected. Use the AirPods button instead.`);
    }
    const settings = track.getSettings ? track.getSettings() : {};

    await ac.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
    src = ac.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ac, 'recorder');
    const sink = ac.createGain();
    sink.gain.value = 0;
    src.connect(node).connect(sink).connect(ac.destination);

    const need = SECONDS * ac.sampleRate;
    const chunks = [];
    let got = 0;
    let startedAt = 0;
    await new Promise((resolve, reject) => {
      let timer = setTimeout(() => fail('The microphone didn’t start. Try again.'), 15000);
      function fail(msg) { clearTimeout(timer); reject(new Error(msg)); }
      track.onended = () => fail('The microphone stopped (did the AirPods disconnect?). Try again.');
      ac.onstatechange = () => {
        if (ac.state !== 'running') fail('Recording was interrupted (screen locked, or another app took the mic). Keep the page open and try again.');
      };
      node.port.onmessage = (e) => {
        const c = e.data;
        // Bluetooth mics send silence while they switch into call mode; start the clock on real sound.
        if (got === 0 && !c.some((v) => v !== 0)) return;
        if (got === 0) startedAt = performance.now();
        clearTimeout(timer);
        timer = setTimeout(() => fail('The microphone went quiet. Keep the screen on and try again.'), 3000);
        chunks.push(c);
        got += c.length;
        const left = Math.max(1, Math.ceil((need - got) / ac.sampleRate));
        if (left !== countdown) { countdown = left; render(); }
        if (got >= need) { clearTimeout(timer); resolve(); }
      };
    });
    const observedRate = got / ((performance.now() - startedAt) / 1000);

    const raw = new Float32Array(need);
    let o = 0;
    for (const c of chunks) {
      const n = Math.min(c.length, need - o);
      raw.set(c.subarray(0, n), o);
      o += n;
      if (o >= need) break;
    }
    const samples = await to48k(raw, ac.sampleRate);
    const take = {
      id: nextId++,
      kind,
      date: new Date(),
      sentence: SENTENCES[takes.length % SENTENCES.length],
      mic: label || 'Unknown mic',
      inputs: inputs.map((d) => d.label || '(no name)'),
      trackSettings: settings,
      contextSampleRate: ac.sampleRate,
      observedRate: Math.round(observedRate),
      speedWarning: Math.abs(observedRate / ac.sampleRate - 1) > 0.03,
      original: samples,
      analysis: analyze(samples, RATE),
    };
    takes.unshift(take);
    sendToAI(take);
  } catch (err) {
    statusText = err && err.name === 'NotAllowedError'
      ? 'Microphone access was blocked. In Safari, tap “aA” in the address bar, then Website Settings, and allow the microphone.'
      : (err && err.message) || String(err);
    statusIsError = true;
  } finally {
    if (node) { node.port.onmessage = null; node.disconnect(); }
    if (src) src.disconnect();
    if (stream) stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    ac.onstatechange = null;
    ac.close().catch(() => {});
    countdown = null;
    busy = false;
    render();
  }
}

function addDemo() {
  const samples = voiceInWind();
  const take = {
    id: nextId++, kind: 'demo', date: new Date(), sentence: '(made-up voice)', mic: 'Made-up voice + fake wind',
    inputs: [], trackSettings: {}, contextSampleRate: RATE, observedRate: RATE, speedWarning: false,
    original: samples, analysis: analyze(samples, RATE),
  };
  takes.unshift(take);
  sendToAI(take);
  render();
}

// ---- playback and sharing ----
function blobFor(t, which) {
  t._blobs = t._blobs || {};
  if (!t._blobs[which]) t._blobs[which] = wavBlob(which === 'cleaned' ? t.cleaned : t.original, RATE);
  return t._blobs[which];
}

function urlFor(t, which) {
  t._urls = t._urls || {};
  if (!t._urls[which]) t._urls[which] = URL.createObjectURL(blobFor(t, which));
  return t._urls[which];
}

function play(t, which) {
  const key = `${t.id}-${which}`;
  const same = player && player.key === key;
  stopPlayback();
  if (same) { render(); return; }
  // An <audio> element, not Web Audio, so it plays even when the iPhone is on silent.
  const audio = new Audio(urlFor(t, which));
  audio.onended = () => { if (player && player.audio === audio) { player = null; render(); } };
  player = { audio, key };
  audio.play().catch((err) => { if (player && player.audio === audio) player = null; setStatus(`Could not play: ${err.message}`, true); });
  render();
}

function stopPlayback() {
  if (player) { player.audio.pause(); player = null; }
}

function summary() {
  return {
    page: 'Wind Test (web) 04-wind-test',
    browser: navigator.userAgent,
    notes: [
      'Recorded in the browser with echoCancellation on (on iPhone this uses call-style voice processing; WebKit ignores noiseSuppression/autoGainControl).',
      'All audio is 48 kHz here. observedRate is how fast samples really arrived; far from contextSampleRate means a browser audio bug.',
      'Cleaned files: DeepFilterNet 3 (WebAssembly), a fresh model per take, delay-compensated and time-aligned with the original.',
      'loadSeconds is how long that take’s AI worker took to start (it usually starts before the recording ends).',
    ],
    takes: takes.map((t) => ({
      file: stem(t), kind: t.kind, date: t.date.toISOString(), sentence: t.sentence, mic: t.mic, inputs: t.inputs,
      trackSettings: t.trackSettings, contextSampleRate: t.contextSampleRate, observedRate: t.observedRate,
      original: t.analysis || null, cleaned: t.cleanedAnalysis || null, cleanSeconds: t.cleanSeconds ?? null,
      loadSeconds: t.loadSeconds ?? null, error: t.error || null,
    })),
  };
}

function share() {
  // No awaits before navigator.share: Safari only allows it straight after the tap.
  const files = [];
  for (const t of takes) {
    files.push(new File([blobFor(t, 'original')], `${stem(t)}-original.wav`, { type: 'audio/wav' }));
    if (t.cleaned) files.push(new File([blobFor(t, 'cleaned')], `${stem(t)}-cleaned.wav`, { type: 'audio/wav' }));
  }
  files.push(new File([JSON.stringify(summary(), null, 2)], 'wind-test-summary.txt', { type: 'text/plain' }));
  if (navigator.canShare && navigator.canShare({ files })) {
    navigator.share({ files, title: 'Wind Test recordings' }).catch((err) => {
      if (!err || err.name !== 'AbortError') setStatus(`Couldn’t share: ${err && err.message}`, true);
    });
    return;
  }
  // Computers: download the files one by one.
  files.forEach((f, i) => setTimeout(() => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, i * 400));
}

// ---- screen ----
const KIND_TITLE = { airpods: 'AirPods, like a call', iphone: 'iPhone mic', demo: 'Demo (fake wind)' };

function takeCard(t) {
  const a = t.analysis;
  const cleaning = !t.cleaned && !t.error;
  const btn = (which, label) => {
    const on = player && player.key === `${t.id}-${which}`;
    return `<button class="play ${which}" data-take="${t.id}" data-which="${which}" data-testid="play-${which}-${t.kind}"
      ${busy ? 'disabled' : ''}>${on ? '■ Stop' : `▶ ${label}`}</button>`;
  };
  return `<article class="take" data-testid="take-${t.kind}">
    <header><h3>${esc(KIND_TITLE[t.kind] || t.kind)}</h3><time>${t.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></header>
    <p class="muted">Mic: ${esc(t.mic)}</p>
    <p>${windWords(a)}</p>
    ${overloadWords(a) ? `<p class="warn">${overloadWords(a)}</p>` : ''}
    ${t.speedWarning ? '<p class="warn">The sound came in at the wrong speed (a browser glitch). Please tell Claude.</p>' : ''}
    ${t.cleanSeconds != null ? `<p class="muted small">AI took ${t.cleanSeconds.toFixed(2)} s for ${a.seconds.toFixed(0)} s of sound</p>` : ''}
    ${t.error ? `<p class="error">${esc(t.error)}</p>` : ''}
    ${cleaning ? '<p class="muted"><span class="spinner"></span> Cleaning with AI…</p>' : ''}
    <div class="buttons">${btn('original', 'Original')}${t.cleaned ? btn('cleaned', 'AI cleaned') : ''}</div>
  </article>`;
}

function render() {
  $('sentence').textContent = `“${SENTENCES[takes.length % SENTENCES.length]}”`;
  const aiEl = $('ai');
  aiEl.dataset.state = ai;
  aiEl.textContent = ai === 'ready' ? '✓ AI ready'
    : ai === 'error' ? `The AI didn’t load (${aiError}). It will try again on your next recording.`
    : 'Loading the AI (about 10 MB, best on Wi-Fi)…';
  for (const b of document.querySelectorAll('[data-record]')) b.disabled = busy;
  const rec = $('recording');
  rec.hidden = countdown === null;
  rec.textContent = countdown === 0 ? 'Getting the mic ready… wait' : `Recording… talk now (${countdown})`;
  rec.classList.toggle('live', !!countdown);
  const st = $('status');
  st.hidden = !statusText;
  st.textContent = statusText;
  st.classList.toggle('error', statusIsError);
  $('takes').innerHTML = takes.length
    ? takes.map(takeCard).join('')
    : '<p class="muted empty">Nothing yet. Go somewhere windy, put your AirPods in, and tap a button above.</p>';
  $('share').hidden = takes.length === 0;
}

document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-record]');
  if (r) { record(r.dataset.record); return; }
  const p = e.target.closest('[data-take]');
  if (p) { const t = takes.find((x) => x.id === Number(p.dataset.take)); if (t) play(t, p.dataset.which); return; }
  if (e.target.closest('#share')) share();
});

window.addEventListener('beforeunload', (e) => { if (takes.length) e.preventDefault(); });

warmSpare(); // download the AI now (ideally at home on Wi-Fi), not after the first outdoor recording
if (params.has('demo')) addDemo();
render();
window.__windTest = { takes, summary, addDemo, aiState: () => ai };
