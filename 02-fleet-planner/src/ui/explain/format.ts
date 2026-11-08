// Number formatting for the panels and hovers (Track F). Plain US English: "$1.09M", "$675,000 a year", "19 months".
// All unit conversions (cents are never shown; ticks become minutes) happen here or in the panels, never in the sim.
import { TICK_MS } from '../../contracts/types.ts';

const MINUS = '−';

/** Whole number with US thousands separators, or a fixed number of decimals. */
export function num(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return '—';
  const r = Number(v.toFixed(digits));
  return (r < 0 ? MINUS : '') + Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** One decimal only when needed: "600", "1.7". */
export const n1 = (v: number) => num(v, Number.isInteger(Math.round(v * 10) / 10) ? 0 : 1);

/** Dollars, exact: "$1,092,000", "$17.95" (cents under $100), "−$12,000". */
export function usd(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const digits = a > 0 && a < 100 && Math.round(a) !== a ? 2 : 0;
  const r = Number(v.toFixed(digits));
  return (r < 0 ? MINUS : '') + '$' + Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Dollars, short for big panel numbers: "$1.09M", "$675k", "$35.5k", "$1,234", "$1.23". */
export function usdShort(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 && a >= 0.005 ? MINUS : '';
  let s: string;
  if (a >= 999_500) s = `${trim((a / 1e6).toFixed(a >= 9_995_000 ? 1 : 2))}M`;
  else if (a >= 99_950) s = `${Math.round(a / 1000)}k`;
  else if (a >= 10_000) s = `${trim((a / 1000).toFixed(1))}k`;
  else if (a >= 100) s = Math.round(a).toLocaleString('en-US');
  else if (a === 0) s = '0';
  else s = a.toFixed(2);
  return `${sign}$${s}`;
}

const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

/** Payback months for the big number: "4.5" under 10, else whole months. */
export function monthsShort(m: number): string {
  if (!Number.isFinite(m)) return '—';
  return m < 10 ? trim(m.toFixed(1)) : num(Math.round(m));
}

/** "1.6 years" from months, for the line under the payback. */
export function yearsFromMonths(m: number): string {
  const y = m / 12;
  return `${trim(y.toFixed(y < 10 ? 1 : 0))} ${y === 1 ? 'year' : 'years'}`;
}

/** Minutes from seconds, one decimal under 10: "11.5 min", "21 min". */
export function minutes(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  const m = sec / 60;
  return m < 10 ? trim(m.toFixed(1)) : num(Math.round(m));
}

/** A duration in plain words: "45 s", "2 min 10 s", "1 h 05 min". */
export function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}

/** Sim clock from a tick: "hh:mm" of warehouse time since the run started. */
export function clock(tick: number): string {
  const totalMin = Math.floor((tick * TICK_MS) / 60_000);
  return `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/**
 * Any Explained / Sourced value with its unit, in words: "$675,000 a year", "$17.95 an hour", "12% a year",
 * "4,160 hours", "24 robots". Unknown units fall back to "value unit".
 */
export function withUnit(v: number, unit: string): string {
  switch (unit) {
    case 'USD':
      return usd(v);
    case 'USD/yr':
      return `${usd(v)} a year`;
    case 'USD/month':
      return `${usd(v)} a month`;
    case 'USD/h':
      return `${usd(v)} an hour`;
    case 'USD/order':
      return `${usd(v)} per order`;
    case '%':
      return `${num(v, Math.round(v) === v ? 0 : 1)}%`;
    case '%/yr':
      return `${num(v, Math.round(v) === v ? 0 : 1)}% a year`;
    case 'x':
      // A load factor like 0.46 reads better as "+46%" (on top of pay); real multipliers stay "1.5×".
      return v > 0 && v < 1 ? `+${num(v * 100, Math.round(v * 1000) % 10 ? 1 : 0)}%` : `${trim(v.toFixed(2))}×`;
    case 'h':
      return v === 1 ? '1 hour' : `${num(v, Math.round(v) === v ? 0 : 1)} hours`;
    case 'min':
      return `${num(v, Math.round(v) === v ? 0 : 1)} min`;
    case 's':
      return `${num(v, Math.round(v) === v ? 0 : 1)} s`;
    case 'months':
      return `${num(v, v < 10 ? 1 : 0)} months`;
    case 'm/s':
      return `${trim(v.toFixed(2))} m/s`;
    case 'kg':
      return `${num(v)} kg`;
    case 'people/shift':
      return `${plural(v, 'person', 'people')} per shift`;
    case 'robots':
      return plural(v, 'robot');
    case 'orders/h':
      return `${num(v, Math.round(v) === v ? 0 : 1)} orders an hour`;
    default:
      return unit ? `${num(v, Math.round(v) === v ? 0 : 2)} ${unit}` : num(v, Math.round(v) === v ? 0 : 2);
  }
}

/** Short value for a panel number, by unit: money gets the short form. */
export function short(v: number, unit: string): string {
  if (unit === 'USD' || unit === 'USD/yr') return usdShort(v);
  if (unit === 'USD/order') return usd(v);
  if (unit === 'months') return monthsShort(v);
  return withUnit(v, unit);
}

/** Relative closeness, for checking a worked formula against the reported value. */
export function close(a: number, b: number, rel = 0.005): boolean {
  return Math.abs(a - b) <= Math.max(0.011, rel * Math.max(Math.abs(a), Math.abs(b)));
}
