// The action rule: when may the Recognize screen ask the Mac to do something for real?
// (Track J brief, PROTOCOL §2.) This screen can text real people, so the rule is one small pure
// function with exhaustive unit tests (tests/unit/result.test.ts), plus a tiny guard that remembers
// the last send. No DOM here.
//
// Send only if ALL of these hold, else show a ghost chip "Would: …" (visitors and replay see that):
//   1. the label isn't 'none', and its confidence is a real number
//   2. the predicted class has an action, and the prediction clears that action's bar (CONFIDENCE):
//      only LOOSE_ACTIONS may fire from confidence >= 0.5; every other action (texts, and any added later)
//      needs the model's own accept AND confidence >= 0.85
//   3. the app is in Recognize mode, and the take was STARTED in Recognize mode (press.mode)
//   4. the source is `live` (the Mac app) now and when the take started (press.source)
//   5. same connection from key down to now: press.conn === app.connSerial, and this panel saw the key
//      go down with no connection or source change since (its own tracking)
//   6. the connection is open, and hello + status came on it
//   7. not simulated, now (status.simulated === false) and at key down (press.simulated === false)
//   8. status.armed === true
//   9. the model that made the prediction is the user's own, action capable model: ready once every
//      sentence has 5+ takes recorded in this browser with real AirPods, then trained by this panel on
//      all real AirPods clips, imports included (model-source.ts)
//  10. the Mac's hello offers this action
//  11. the page is paired (has a token; the Mac checks it too and answers `unpaired` if it's wrong)
//  12. no action is waiting for an answer, and none was sent in the last 3 s (any action)
// Never retry: `timeout` / `disconnected` / `stopped` mean the Mac may already have done it.
import type { Mode, PressContext, SourceKind } from '../../core/app';
import type { ActionResultMsg, HelloMsg, Prediction, StatusMsg } from '../../core/contracts';
import { NONE } from '../../core/contracts';

/** At most one action per this many ms, whatever the action (the Mac has its own cooldowns too). */
export const ACTION_GAP_MS = 3000;

/** Actions that message a real person (the Mac also gives them a 30 s cooldown). Used for wording. */
export const MESSAGING_ACTIONS: readonly string[] = ['text_mom', 'call_back', 'help'];
/** The only actions allowed to fire on the loose bar (nothing here reaches another person). Allowlist: new actions are strict. */
export const LOOSE_ACTIONS: readonly string[] = ['volume_up', 'focus_music', 'calendar', 'demo_48h'];

/**
 * Confidence bars. Track F, Spiro's real data at the Phase 2 defaults (k 3, clip norm, L 96, mirror):
 * at 0.85, 61.6% of correct sentences accepted, 0% wrong, 0% 'none' false accepts; at 0.5, 85.4% accepted,
 * 1.0% wrong, 0% 'none'. A wrong text to a real person is the worst mistake, so:
 * - messaging: every action NOT in LOOSE_ACTIONS (texts, and any action added later) needs the model's own
 *   accept (its threshold, 0.85 by default) AND at least this.
 * - other: LOOSE_ACTIONS (volume, music, calendar, the demo line) may fire from this, and the screen shows
 *   the sentence from this up (as "probably" below the model's threshold); below it shows "Not sure".
 */
export const CONFIDENCE = { messaging: 0.85, other: 0.5 } as const;

/** Does this prediction clear the bar for this action? */
export function clearsBar(action: string, pred: Pick<Prediction, 'accepted' | 'confidence'>): boolean {
  const c = pred.confidence;
  if (typeof c !== 'number' || !Number.isFinite(c)) return false;
  return LOOSE_ACTIONS.includes(action) ? c >= CONFIDENCE.other : pred.accepted === true && c >= CONFIDENCE.messaging;
}

export interface RuleInput {
  mode: Mode;
  source: SourceKind | null;
  /** Where the take started (from the prediction event). Missing: blocked. */
  press: PressContext | null | undefined;
  /** app.connSerial now. */
  connSerial: number;
  /** This panel's own count of connection / source changes: at its last key down, and now. */
  panelConn: { atPress: number | null; now: number };
  /** The current source's connection is open right now. */
  connOpen: boolean;
  /** hello from the current connection (null until it comes, and after a drop or source switch). */
  hello: HelloMsg | null;
  /** Latest status from the current connection (null until it comes, and after a drop or source switch). */
  status: StatusMsg | null;
  /** The model that made this prediction is this panel's action capable "your model" (model-source.ts). */
  ownModel: boolean;
  pred: Pick<Prediction, 'label' | 'accepted' | 'confidence'>;
  /** The predicted class's action from classes.json (null: no action, e.g. 'none'). */
  action: string | null | undefined;
  /** Pairing token (PROTOCOL §2). */
  token: string | null;
  /** Monotonic clock, ms. */
  now: number;
  /** When the last action was sent (ms, same clock), null if never. */
  lastSentAt: number | null;
  /** An action is still waiting for the Mac's answer. */
  inflight: boolean;
}

