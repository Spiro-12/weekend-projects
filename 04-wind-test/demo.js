import { lowpass } from './analyze.js';

/** A made-up "voice" (a buzzy tone rising and falling like syllables) mixed with fake gusty wind, at 48 kHz.
 *  Used by the automated test and the `?demo` link, where there is no microphone. */
export function voiceInWind(seconds = 5, sampleRate = 48000, seed = 7) {
  let s = seed >>> 0;
  const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1; };
  const n = Math.floor(seconds * sampleRate);
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = rand();
  const wind = lowpass(noise, 200, sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t));
    const f0 = 130 + 20 * Math.sin(2 * Math.PI * 0.7 * t);
    let voice = 0;
    for (let h = 1; h <= 12; h++) voice += Math.sin(2 * Math.PI * f0 * h * t) / h;
    const gust = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.3 * t);
    out[i] = Math.max(-1, Math.min(1, 0.25 * syllable * voice + 14 * gust * wind[i]));
  }
  return out;
}
