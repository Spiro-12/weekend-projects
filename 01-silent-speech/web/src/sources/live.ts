// Live source: WebSocket to the Mac bridge (PROTOCOL.md §2).
// start() never waits and never rejects: a bad or dead URL just means `conn: closed` and retries
// (0.5 s doubling to 5 s, forever) until stop(). After stop() nothing is emitted.
import type { App, MotionSource, SourceDef } from '../core/app';
import type { ActionRequestMsg, ActionResultMsg, MotionSample, ServerMsg } from '../core/contracts';
import { parseServerFrame } from '../core/validate';

export const DEFAULT_WS = 'ws://localhost:8765';
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5000;
const ACTION_TIMEOUT_MS = 5000;
const STALL_MS = 6000; // the bridge sends status every 1 s: this much silence means a hung connection

type ConnState = 'connecting' | 'open' | 'closed';

interface Pending {
  req: ActionRequestMsg;
  t0: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (r: ActionResultMsg) => void;
}

/** Copies only the MotionSample fields (drops `type` and anything unexpected). */
function toSample(m: MotionSample): MotionSample {
  const s: MotionSample = { seq: m.seq, t: m.t, q: m.q, rr: m.rr, ua: m.ua };
  if (m.g) s.g = m.g;
  return s;
}

class LiveSource implements MotionSource {
  readonly kind = 'live' as const;
  readonly url: string;
  private ws: WebSocket | null = null;
  private stopped = false;
  private started = false;
  private state: ConnState = 'closed';
  private backoff = BACKOFF_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, Pending>();
  private warnedBadUrl = false;
  private lastFrameAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private app: App, opts: Record<string, string> = {}) {
    this.url = opts.ws || DEFAULT_WS;
  }

  start(): Promise<void> {
    if (!this.started && !this.stopped) {
      this.started = true;
      this.connect();
    }
    return Promise.resolve();
  }

  stop() {
    if (this.stopped) return;
    // Last word: tell the page this connection is done. Everything after this is silent.
    if (this.state !== 'closed') this.setState('closed');
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.dropSocket();
    this.failPending('stopped', 'The live connection was stopped');
  }

  sendAction(req: ActionRequestMsg): Promise<ActionResultMsg> {
    return new Promise((resolve) => {
      const ws = this.ws;
      if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN) {
        resolve(this.fail(req, performance.now(), 'not_connected', 'Not connected to the Mac app'));
        return;
      }
      const t0 = performance.now();
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        resolve(this.fail(req, t0, 'timeout', 'The Mac app did not answer in 5 s'));
      }, ACTION_TIMEOUT_MS);
      this.pending.set(req.id, { req, t0, timer, resolve });
      try {
        ws.send(JSON.stringify(req));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(req.id);
        resolve(this.fail(req, t0, 'send_failed', String((e as Error)?.message ?? e)));
      }
    });
  }

  // ---------- connection ----------

  private connect() {
    if (this.stopped) return;
    this.retryTimer = null;
    this.watchdog ??= setInterval(() => {
      const ws = this.ws;
      if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (performance.now() - this.lastFrameAt < STALL_MS) return;
      console.warn(`[live] no messages for ${STALL_MS / 1000} s, reconnecting`);
      this.onClosed(ws);
    }, 1000);
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url); // throws right away for a malformed URL
    } catch (e) {
      if (!this.warnedBadUrl) console.warn(`[live] cannot open ${this.url}:`, (e as Error)?.message ?? e);
      this.warnedBadUrl = true;
      this.onClosed(null);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.stopped || ws !== this.ws) return;
      this.backoff = BACKOFF_MIN_MS;
      this.lastFrameAt = performance.now();
      this.setState('open');
    };
    ws.onmessage = (ev) => {
      if (this.stopped || ws !== this.ws) return;
      this.lastFrameAt = performance.now();
      this.onFrame(ev.data);
    };
    ws.onerror = () => { /* a close event always follows; handled there */ };
    ws.onclose = () => {
      if (this.stopped || ws !== this.ws) return;
      this.onClosed(ws);
    };
  }

  private onClosed(ws: WebSocket | null) {
    if (ws && ws === this.ws) this.dropSocket();
    // Replies can only come back on the socket that carried the request.
    this.failPending('disconnected', 'Lost the connection to the Mac app');
    this.setState('closed');
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private dropSocket() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch { /* already closing */ }
  }

  private setState(state: ConnState) {
    if (this.stopped) return;
    this.state = state;
    this.app.bus.emit('conn', { state, url: this.url });
  }

  // ---------- frames ----------

  private onFrame(data: unknown) {
    const raw = typeof data === 'string' ? data : '';
    const f = parseServerFrame(raw);
    if (f.kind === 'unknown') return; // newer bridge, newer message type: ignore
    if (f.kind === 'invalid') {
      this.app.bus.emit('invalid', { raw: raw.length > 500 ? `${raw.slice(0, 500)}…` : raw });
      return;
    }
    this.onMsg(f.msg);
  }

  private onMsg(m: ServerMsg) {
    const bus = this.app.bus;
    switch (m.type) {
      case 'motion': bus.emit('motion', toSample(m)); break;
      case 'status': bus.emit('status', m); break;
      case 'hello': bus.emit('hello', m); break;
      case 'actionResult': {
        const p = this.takePending(m.id);
        if (p) p.resolve(m);
        break;
      }
      case 'error': {
        const p = m.id !== undefined ? this.takePending(m.id) : undefined;
        if (p) p.resolve(this.fail(p.req, p.t0, m.code, m.message));
        else console.warn(`[live] bridge error ${m.code}: ${m.message}`);
        break;
      }
    }
  }

  // ---------- actions ----------

  private takePending(id: string): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    clearTimeout(p.timer);
    this.pending.delete(id);
    return p;
  }

  private failPending(error: string, message: string) {
    for (const id of [...this.pending.keys()]) {
      const p = this.takePending(id)!;
      p.resolve(this.fail(p.req, p.t0, error, message));
    }
  }

  private fail(req: ActionRequestMsg, t0: number, error: string, message: string): ActionResultMsg {
    return {
      type: 'actionResult', id: req.id, action: req.action, ok: false, dryRun: false, error, message,
      ms: Math.round(performance.now() - t0),
    };
  }
}

const def: SourceDef = { kind: 'live', create: (app, opts) => new LiveSource(app, opts) };
export default def;