/** Why nothing was sent, in check order. */
export type BlockReason =
  | 'not-accepted' // 'none', or no usable confidence
  | 'no-action' // this sentence doesn't do anything
  | 'low-confidence' // below this action's bar (CONFIDENCE)
  | 'not-recognize'
  | 'press-mode' // the take started in Record mode
  | 'not-live' // fake, replay or no source: visitors
  | 'press-changed' // the source or connection changed since the take started
  | 'not-connected'
  | 'simulated'
  | 'not-armed'
  | 'not-own-model'
  | 'not-offered'
  | 'unpaired'
  | 'busy'
  | 'too-soon';

export const BLOCK_REASONS: readonly BlockReason[] = [
  'not-accepted', 'no-action', 'low-confidence', 'not-recognize', 'press-mode', 'not-live', 'press-changed', 'not-connected', 'simulated',
  'not-armed', 'not-own-model', 'not-offered', 'unpaired', 'busy', 'too-soon',
];

export type Decision = { send: true; action: string } | { send: false; reason: BlockReason };

const block = (reason: BlockReason): Decision => ({ send: false, reason });

/** The rule. Pure: same input, same answer. Anything unexpected blocks. */
export function decideAction(x: RuleInput): Decision {
  const p = x.pred;
  if (p.label === NONE || typeof p.confidence !== 'number' || !Number.isFinite(p.confidence)) return block('not-accepted');
  if (typeof x.action !== 'string' || x.action === '') return block('no-action');
  if (!clearsBar(x.action, p)) return block('low-confidence');
  if (x.mode !== 'classify') return block('not-recognize');
  const pr = x.press;
  if (!pr || pr.mode !== 'classify') return block('press-mode');
  if (x.source !== 'live') return block('not-live');
  const pc = x.panelConn;
  if (pr.source !== 'live' || pr.conn !== x.connSerial || !pc || pc.atPress === null || pc.atPress !== pc.now) {
    return block('press-changed');
  }
  if (x.connOpen !== true || !x.status || !x.hello) return block('not-connected');
  if (x.status.simulated !== false || pr.simulated !== false) return block('simulated');
  if (x.status.armed !== true) return block('not-armed');
  if (x.ownModel !== true) return block('not-own-model');
  if (!Array.isArray(x.hello.actions) || !x.hello.actions.includes(x.action)) return block('not-offered');
  if (typeof x.token !== 'string' || x.token === '') return block('unpaired');
  if (x.inflight !== false) return block('busy');
  // Written so NaN or a clock that went backwards also blocks.
  if (x.lastSentAt !== null && !(x.now - x.lastSentAt >= ACTION_GAP_MS)) return block('too-soon');
  return { send: true, action: x.action };
}

/** The parts of RuleInput the panel knows; the guard adds the clock and its own memory. */
export type GuardInput = Omit<RuleInput, 'now' | 'lastSentAt' | 'inflight'>;

/** How a send ended: the Mac's answer, or what `send` threw. Either way it is never retried. */
export interface Sent { result?: ActionResultMsg; error?: unknown }

export interface GuardRun {
  decision: Decision;
  /** Only when sent: settles with the answer. Never rejects. */
  sent: Promise<Sent> | null;
}

/** Remembers the last send and whether one is waiting. Sends at most once per call, never retries. */
export class ActionGuard {
  private lastSentAt: number | null = null;
  private waiting = false;

  constructor(private clock: () => number = () => performance.now()) {}

  decide(x: GuardInput): Decision {
    return decideAction({ ...x, now: this.clock(), lastSentAt: this.lastSentAt, inflight: this.waiting });
  }

  get inflight(): boolean { return this.waiting; }

  /**
   * Decides right away and, only if the rule says so, calls `send` exactly once. Whatever it answers
   * (or throws), it is never called again for this prediction.
   */
  run(x: GuardInput, send: (action: string) => Promise<ActionResultMsg>): GuardRun {
    const decision = this.decide(x);
    if (!decision.send) return { decision, sent: null };
    this.lastSentAt = this.clock(); // counts as sent even if it fails: the Mac may have run it
    this.waiting = true;
    let p: Promise<ActionResultMsg>;
    try {
      p = Promise.resolve(send(decision.action));
    } catch (error) {
      p = Promise.reject(error);
    }
    const sent = p.then(
      (result): Sent => { this.waiting = false; return { result }; },
      (error): Sent => { this.waiting = false; return { error }; },
    );
    return { decision, sent };
  }
}
