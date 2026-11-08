// Number formatting for the plain-English formula strings in every Explained (PROTOCOL §7).
// Hand-written (no Intl / toLocaleString), so the same numbers give the same strings in every JS engine and locale.

const MINUS = '−';

/** 1234567 → "1,234,567" (a non-negative integer string). */
function group(intDigits: string): string {
  let out = '';
  for (let i = 0; i < intDigits.length; i++) {
    if (i > 0 && (intDigits.length - i) % 3 === 0) out += ',';
    out += intDigits[i];
  }
  return out;
}

/** A number with thousands separators and at most `maxDecimals` decimals, trailing zeros dropped: 4160 → "4,160", 1.46 → "1.46", 0.40 → "0.4". */
export function num(v: number, maxDecimals = 2): string {
  if (!Number.isFinite(v)) return String(v);
  const fixed = Math.abs(v).toFixed(maxDecimals);
  const [i, d = ''] = fixed.split('.');
  const dec = d.replace(/0+$/, '');
  const body = group(i) + (dec ? `.${dec}` : '');
  return v < 0 && /[1-9]/.test(fixed) ? MINUS + body : body;
}

/** A number with exactly `decimals` decimals (for months, ratios): 19.413 → "19.4", 44 → "44.0". */
export function fixed(v: number, decimals = 1): string {
  const f = Math.abs(v).toFixed(decimals);
  const [i, d] = f.split('.');
  const body = group(i) + (d ? `.${d}` : '');
  return v < 0 && /[1-9]/.test(f) ? MINUS + body : body;
}

/** Whole dollars: 1092000 → "$1,092,000", -12000 → "−$12,000". */
export function usd(v: number): string {
  const r = Math.round(Math.abs(v));
  return (v < 0 && r > 0 ? MINUS : '') + '$' + group(String(r));
}

/** Dollars and cents: 1.0834 → "$1.08". */
export function usd2(v: number): string {
  const f = Math.abs(v).toFixed(2);
  const [i, d] = f.split('.');
  return (v < 0 && /[1-9]/.test(f) ? MINUS : '') + '$' + group(i) + '.' + d;
}

/** A price as it is written in the data: cents only when there are any: 17.95 → "$17.95", 30 → "$30". */
export function price(v: number): string {
  return Number.isInteger(v) ? usd(v) : usd2(v);
}

/** "1 picker" / "14 pickers". */
export function count(n: number, one: string, many: string): string {
  return `${num(n, 1)} ${n === 1 ? one : many}`;
}
