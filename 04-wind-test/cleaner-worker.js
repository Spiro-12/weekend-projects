// Runs DeepFilterNet 3 (open-source speech cleanup, MIT/Apache-2.0) in the browser, 10 ms at a time
// like a live call would. The WebAssembly build in df/ comes from scripts/build-deepfilter-wasm.sh.
//
// One worker lives for the whole visit, so the files are downloaded once (ideally at home on Wi-Fi) and
// recordings outside work without signal. The model remembers recent audio between frames, so every
// recording gets a brand-new model state (df_create), which is freed afterwards (df_free).
import init, { df_create, df_free, df_get_frame_length, df_process_frame } from './df/df.js';
import { analyze } from './analyze.js';

// DFN3's output lag: (fft 960 - hop 480) + lookahead 2 x hop 480 = 1440 samples (30 ms at 48 kHz).
const DELAY = 1440;

const t0 = performance.now();
const ready = (async () => {
  await init(new URL('./df/df_bg.wasm', import.meta.url));
  const res = await fetch(new URL('./model/DeepFilterNet3_onnx.tar.gz', import.meta.url));
  if (!res.ok) throw new Error(`model download failed (${res.status})`);
  const modelBytes = new Uint8Array(await res.arrayBuffer());
  // Build one state now so a broken model shows up before the first recording, not after.
  df_free(df_create(modelBytes, 100));
  return { modelBytes, loadSeconds: (performance.now() - t0) / 1000 };
})();

ready.then(
  (m) => self.postMessage({ type: 'ready', loadSeconds: m.loadSeconds }),
  (err) => self.postMessage({ type: 'loadError', error: message(err) }),
);

function message(err) {
  return String(err && err.message ? err.message : err);
}

function clean(modelBytes, x) {
  const start = performance.now();
  const state = df_create(modelBytes, 100);
  const setupSeconds = (performance.now() - start) / 1000;
  try {
    const frame = df_get_frame_length(state);
    const total = x.length + DELAY;
    const out = new Float32Array(total);
    const input = new Float32Array(frame);
    const t = performance.now();
    for (let i = 0; i < total; i += frame) {
      input.fill(0);
      const n = Math.min(frame, x.length - i);
      if (n > 0) input.set(x.subarray(i, i + n));
      const y = df_process_frame(state, input);
      const m = Math.min(frame, total - i);
      out.set(m === frame ? y : y.subarray(0, m), i);
    }
    // Time for the recording itself (not the extra 30 ms of padding or the model setup).
    const seconds = ((performance.now() - t) / 1000) * (x.length / total);
    return { samples: out.slice(DELAY, DELAY + x.length), seconds, setupSeconds };
  } finally {
    df_free(state);
  }
}

self.onmessage = async (e) => {
  const { id, samples } = e.data;
  try {
    const { modelBytes } = await ready;
    const { samples: cleaned, seconds, setupSeconds } = clean(modelBytes, samples);
    self.postMessage(
      { type: 'result', id, cleaned, cleanedAnalysis: analyze(cleaned, 48000), cleanSeconds: seconds, setupSeconds },
      [cleaned.buffer],
    );
  } catch (err) {
    // A crash inside the WebAssembly can leave it broken; tell the page to start a new worker.
    self.postMessage({ type: 'result', id, error: message(err), broken: err instanceof WebAssembly.RuntimeError });
  }
};
