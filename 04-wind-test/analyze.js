// Simple numbers that describe a recording. Rough guides, not lab measurements.
// Same maths as the native iPhone version (ClearCall/Analyzer.swift).

export const CLIP = 0.98;
export const RUMBLE_HZ = 150;

/** Second-order Butterworth low-pass (RBJ cookbook), run twice for a steeper cut. */
export function lowpass(x, cutoff, sampleRate) {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cosw) / 2 / a0, b1 = (1 - cosw) / a0, b2 = (1 - cosw) / 2 / a0;
  const a1 = (-2 * cosw) / a0, a2 = (1 - alpha) / a0;
  const pass = (input) => {
    const out = new Float32Array(input.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < input.length; i++) {
      const x0 = input[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = y0;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    return out;
  };
  return pass(pass(x));
}

/** Level (dBFS), share of maxed-out samples (%), share of energy below 150 Hz (%). */
export function analyze(x, sampleRate) {
  if (!x.length) return { sampleRate, seconds: 0, levelDB: -120, clippedPercent: 0, lowRumblePercent: 0 };
  let total = 0, clipped = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    total += v * v;
    if (Math.abs(v) >= CLIP) clipped++;
  }
  const low = lowpass(x, RUMBLE_HZ, sampleRate);
  let lowEnergy = 0;
  for (let i = 0; i < low.length; i++) lowEnergy += low[i] * low[i];
  const rms = Math.sqrt(total / x.length);
  return {
    sampleRate,
    seconds: x.length / sampleRate,
    levelDB: 20 * Math.log10(Math.max(rms, 1e-6)),
    clippedPercent: (100 * clipped) / x.length,
    lowRumblePercent: total > 0 ? Math.min(100, (100 * lowEnergy) / total) : 0,
  };
}

export function windWords(a) {
  if (a.lowRumblePercent >= 50) return 'Lots of wind or rumble';
  if (a.lowRumblePercent >= 20) return 'Some wind or rumble';
  return 'Little or no wind';
}

export function overloadWords(a) {
  return a.clippedPercent >= 0.1 ? `Mic maxed out ${a.clippedPercent.toFixed(1)}% of the time` : null;
}

/** 16-bit mono WAV file. */
export function wavBlob(x, sampleRate) {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
