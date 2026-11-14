import { windWords, overloadWords, wavBlob } from './analyze.js';
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
const BLUETOOTH = /airpods|bluetooth|beats|buds|headset|hands-?free/i;

const takes = [];
let ctx = null;
let workletReady = false;
let busy = false;
let statusText = '';
let statusIsError = false;
let countdown = null; // null = idle, 0 = getting ready, 1..8 = seconds left
let player = null; // { audio, key }
let nextId = 1;

const worker = new Worker(new URL('./cleaner-worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (e) => {
  const m = e.data;
  const t = takes.find((x) => x.id === m.id);
  if (!t) return;
  if (m.ok) {
    t.cleaned = m.cleaned;
    t.analysis = m.original;
    t.cleanedAnalysis = m.cleanedAnalysis;
    t.cleanSeconds = m.cleanSeconds;
    t.loadSeconds = m.loadSeconds;
  } else {
    t.error = m.error;
  }
  render();
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    try { ctx = new AC({ sampleRate: RATE }); } catch { ctx = new AC(); }
  }
  return ctx;
}

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

async function openMic(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      // On iPhone these switch on the same voice processing a call uses.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
}

async function pickDevice(kind) {
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  if (kind === 'airpods') return inputs.find((d) => BLUETOOTH.test(d.label));
  return inputs.find((d) => d.label && !BLUETOOTH.test(d.label) && d.deviceId !== 'default' && d.deviceId !== 'communications');
}

async function record(kind) {
  if (busy) return;
  busy = true;
  stopPlayback();
  countdown = 0;
  setStatus('');
  const ac = audioCtx();
  let stream = null;
  let src = null;
  let node = null;
  try {
    await ac.resume();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser can’t use the microphone. On iPhone, open this page in Safari.');
    }
    stream = await openMic();
    const want = await pickDevice(kind);
    if (kind === 'airpods' && !want) {
      throw new Error('Couldn’t find your AirPods. Put them in, check they’re connected, then try again.');
    }
    const current = stream.getAudioTracks()[0].getSettings().deviceId;
    if (want && want.deviceId !== current) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await openMic(want.deviceId);
    }
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};

    if (!workletReady) {
      await ac.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
      workletReady = true;
    }
    src = ac.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ac, 'recorder');
    const sink = ac.createGain();
    sink.gain.value = 0;
    src.connect(node).connect(sink).connect(ac.destination);

    const need = SECONDS * ac.sampleRate;
    const chunks = [];
    let got = 0;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The microphone didn’t start. Try again.')), 15000);
      node.port.onmessage = (e) => {
        const c = e.data;
        // Bluetooth mics send silence while they switch into call mode; start the clock on real sound.
        if (got === 0 && !c.some((v) => Math.abs(v) > 1e-4)) return;
        clearTimeout(timeout);
        chunks.push(c);
        got += c.length;
        const left = Math.max(1, Math.ceil((need - got) / ac.sampleRate));
        if (left !== countdown) { countdown = left; render(); }
        if (got >= need) resolve();
      };
    });

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
      mic: track.label || 'Unknown mic',
      micSampleRate: settings.sampleRate || null,
      contextSampleRate: ac.sampleRate,
      original: samples,
    };
    takes.unshift(take);
    const copy = samples.slice();
    worker.postMessage({ id: take.id, samples: copy, sampleRate: RATE }, [copy.buffer]);
  } catch (err) {
    const msg = err && err.name === 'NotAllowedError'
      ? 'Microphone access was blocked. In Safari, tap “aA” in the address bar, then Website Settings, and allow the microphone.'
      : (err && err.message) || String(err);
    statusText = msg;
    statusIsError = true;
  } finally {
    if (node) { node.port.onmessage = null; node.disconnect(); }
    if (src) src.disconnect();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    countdown = null;
    busy = false;
    render();
  }
}

function addDemo() {
  const samples = voiceInWind();
  const take = {
    id: nextId++, kind: 'demo', date: new Date(), sentence: '(made-up voice)',
    mic: 'Made-up voice + fake wind', micSampleRate: RATE, contextSampleRate: RATE, original: samples,
  };
  takes.unshift(take);
  const copy = samples.slice();
  worker.postMessage({ id: take.id, samples: copy, sampleRate: RATE }, [copy.buffer]);
  render();
}

