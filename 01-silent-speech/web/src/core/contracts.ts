// Frozen contracts for Silent Speech. See PROTOCOL.md.
// Changes go through the lead in one commit with PROTOCOL.md, Protocol.swift and the fixtures.

export const PROTOCOL_VERSION = 1 as const;
export const NONE = 'none';

// ---------- Motion ----------
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // [w, x, y, z]

export interface MotionSample {
  seq: number; // +1 per sample; a jump means dropped samples
  t: number; // seconds, monotonic (CMLogItem.timestamp on the Mac)
  q: Quat; // attitude quaternion
  rr: Vec3; // rotationRate, rad/s
  ua: Vec3; // userAcceleration, g
  g?: Vec3; // gravity, g (optional)
}

export type HeadphoneState = 'connected' | 'disconnected' | 'unavailable';
export type AuthState = 'authorized' | 'denied' | 'notDetermined' | 'restricted';
export type BudLocation = 'left' | 'right' | 'default' | 'unknown';

// ---------- WebSocket: Mac -> browser ----------
export interface HelloMsg {
  type: 'hello';
  v: 1;
  app: string;
  version: string;
  actions: string[];
  armed: boolean;
}

export interface StatusMsg {
  type: 'status';
  headphones: HeadphoneState;
  auth: AuthState;
  loc: BudLocation;
  hz: number; // measured over the last 2 s
  gapPct: number; // % of intervals > 60 ms over the last 10 s
  clients: number;
  armed: boolean;
  simulated: boolean;
}

export interface MotionMsg extends MotionSample {
  type: 'motion';
}

export interface ActionResultMsg {
  type: 'actionResult';
  id: string;
  action: string;
  ok: boolean;
  dryRun: boolean;
  message: string;
  error?: string;
  ms: number;
}

export type ErrorCode = 'bad_json' | 'unknown_action' | 'cooldown';
export interface ErrorMsg {
  type: 'error';
  code: ErrorCode;
  message: string;
  id?: string;
}

export type ServerMsg = HelloMsg | StatusMsg | MotionMsg | ActionResultMsg | ErrorMsg;

// ---------- WebSocket: browser -> Mac ----------
export interface ActionRequestMsg {
  type: 'action';
  id: string;
  action: string;
  label: string;
  confidence: number;
}
export type ClientMsg = ActionRequestMsg;

// ---------- Classes ----------
export interface ClassDef {
  id: string;
  sentence: string;
  action: string | null;
}

// ---------- Dataset file (ss-dataset v1) ----------
export interface Clip {
  id: string;
  label: string;
  samples: MotionSample[];
  session?: string;
}

export interface DatasetClip extends Clip {
  rep: number;
  startedAt: string; // ISO
  pressT: number; // sample clock (t) when push to talk went down
  releaseT: number; // sample clock when it went up
  padSec: number; // samples span pressT - padSec .. releaseT + padSec
  quality: { gapPct: number; nSamples: number };
}

export interface Dataset {
  format: 'ss-dataset';
  v: 1;
  createdAt: string;
  session: string;
  subject: string;
  source: 'airpods' | 'fake';
  device: { model: string; loc: BudLocation };
  hz: number;
  classes: ClassDef[];
  clips: DatasetClip[];
}

// ---------- Replay session file (ss-session v1) ----------
export type SessionEvent =
  | { t: number; kind: 'ptt'; down: boolean }
  | { t: number; kind: 'prediction'; label: string; confidence: number }
  | { t: number; kind: 'action'; action: string; ok: boolean };

export interface Session {
  format: 'ss-session';
  v: 1;
  recordedAt: string;
  hello: HelloMsg;
  status: StatusMsg;
  samples: MotionSample[];
  events: SessionEvent[];
  truth: { t0: number; t1: number; label: string }[];
}

// ---------- ML ----------
export type Channel = 'rr.x' | 'rr.y' | 'rr.z' | 'ua.x' | 'ua.y' | 'ua.z';
export const DEFAULT_CHANNELS: Channel[] = ['rr.x', 'rr.y', 'rr.z', 'ua.x', 'ua.y', 'ua.z'];

export interface Prediction {
  label: string;
  confidence: number; // 0..1
  accepted: boolean; // label !== none && confidence >= threshold
  top: { label: string; score: number }[]; // up to 3, score desc
  ms: number;
}

export interface Classifier {
  name: string;
  labels: string[];
  predict(samples: MotionSample[]): Prediction;
}

export interface DtwKnnOptions {
  channels?: Channel[]; // default DEFAULT_CHANNELS
  L?: number; // resampled length, default 64
  hpHz?: number; // high pass cutoff, default 1.0
  band?: number; // Sakoe-Chiba radius as fraction of L, default 0.1
  k?: number; // default 3
  norm?: 'global' | 'clip'; // default 'global'
  threshold?: number; // default 0.5
}

export interface NormStats {
  mean: number[]; // per channel
  std: number[];
}

export interface DtwKnnModelJSON {
  kind: 'dtw-knn';
  v: 1;
  opts: Required<DtwKnnOptions>;
  norm: NormStats;
  labels: string[];
  templates: { label: string; x: number[][] }[]; // preprocessed [ch][L]
}

export interface Metrics {
  model: string;
  protocol: 'loo' | 'loso';
  nClips: number;
  labels: string[];
  accuracy: number;
  macroF1: number;
  confusion: number[][]; // rows = true, cols = predicted
  noneFalseAcceptRate: number;
  params: Record<string, unknown>;
  inferMsPerClip: number;
  generatedAt: string;
}
