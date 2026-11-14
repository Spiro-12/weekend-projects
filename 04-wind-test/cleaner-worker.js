// Runs DeepFilterNet 3 (open-source speech cleanup, MIT/Apache-2.0) in the browser, 10 ms at a time
// like a live call would. The WebAssembly build in df/ comes from scripts/build-deepfilter-wasm.sh.
//
// One worker cleans exactly one recording, then the page throws it away. The model remembers recent
// audio between frames and the WebAssembly API has no way to reset or free it, so a fresh worker is the
// only way to make every take start from the same blank state. The page starts the next worker early
// (the files are cached), so it's ready by the time the next recording ends.
import init, { df_create, df_get_frame_length, df_process_frame } from './df/df.js';
import { analyze } from './analyze.js';

// DFN3's output lag: (fft 960 - hop 480) + lookahead 2 x hop 480 = 1440 samples (30 ms at 48 kHz).
const DELAY = 1440;

const t0 = performance.now();
const ready = (async () => {
  await init(new URL('./df/df_bg.wasm', import.meta.url));
  const res = await fetch(new URL('./model/DeepFilterNet3_onnx.tar.gz', import.meta.url));
  if (!res.ok) throw new Error(`model download failed (${res.status})`);
  const state = df_create(new Uint8Array(await res.arrayBuffer()), 100);
  return { state, frame: df_get_frame_length(state), loadSeconds: (performance.now() - t0) / 1000 };
})();

ready.then(
  (m) => self.postMessage({ type: 'ready', loadSeconds: m.loadSeconds }),
  (err) => self.postMessage({ type: 'loadError', error: message(err) }),
);

function message(err) {
  return String(err && err.message ? err.message : err);
}

function clean({ state, frame }, x) {
  const total = x.length + DELAY;
  const out = new Float32Array(total);
  const input = new Float32Array(frame);
  const start = performance.now();
  for (let i = 0; i < total; i += frame) {
    input.fill(0);
    const n = Math.min(frame, x.length - i);
    if (n > 0) input.set(x.subarray(i, i + n));
    const y = df_process_frame(state, input);
    const m = Math.min(frame, total - i);
    out.set(m === frame ? y : y.subarray(0, m), i);
  }
  // Time for the recording itself (not the extra 30 ms of padding).
  const seconds = ((performance.now() - start) / 1000) * (x.length / total);
  return { samples: out.slice(DELAY, DELAY + x.length), seconds };
}

self.onmessage = async (e) => {
  const { id, samples } = e.data;
  try {
    const model = await ready;
    const { samples: cleaned, seconds } = clean(model, samples);
    self.postMessage(
      { type: 'result', id, cleaned, cleanedAnalysis: analyze(cleaned, 48000), cleanSeconds: seconds, loadSeconds: model.loadSeconds },
      [cleaned.buffer],
    );
  } catch (err) {
    self.postMessage({ type: 'result', id, error: message(err) });
  }
};
