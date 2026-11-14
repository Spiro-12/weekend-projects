// Runs DeepFilterNet 3 (open-source speech cleanup, MIT/Apache-2.0) in the browser, 10 ms at a time
// like a live call would. The WebAssembly build in df/ comes from scripts/build-deepfilter-wasm.sh.
import init, { df_create, df_get_frame_length, df_process_frame } from './df/df.js';
import { analyze } from './analyze.js';

// DFN3's output lag: (fft 960 - hop 480) + lookahead 2 x hop 480 = 1440 samples (30 ms at 48 kHz).
const DELAY = 1440;
// The model keeps a short memory between frames; this much silence before each take clears the last one.
const FLUSH = 24000;

let state = null;
let frame = 480;
let loadSeconds = 0;

async function ensureModel() {
  if (state !== null) return;
  const t0 = performance.now();
  await init(new URL('./df/df_bg.wasm', import.meta.url));
  const res = await fetch(new URL('./model/DeepFilterNet3_onnx.tar.gz', import.meta.url));
  if (!res.ok) throw new Error(`model download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  state = df_create(bytes, 100);
  frame = df_get_frame_length(state);
  loadSeconds = (performance.now() - t0) / 1000;
}

function clean(x) {
  const total = FLUSH + x.length + DELAY;
  const out = new Float32Array(total);
  const input = new Float32Array(frame);
  const t0 = performance.now();
  for (let i = 0; i < total; i += frame) {
    input.fill(0);
    for (let k = 0; k < frame; k++) {
      const j = i + k - FLUSH;
      if (j >= 0 && j < x.length) input[k] = x[j];
    }
    const y = df_process_frame(state, input);
    const m = Math.min(frame, total - i);
    out.set(m === frame ? y : y.subarray(0, m), i);
  }
  const seconds = (performance.now() - t0) / 1000 * (x.length / total);
  return { samples: out.slice(FLUSH + DELAY, FLUSH + DELAY + x.length), seconds };
}

self.onmessage = async (e) => {
  const { id, samples, sampleRate } = e.data;
  try {
    if (sampleRate !== 48000) throw new Error(`expected 48 kHz audio, got ${sampleRate}`);
    await ensureModel();
    const original = analyze(samples, sampleRate);
    const { samples: cleaned, seconds } = clean(samples);
    self.postMessage(
      { id, ok: true, cleaned, original, cleanedAnalysis: analyze(cleaned, sampleRate), cleanSeconds: seconds, loadSeconds },
      [cleaned.buffer],
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
