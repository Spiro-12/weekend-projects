// Hand written type guards for everything that crosses a boundary (WebSocket, files).
import type {
  ClientMsg, Dataset, MotionSample, ServerMsg, Session,
} from './contracts';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const isNumArr = (x: unknown, n: number) => Array.isArray(x) && x.length === n && x.every(isNum);
const oneOf = (x: unknown, opts: readonly string[]) => isStr(x) && opts.includes(x);

export function isMotionSample(x: unknown): x is MotionSample {
  if (!isObj(x)) return false;
  return isNum(x.seq) && isNum(x.t) && isNumArr(x.q, 4) && isNumArr(x.rr, 3) && isNumArr(x.ua, 3)
    && (x.g === undefined || isNumArr(x.g, 3));
}

function toObj(raw: unknown): Record<string, unknown> | null {
  if (isStr(raw)) {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  return isObj(raw) ? raw : null;
}

/** Parses a Mac -> browser message. Returns null if invalid. Unknown types also return null (ignore them). */
export function parseServerMsg(raw: unknown): ServerMsg | null {
  const m = toObj(raw);
  if (!m) return null;
  switch (m.type) {
    case 'hello':
      return m.v === 1 && isStr(m.app) && isStr(m.version) && Array.isArray(m.actions)
        && m.actions.every(isStr) && isBool(m.armed) ? (m as unknown as ServerMsg) : null;
    case 'status':
      return oneOf(m.headphones, ['connected', 'disconnected', 'unavailable'])
        && oneOf(m.auth, ['authorized', 'denied', 'notDetermined', 'restricted'])
        && oneOf(m.loc, ['left', 'right', 'default', 'unknown'])
        && isNum(m.hz) && isNum(m.gapPct) && isNum(m.clients) && isBool(m.armed) && isBool(m.simulated)
        ? (m as unknown as ServerMsg) : null;
    case 'motion':
      return isMotionSample(m) ? (m as unknown as ServerMsg) : null;
    case 'actionResult':
      return isStr(m.id) && isStr(m.action) && isBool(m.ok) && isBool(m.dryRun) && isStr(m.message)
        && isNum(m.ms) && (m.error === undefined || isStr(m.error)) ? (m as unknown as ServerMsg) : null;
    case 'error':
      return oneOf(m.code, ['bad_json', 'unknown_action', 'cooldown']) && isStr(m.message)
        && (m.id === undefined || isStr(m.id)) ? (m as unknown as ServerMsg) : null;
    default:
      return null;
  }
}

const SERVER_TYPES = ['hello', 'status', 'motion', 'actionResult', 'error'];

export type ServerFrame =
  | { kind: 'msg'; msg: ServerMsg }
  | { kind: 'unknown'; type: string } // valid JSON with a type we don't know: ignore, not an error
  | { kind: 'invalid' }; // bad JSON or a known type with bad fields: count it

/** Like parseServerMsg, but tells "unknown type" (ignore) apart from "broken frame" (count as invalid). */
export function parseServerFrame(raw: unknown): ServerFrame {
  const m = toObj(raw);
  if (!m) return { kind: 'invalid' };
  if (isStr(m.type) && !SERVER_TYPES.includes(m.type)) return { kind: 'unknown', type: m.type };
  const msg = parseServerMsg(m);
  return msg ? { kind: 'msg', msg } : { kind: 'invalid' };
}

/** Parses a browser -> Mac message. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  const m = toObj(raw);
  if (!m || m.type !== 'action') return null;
  return isStr(m.id) && isStr(m.action) && isStr(m.label) && isNum(m.confidence) ? (m as unknown as ClientMsg) : null;
}

/** Returns a list of problems. Empty list means valid. */
export function validateDataset(x: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(x)) return ['not an object'];
  if (x.format !== 'ss-dataset') errs.push('format must be ss-dataset');
  if (x.v !== 1) errs.push('v must be 1');
  for (const k of ['createdAt', 'session', 'subject'] as const) if (!isStr(x[k])) errs.push(`${k} must be a string`);
  if (!oneOf(x.source, ['airpods', 'fake'])) errs.push('source must be airpods or fake');
  if (!isNum(x.hz)) errs.push('hz must be a number');
  if (!isObj(x.device) || !isStr(x.device.model)) errs.push('device.model missing');
  if (!Array.isArray(x.classes) || !x.classes.every((c) => isObj(c) && isStr(c.id) && isStr(c.sentence)))
    errs.push('classes invalid');
  if (!Array.isArray(x.clips)) return [...errs, 'clips must be an array'];
  const labels = new Set(Array.isArray(x.classes) ? x.classes.map((c) => (c as { id: string }).id) : []);
  x.clips.forEach((c, i) => {
    if (!isObj(c)) { errs.push(`clips[${i}] not an object`); return; }
    if (!isStr(c.id) || !isStr(c.label)) errs.push(`clips[${i}] id/label missing`);
    else if (!labels.has(c.label)) errs.push(`clips[${i}] unknown label ${c.label}`);
    if (!isNum(c.rep) || !isNum(c.pressT) || !isNum(c.releaseT) || !isNum(c.padSec)) errs.push(`clips[${i}] numbers missing`);
    if (!isStr(c.startedAt)) errs.push(`clips[${i}] startedAt missing`);
    if (!isObj(c.quality) || !isNum(c.quality.gapPct) || !isNum(c.quality.nSamples)) errs.push(`clips[${i}] quality missing`);
    if (!Array.isArray(c.samples) || c.samples.length === 0 || !c.samples.every(isMotionSample))
      errs.push(`clips[${i}] samples invalid`);
  });
  return errs;
}

export function validateSession(x: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(x)) return ['not an object'];
  if (x.format !== 'ss-session') errs.push('format must be ss-session');
  if (x.v !== 1) errs.push('v must be 1');
  if (!isStr(x.recordedAt)) errs.push('recordedAt missing');
  if (!parseServerMsg(x.hello)) errs.push('hello invalid');
  if (!parseServerMsg(x.status)) errs.push('status invalid');
  if (!Array.isArray(x.samples) || !x.samples.every(isMotionSample)) errs.push('samples invalid');
  if (!Array.isArray(x.events) || !x.events.every((e) => isObj(e) && isNum(e.t) && isStr(e.kind))) errs.push('events invalid');
  if (!Array.isArray(x.truth) || !x.truth.every((r) => isObj(r) && isNum(r.t0) && isNum(r.t1) && isStr(r.label)))
    errs.push('truth invalid');
  return errs;
}

export const asDataset = (x: unknown): Dataset | null => (validateDataset(x).length ? null : (x as Dataset));
export const asSession = (x: unknown): Session | null => (validateSession(x).length ? null : (x as Session));