function urlFor(t, which) {
  const key = which === 'cleaned' ? '_cleanedUrl' : '_originalUrl';
  if (!t[key]) t[key] = URL.createObjectURL(wavBlob(which === 'cleaned' ? t.cleaned : t.original, RATE));
  return t[key];
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
  audio.play().catch((err) => setStatus(`Could not play: ${err.message}`, true));
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
      'Recorded in the browser with echoCancellation/noiseSuppression/autoGainControl on, which on iPhone uses the same voice processing as calls.',
      'All audio is 48 kHz here; micSampleRate (if the browser reports it) is the real mic rate. 16000 or 24000 means Bluetooth call mode.',
      'Cleaned files: DeepFilterNet 3 (WebAssembly), delay-compensated, time-aligned with the original.',
    ],
    takes: takes.map((t) => ({
      file: stem(t), kind: t.kind, date: t.date.toISOString(), sentence: t.sentence, mic: t.mic,
      micSampleRate: t.micSampleRate, contextSampleRate: t.contextSampleRate, original: t.analysis || null,
      cleaned: t.cleanedAnalysis || null, cleanSeconds: t.cleanSeconds ?? null, loadSeconds: t.loadSeconds ?? null,
      error: t.error || null,
    })),
  };
}

async function share() {
  const files = [];
  for (const t of takes) {
    files.push(new File([wavBlob(t.original, RATE)], `${stem(t)}-original.wav`, { type: 'audio/wav' }));
    if (t.cleaned) files.push(new File([wavBlob(t.cleaned, RATE)], `${stem(t)}-cleaned.wav`, { type: 'audio/wav' }));
  }
  files.push(new File([JSON.stringify(summary(), null, 2)], 'wind-test-summary.txt', { type: 'text/plain' }));
  try {
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title: 'Wind Test recordings' });
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

const KIND_TITLE = { airpods: 'AirPods, like a call', iphone: 'iPhone mic', demo: 'Demo (fake wind)' };

function takeCard(t) {
  const a = t.analysis;
  const cleaning = !t.cleaned && !t.error;
  const btn = (which, label) => {
    const on = player && player.key === `${t.id}-${which}`;
    return `<button class="play ${which}" data-take="${t.id}" data-which="${which}" data-testid="play-${which}-${t.kind}"
      ${busy ? 'disabled' : ''}>${on ? '■ Stop' : `▶ ${label}`}</button>`;
  };
  const rate = t.micSampleRate ? `, ${Math.round(t.micSampleRate / 1000)} kHz` : '';
  return `<article class="take" data-testid="take-${t.kind}">
    <header><h3>${esc(KIND_TITLE[t.kind] || t.kind)}</h3><time>${t.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></header>
    <p class="muted">Mic: ${esc(t.mic)}${rate}</p>
    ${a ? `<p>${windWords(a)}</p>` : ''}
    ${a && overloadWords(a) ? `<p class="warn">${overloadWords(a)}</p>` : ''}
    ${t.cleanSeconds != null && a ? `<p class="muted small">AI took ${t.cleanSeconds.toFixed(2)} s for ${a.seconds.toFixed(0)} s of sound</p>` : ''}
    ${t.error ? `<p class="error">${esc(t.error)}</p>` : ''}
    ${cleaning ? '<p class="muted"><span class="spinner"></span> Cleaning with AI… (the first one takes a bit longer)</p>' : ''}
    <div class="buttons">${btn('original', 'Original')}${t.cleaned ? btn('cleaned', 'AI cleaned') : ''}</div>
  </article>`;
}

function render() {
  $('sentence').textContent = `“${SENTENCES[takes.length % SENTENCES.length]}”`;
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
  $('share').hidden = !takes.some((t) => t.cleaned);
}

document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-record]');
  if (r) { record(r.dataset.record); return; }
  const p = e.target.closest('[data-take]');
  if (p) { const t = takes.find((x) => x.id === Number(p.dataset.take)); if (t) play(t, p.dataset.which); return; }
  if (e.target.closest('#share')) share();
});

window.addEventListener('beforeunload', (e) => { if (takes.length) e.preventDefault(); });

if (new URLSearchParams(location.search).has('demo')) addDemo();
render();
window.__windTest = { takes, summary };
