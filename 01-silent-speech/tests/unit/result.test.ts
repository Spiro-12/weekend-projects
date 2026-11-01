// Track J: the Recognize screen's action rule, guard, words and model source (no DOM).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Mode, PressContext, SourceKind } from '../../web/src/core/app';
import type {
  ActionResultMsg, ClassDef, Dataset, DatasetClip, DtwKnnModelJSON, HelloMsg, MotionSample, StatusMsg,
} from '../../web/src/core/contracts';
import { fakeStatus } from '../../web/src/core/synth';
import { MotionSynth } from '../../web/src/core/synth';
import * as ml from '../../web/src/ml/index';
import { buildDemoModelJSON } from '../../web/src/panels/result/demo-build';
import { DEMO_REPS, FAKE_SPEAK_DELAY, buildDemoJSON, demoClips } from '../../web/src/panels/result/demo-model';
import { demoBubble, demoHolds } from '../../web/src/panels/result/demo-screen';
import {
  EXCLUDED, MIN_TAKES_FOR_ACTIONS, actionReadiness, classCount, fetchPublicModel, fingerprint, planModel, realClips, type Provenance,
} from '../../web/src/panels/result/model-source';
import {
  ACTION_GAP_MS, ActionGuard, BLOCK_REASONS, CONFIDENCE, LOOSE_ACTIONS, MESSAGING_ACTIONS, clearsBar, decideAction,
  type BlockReason, type GuardInput, type RuleInput,
} from '../../web/src/panels/result/rule';
import {
  OUTCOME_UNKNOWN, TEXTING_ACTIONS, UNPAIRED_TEXT, describeAction, ghostReason, okWords, toastFor,
} from '../../web/src/panels/result/text';
import type { ClipMeta } from '../../web/src/store';

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const classes = read('../../shared/classes.json') as ClassDef[];
const ACTIONS = classes.filter((c) => c.action).map((c) => c.action as string);

const hello = (actions = ACTIONS): HelloMsg => ({ type: 'hello', v: 1, app: 'MockBridge', version: 't', actions, armed: true });
const status = (p: Partial<StatusMsg> = {}): StatusMsg => fakeStatus({ armed: true, simulated: false, ...p });

const SERIAL = 7;
const press = (p: Partial<PressContext> = {}): PressContext => ({ mode: 'classify', source: 'live', conn: SERIAL, simulated: false, ...p });

/** Everything allowed: the rule sends. */
const ok = (p: Partial<RuleInput> = {}): RuleInput => ({
  mode: 'classify', source: 'live', press: press(), connSerial: SERIAL, panelConn: { atPress: 3, now: 3 },
  connOpen: true, hello: hello(), status: status(), ownModel: true,
  pred: { label: 'volume_up', accepted: true, confidence: 0.9 }, action: 'volume_up', token: 'abc123',
  now: 100_000, lastSentAt: null, inflight: false, ...p,
});

describe('decideAction: the strict rule', () => {
  it('sends when every condition holds', () => {
    expect(decideAction(ok())).toEqual({ send: true, action: 'volume_up' });
  });

  // One condition off at a time: blocked, with the right reason.
  const cases: [string, Partial<RuleInput>, BlockReason][] = [
    ['below 0.5 (not a text)', { pred: { label: 'volume_up', accepted: false, confidence: 0.4999 } }, 'low-confidence'],
    ['a text the model did not accept, even at 0.95', { action: 'text_mom', pred: { label: 'text_mom', accepted: false, confidence: 0.95 } }, 'low-confidence'],
    ['a text accepted below 0.7 (a model with a lower threshold)', { action: 'text_mom', pred: { label: 'text_mom', accepted: true, confidence: 0.6999 } }, 'low-confidence'],
    ['help accepted at 0.6', { action: 'help', pred: { label: 'help', accepted: true, confidence: 0.6 } }, 'low-confidence'],
    ['call_back not accepted at 0.9', { action: 'call_back', pred: { label: 'call_back', accepted: false, confidence: 0.9 } }, 'low-confidence'],
    ['label none (even if a model says accepted)', { pred: { label: 'none', accepted: true, confidence: 0.99 } }, 'not-accepted'],
    ['confidence NaN', { pred: { label: 'volume_up', accepted: true, confidence: NaN } }, 'not-accepted'],
    ['confidence Infinity', { pred: { label: 'volume_up', accepted: true, confidence: Infinity } }, 'not-accepted'],
    ['class has no action', { action: null }, 'no-action'],
    ['action undefined', { action: undefined }, 'no-action'],
    ['action empty', { action: '' }, 'no-action'],
    ['Record mode', { mode: 'enroll' }, 'not-recognize'],
    ['take started in Record mode', { press: press({ mode: 'enroll' }) }, 'press-mode'],
    ['no press context', { press: undefined }, 'press-mode'],
    ['null press context', { press: null }, 'press-mode'],
    ['fake source', { source: 'fake' }, 'not-live'],
    ['replay source', { source: 'replay' }, 'not-live'],
    ['no source', { source: null }, 'not-live'],
    ['take started on another source', { press: press({ source: 'fake' }) }, 'press-changed'],
    ['take started with no source', { press: press({ source: null }) }, 'press-changed'],
    ['connection changed since key down (core serial)', { press: press({ conn: SERIAL - 1 }) }, 'press-changed'],
    ['connection changed since key down (panel serial)', { panelConn: { atPress: 3, now: 4 } }, 'press-changed'],
    ['panel never saw the key go down', { panelConn: { atPress: null, now: 3 } }, 'press-changed'],
    ['connection not open', { connOpen: false }, 'not-connected'],
    ['no status yet', { status: null }, 'not-connected'],
    ['no hello yet', { hello: null }, 'not-connected'],
    ['Simulate mode', { status: status({ simulated: true }) }, 'simulated'],
    ['Simulate mode when the take started', { press: press({ simulated: true }) }, 'simulated'],
    ['no status when the take started', { press: press({ simulated: null }) }, 'simulated'],
    ['not armed', { status: status({ armed: false }) }, 'not-armed'],
    ['public or practice model', { ownModel: false }, 'not-own-model'],
    ['Mac does not offer the action', { hello: hello(['text_mom']) }, 'not-offered'],
    ['no pairing token', { token: null }, 'unpaired'],
    ['empty pairing token', { token: '' }, 'unpaired'],
    ['an action is waiting for an answer', { inflight: true }, 'busy'],
    ['sent 1 s ago', { lastSentAt: 99_000 }, 'too-soon'],
    ['sent 2.999 s ago', { lastSentAt: 100_000 - 2999 }, 'too-soon'],
    ['clock went backwards', { lastSentAt: 100_005 }, 'too-soon'],
    ['lastSentAt NaN', { lastSentAt: NaN }, 'too-soon'],
  ];
  for (const [name, patch, reason] of cases) {
    it(`blocks: ${name}`, () => expect(decideAction(ok(patch))).toEqual({ send: false, reason }));
  }

  it('confidence bars: texts need the model\'s accept and 0.7, other actions 0.5 (accepted or not)', () => {
    expect(CONFIDENCE).toEqual({ messaging: 0.7, other: 0.5 });
    expect([...MESSAGING_ACTIONS].sort()).toEqual(['call_back', 'help', 'text_mom']);
    const send = (action: string, accepted: boolean, confidence: number) =>
      decideAction(ok({ action, pred: { label: action, accepted, confidence } })).send;
    for (const a of MESSAGING_ACTIONS) {
      expect(send(a, true, 0.7)).toBe(true);
      expect(send(a, true, 0.6999)).toBe(false);
      expect(send(a, false, 0.99)).toBe(false);
      expect(send(a, true, 1)).toBe(true);
    }
    for (const a of ['volume_up', 'focus_music', 'demo_48h', 'calendar']) {
      expect(send(a, false, 0.5)).toBe(true); // "probably" is enough for these
      expect(send(a, true, 0.5)).toBe(true);
      expect(send(a, false, 0.4999)).toBe(false);
      expect(send(a, true, 0.4999)).toBe(false); // a model with a lower threshold doesn't lower the bar
    }
    // Allowlist: only these four are loose. Any other action, including one added later, gets the strict bar.
    expect([...LOOSE_ACTIONS].sort()).toEqual(['calendar', 'demo_48h', 'focus_music', 'volume_up']);
    for (const a of ['launch_rocket', 'email_boss', 'unlock_door', '']) {
      expect(clearsBar(a, { accepted: false, confidence: 0.99 })).toBe(false);
      expect(clearsBar(a, { accepted: true, confidence: 0.6999 })).toBe(false);
      expect(clearsBar(a, { accepted: true, confidence: 0.7 })).toBe(true);
    }
    const newAction = (accepted: boolean, confidence: number) => decideAction(ok({
      action: 'launch_rocket', hello: hello([...ACTIONS, 'launch_rocket']), pred: { label: 'launch_rocket', accepted, confidence },
    }));
    expect(newAction(false, 0.7)).toEqual({ send: false, reason: 'low-confidence' });
    expect(newAction(true, 0.9)).toEqual({ send: true, action: 'launch_rocket' });
    expect(clearsBar('volume_up', { accepted: true, confidence: NaN })).toBe(false);
    expect(clearsBar('text_mom', { accepted: 1 as unknown as boolean, confidence: 0.9 })).toBe(false);
  });

  it('sends again exactly 3 s after the last one', () => {
    expect(decideAction(ok({ lastSentAt: 100_000 - ACTION_GAP_MS }))).toEqual({ send: true, action: 'volume_up' });
    expect(ACTION_GAP_MS).toBe(3000);
  });

  it('needs armed === true and simulated === false exactly (no truthy look alikes)', () => {
    const weird = (p: Record<string, unknown>) => ({ ...status(), ...p }) as unknown as StatusMsg;
    expect(decideAction(ok({ status: weird({ armed: 1 }) })).send).toBe(false);
    expect(decideAction(ok({ status: weird({ armed: 'true' }) })).send).toBe(false);
    expect(decideAction(ok({ status: weird({ simulated: undefined }) })).send).toBe(false);
    expect(decideAction(ok({ status: weird({ simulated: 0 }) })).send).toBe(false);
    expect(decideAction(ok({ ownModel: 1 as unknown as boolean })).send).toBe(false);
    expect(decideAction(ok({ connOpen: 'yes' as unknown as boolean })).send).toBe(false);
    expect(decideAction(ok({ inflight: undefined as unknown as boolean })).send).toBe(false);
    expect(decideAction(ok({ action: 'text_mom', pred: { label: 'text_mom', accepted: 1 as unknown as boolean, confidence: 0.9 } })).send).toBe(false);
  });

  it('a broken hello (no actions list) blocks instead of throwing', () => {
    const h = { ...hello(), actions: undefined } as unknown as HelloMsg;
    expect(decideAction(ok({ hello: h }))).toEqual({ send: false, reason: 'not-offered' });
  });

  it('none never sends, for any input', () => {
    for (const action of [null, 'volume_up']) {
      for (const accepted of [true, false]) {
        expect(decideAction(ok({ pred: { label: 'none', accepted, confidence: 1 }, action })).send).toBe(false);
      }
    }
  });

  it('every class: sentences with an action send if sure enough (texts only when the model accepts)', () => {
    for (const c of classes) {
      for (const accepted of [true, false]) {
        const d = decideAction(ok({ pred: { label: c.id, accepted, confidence: 0.95 }, action: c.action }));
        expect(d.send).toBe(c.id !== 'none' && !!c.action && (accepted || !MESSAGING_ACTIONS.includes(c.action)));
        if (d.send) expect(d.action).toBe(c.action);
      }
    }
  });

  // Exhaustive: every combination of these values (about 516k inputs) against an independent oracle
  // written straight from the brief. Sends iff all conditions hold; when blocked, the reason is the
  // first failing check in the documented order.
  it('exhaustive grid agrees with the brief', () => {
    const NOW = 50_000;
    const modes: Mode[] = ['classify', 'enroll'];
    const sources: (SourceKind | null)[] = ['live', 'fake', 'replay', null];
    const hellos = [hello(), hello(['text_mom'])];
    const statuses = [null, status(), status({ armed: false }), status({ simulated: true })];
    const preds = [
      { label: 'volume_up', accepted: true, confidence: 0.9 }, { label: 'volume_up', accepted: false, confidence: 0.4 },
      { label: 'volume_up', accepted: false, confidence: 0.6 }, { label: 'text_mom', accepted: true, confidence: 0.7 },
      { label: 'text_mom', accepted: true, confidence: 0.65 }, // accepted by a model, below the text bar
      { label: 'none', accepted: true, confidence: 0.9 }, { label: 'volume_up', accepted: true, confidence: NaN },
    ];
    const actions = ['volume_up', 'text_mom', null];
    const tokens = ['tok', null];
    const lasts = [null, NOW - 2999];
    const presses: (PressContext | null)[] = [
      press(), null, press({ mode: 'enroll' }), press({ source: 'fake' }), press({ conn: SERIAL + 1 }),
      press({ simulated: true }), press({ simulated: null }),
    ];
    const panels = [{ atPress: 2, now: 2 }, { atPress: 1, now: 2 }];
    let n = 0, sent = 0;
    const wrong: unknown[] = [];
    for (const mode of modes) for (const source of sources) for (const connOpen of [true, false])
    for (const h of hellos) for (const st of statuses) for (const ownModel of [true, false]) for (const pred of preds)
    for (const action of actions) for (const token of tokens) for (const lastSentAt of lasts) for (const inflight of [true, false])
    for (const pr of presses) for (const panelConn of panels) {
      const x: RuleInput = {
        mode, source, press: pr, connSerial: SERIAL, panelConn, connOpen, hello: h, status: st, ownModel, pred, action, token,
        now: NOW, lastSentAt, inflight,
      };
      // The brief, check by check, in order (early returns keep 344k cases fast).
      const oracle = (): BlockReason | undefined => {
        if (!(pred.label !== 'none' && Number.isFinite(pred.confidence))) return 'not-accepted';
        if (!action) return 'no-action';
        const loose = ['volume_up', 'focus_music', 'calendar', 'demo_48h'].includes(action); // allowlist
        if (loose ? !(pred.confidence >= 0.5) : !(pred.accepted && pred.confidence >= 0.7)) return 'low-confidence';
        if (mode !== 'classify') return 'not-recognize';
        if (pr?.mode !== 'classify') return 'press-mode';
        if (source !== 'live') return 'not-live';
        if (!(pr.source === 'live' && pr.conn === SERIAL && panelConn.atPress === panelConn.now)) return 'press-changed';
        if (!(connOpen && st !== null && h !== null)) return 'not-connected';
        if (!(st.simulated === false && pr.simulated === false)) return 'simulated';
        if (st.armed !== true) return 'not-armed';
        if (!ownModel) return 'not-own-model';
        if (!h.actions.includes(action)) return 'not-offered';
        if (!token) return 'unpaired';
        if (inflight) return 'busy';
        if (!(lastSentAt === null || NOW - lastSentAt >= 3000)) return 'too-soon';
        return undefined;
      };
      const firstFail = oracle();
      const d = decideAction(x);
      n++;
      if (!firstFail) sent++;
      const right = firstFail
        ? d.send === false && d.reason === firstFail && Object.keys(d).length === 2
        : d.send === true && d.action === action && Object.keys(d).length === 2;
      if (!right && wrong.length < 5) wrong.push({ x, d, firstFail });
    }
    expect(wrong).toEqual([]);
    expect(n).toBe(602_112); // 7 predictions x the rest of the grid
    expect(sent).toBeGreaterThan(0);
    expect(BLOCK_REASONS).toHaveLength(15);
  }, 60_000);
});

describe('ActionGuard: at most one send, 3 s apart, never a retry', () => {
  const input = (p: Partial<GuardInput> = {}): GuardInput => {
    const { now: _n, lastSentAt: _l, inflight: _i, ...rest } = ok();
    return { ...rest, ...p };
  };
  const answer = (p: Partial<ActionResultMsg> = {}): ActionResultMsg =>
    ({ type: 'actionResult', id: 'a', action: 'volume_up', ok: true, dryRun: false, message: 'ok', ms: 1, ...p });
  const clock = () => { const c = { t: 1000, now: () => c.t }; return c; };

  it('sends exactly once per accepted prediction and waits 3 s before the next', async () => {
    const c = clock();
    const g = new ActionGuard(c.now);
    const calls: string[] = [];
    const send = async (a: string) => { calls.push(a); return answer({ action: a }); };
    const r1 = g.run(input(), send);
    expect(r1.decision).toEqual({ send: true, action: 'volume_up' });
    expect(calls).toEqual(['volume_up']); // called right away, once
    expect(await r1.sent).toEqual({ result: answer() });
    c.t += 1000;
    expect(g.run(input({ action: 'text_mom', pred: { label: 'text_mom', accepted: true, confidence: 0.9 } }), send).decision)
      .toEqual({ send: false, reason: 'too-soon' }); // any action counts
    c.t += 1999;
    expect(g.run(input(), send).decision).toEqual({ send: false, reason: 'too-soon' });
    c.t += 1;
    const r2 = g.run(input(), send);
    expect(r2.decision.send).toBe(true);
    await r2.sent;
    expect(calls).toEqual(['volume_up', 'volume_up']);
  });

  it('a blocked prediction never calls send and does not start the 3 s wait', () => {
    const c = clock();
    const g = new ActionGuard(c.now);
    let calls = 0;
    const send = async () => { calls++; return answer(); };
    expect(g.run(input({ status: status({ armed: false }) }), send).sent).toBeNull();
    expect(g.run(input({ pred: { label: 'none', accepted: true, confidence: 1 } }), send).sent).toBeNull();
    expect(calls).toBe(0);
    expect(g.run(input(), send).decision.send).toBe(true); // right away: nothing was sent before
    expect(calls).toBe(1);
  });

  it('blocks while an answer is pending, even after 3 s', async () => {
    const c = clock();
    const g = new ActionGuard(c.now);
    let resolve!: (r: ActionResultMsg) => void;
    let calls = 0;
    const send = () => { calls++; return new Promise<ActionResultMsg>((r) => { resolve = r; }); };
    const r1 = g.run(input(), send);
    expect(g.inflight).toBe(true);
    c.t += 10_000;
    expect(g.run(input(), send).decision).toEqual({ send: false, reason: 'busy' });
    resolve(answer());
    await r1.sent;
    expect(g.inflight).toBe(false);
    expect(g.run(input(), send).decision.send).toBe(true);
    expect(calls).toBe(2);
  });

  for (const error of [...OUTCOME_UNKNOWN, 'unpaired', 'cooldown', 'not_connected']) {
    it(`never retries after "${error}"`, async () => {
      const c = clock();
      const g = new ActionGuard(c.now);
      let calls = 0;
      const send = async () => { calls++; return answer({ ok: false, error, message: error }); };
      const r = g.run(input(), send);
      expect(await r.sent).toEqual({ result: answer({ ok: false, error, message: error }) });
      await new Promise((res) => setTimeout(res, 20));
      expect(calls).toBe(1);
      c.t += 500;
      expect(g.run(input(), send).decision).toEqual({ send: false, reason: 'too-soon' }); // the failed one still counts
      expect(calls).toBe(1);
    });
  }

  it('send throwing or rejecting settles as an error, once, and frees the guard', async () => {
    const c = clock();
    const g = new ActionGuard(c.now);
    const boom = new Error('boom');
    const r1 = g.run(input(), () => { throw boom; });
    expect(await r1.sent).toEqual({ error: boom });
    expect(g.inflight).toBe(false);
    c.t += 3000;
    const r2 = g.run(input(), () => Promise.reject(boom));
    expect(await r2.sent).toEqual({ error: boom });
    expect(g.inflight).toBe(false);
  });
});

describe('demo screen: what it holds back', () => {
  it('holds every action that messages a person, and any action not on the harmless allowlist', () => {
    for (const a of MESSAGING_ACTIONS) expect(demoHolds(a)).toBe(true);
    expect(demoHolds('launch_rocket')).toBe(true); // added later: held until someone decides it is harmless
    for (const a of LOOSE_ACTIONS) expect(demoHolds(a)).toBe(false); // these still run on the Mac
    for (const a of [null, undefined, '']) expect(demoHolds(a)).toBe(false); // nothing to hold
    // every action in classes.json is either held or harmless, and the texts are held
    for (const a of ACTIONS) expect(demoHolds(a)).toBe(!LOOSE_ACTIONS.includes(a));
  });

  it('shows a text bubble for texts (help gets the red alert instead)', () => {
    expect(demoBubble('text_mom')).toEqual({ to: 'Mom', text: 'On my way!' });
    expect(demoBubble('call_back')).toEqual({ to: 'Mom', text: 'Can’t talk now, call me back later' });
    expect(demoBubble('help')).toBeNull();
  });
});

describe('words', () => {
  it('describes every action in classes.json, and unknown ones generically', () => {
    for (const a of ACTIONS) expect(describeAction(a)).not.toMatch(/^Run /);
    expect(describeAction('launch_rocket')).toBe('Run “launch_rocket”');
  });

  it('has a ghost reason for every block reason and source', () => {
    for (const r of BLOCK_REASONS) for (const s of ['live', 'fake', 'replay', null] as const) expect(ghostReason(r, s).length).toBeGreaterThan(5);
    expect(ghostReason('not-live', 'replay')).toMatch(/Replay/);
    expect(ghostReason('not-armed', 'live')).toMatch(/Armed/);
    expect(ghostReason('not-own-model', 'live', 8, 5)).toBe('Record all 8 sentences (5 each) to run actions');
    // Your recordings are complete but another model is on: say how to switch, not "record".
    expect(ghostReason('not-own-model', 'live', 8, 5, 'volume_up', true)).toBe('Re-train to use your model');
    expect(ghostReason('unpaired', 'live')).toMatch(/Open this page from the Mac app’s link/);
    expect(ghostReason('low-confidence', 'live', 8, 5, 'text_mom')).toMatch(/Texts need it to be very sure/);
    expect(ghostReason('low-confidence', 'live', 8, 5, 'volume_up')).toMatch(/Not sure enough/);
  });

  const res = (p: Partial<ActionResultMsg>) => ({ action: 'text_mom', ok: false, dryRun: false, message: 'm', ...p });
  it('toasts: done, dry run, unpaired, unknown outcome, cooldown, others', () => {
    expect(toastFor(res({ action: 'volume_up', ok: true, message: 'Mock ran volume_up' })))
      .toEqual({ kind: 'ok', title: 'Done on your Mac', body: 'Turn the Mac’s volume up' }); // our words, not the raw message
    expect(toastFor(res({ ok: true, dryRun: true })).kind).toBe('dry');
    expect(toastFor(res({ error: 'unpaired' }))).toEqual({ kind: 'bad', title: 'Not paired', body: UNPAIRED_TEXT });
    expect(UNPAIRED_TEXT).toBe("This dashboard isn't paired with your Mac app. Open it from the Mac app's link.");
    for (const e of ['timeout', 'disconnected', 'stopped']) {
      const t = toastFor(res({ error: e }));
      expect(t.kind).toBe('unknown');
      expect(t.body).toMatch(/won’t try again/);
    }
    expect(toastFor(res({ error: 'cooldown' })).title).toBe('Too soon');
    expect(toastFor(res({ error: 'unknown_action' })).body).toMatch(/doesn’t know/);
    expect(toastFor(res({ error: 'not_connected' })).body).toMatch(/nothing happened/);
    // Unknown codes: a generic plain line, never the Mac's raw message or the code.
    expect(toastFor(res({ error: 'weird_code', message: 'NSAppleScriptErrorNumber -1743 text_mom' })))
      .toEqual({ kind: 'bad', title: 'It didn’t work', body: 'Your Mac couldn’t do it this time.' });
  });

  it('texts are only STARTED when the Mac says ok: "sending", never "Done" or "on the way"', () => {
    for (const a of TEXTING_ACTIONS) {
      const t = toastFor(res({ action: a, ok: true, message: 'Sent' }));
      expect(t.title).toBe('Your Mac is sending the text');
      const w = okWords(a, 'Sent');
      expect(w.chip).toBe(`Sending: ${describeAction(a)}`);
      expect(`${t.title} ${t.body} ${w.chip} ${w.why}`).not.toMatch(/Done|on the way/i);
    }
    expect(okWords('focus_music').title).toBe('Your Mac is on it');
    expect(okWords('volume_up').chip).toBe('Done: Turn the Mac’s volume up');
  });

  it('long actions that answer "Working on it" read naturally', () => {
    expect(toastFor(res({ action: 'calendar', ok: true, message: 'Working on it' })))
      .toEqual({ kind: 'ok', title: 'Your Mac is on it', body: 'Read out today’s calendar' });
  });

  // Track I's ActionRunner codes: plain English, never the code or the Mac's raw message (it can name action ids).
  const MAC_CODES: [string, RegExp][] = [
    ['no_contact', /anyone to text/], ['bad_contact', /phone number/], ['no_spotify', /Spotify isn’t installed/],
    ['bad_uri', /playlist/], ['script_failed', /permission/], ['busy', /still doing the last one/],
    ['cooldown', /30 seconds/], ['unknown_action', /doesn’t know/], ['send_failed', /nothing happened/],
    ['duplicate_id', /wasn’t sent twice/], ['bad_json', /didn’t understand/],
    ['not_allowed', /needs permission: System Settings › Privacy & Security › Automation/],
    ['no_music', /Music app isn’t on this Mac/], ['bad_url', /Apple Music link/], ['bad_playlist', /playlist name/],
  ];
  for (const [code, body] of MAC_CODES) {
    it(`error ${code}: plain English, no code shown`, () => {
      const t = toastFor(res({ error: code, message: `No contact set for text_mom (${code})` }));
      expect(t.kind).toBe('bad');
      expect(t.body).toMatch(body);
      expect(`${t.title} ${t.body}`).not.toContain(code);
      expect(`${t.title} ${t.body}`).not.toMatch(/text_mom|_/);
    });
  }
});

describe('model source', () => {
  const syn = read('../../shared/fixtures/dataset.synthetic.json') as Dataset;
  const meta = (source: 'airpods' | 'fake', loc: 'left' | 'right' = 'left'): ClipMeta =>
    ({ source, subject: 'spiro', device: { model: 'AirPods Pro 3', loc }, hz: 50 });
  const clip = (id: string, label: string, n = 20, loc?: 'left' | 'right'): DatasetClip => ({
    ...syn.clips[0], id, label, samples: syn.clips[0].samples.slice(0, n), ...(loc ? { loc } : {}),
  });
  const known = classes.map((c) => c.id);

  it('real clips: airpods only, known labels, not excluded, at least 10 samples; loc filled from meta', () => {
    const excludedId = [...EXCLUDED][0];
    const all = [
      clip('a', 'text_mom'), clip('b', 'help', 20, 'right'), clip('c', 'volume_up'), clip('d', 'none'),
      clip('e', 'mystery'), clip(excludedId, 'none'), clip('f', 'calendar', 9), clip('g', 'calendar'),
    ];
    const metas: Record<string, ClipMeta | undefined> = {
      a: meta('airpods', 'right'), b: meta('airpods', 'left'), c: meta('fake'), d: undefined,
      e: meta('airpods'), [excludedId]: meta('airpods'), f: meta('airpods'), g: meta('airpods'),
    };
    const got = realClips(all, (id) => metas[id], known);
    expect(got.map((c) => c.id)).toEqual(['a', 'b', 'g']);
    expect(got[0].loc).toBe('right'); // from meta
    expect(got[1].loc).toBe('right'); // the clip's own loc wins
    expect(got[2].loc).toBe('left');
    expect(classCount(got)).toBe(3);
  });

  it('the exclusion list is data/raw/exclude.json', () => {
    const ex = read('../../data/raw/exclude.json') as { ids: string[] };
    expect([...EXCLUDED].sort()).toEqual([...ex.ids].sort());
    expect(EXCLUDED.size).toBeGreaterThan(0);
  });

  it('fingerprint ignores order and changes when the clip set does', () => {
    expect(fingerprint([{ id: 'b' }, { id: 'a' }])).toBe(fingerprint([{ id: 'a' }, { id: 'b' }]));
    expect(fingerprint([{ id: 'a' }])).not.toBe(fingerprint([{ id: 'a' }, { id: 'c' }]));
  });

  it('recordedOnly: only clips recorded in this browser (imports and old records without origin do not count)', () => {
    const all = [clip('r1', 'text_mom'), clip('i1', 'text_mom'), clip('o1', 'help'), clip('f1', 'help')];
    const metas: Record<string, ClipMeta> = {
      r1: { ...meta('airpods'), origin: 'recorded' }, i1: { ...meta('airpods'), origin: 'imported' },
      o1: meta('airpods'), f1: { ...meta('fake'), origin: 'recorded' },
    };
    expect(realClips(all, (id) => metas[id], known).map((c) => c.id)).toEqual(['r1', 'i1', 'o1']);
    expect(realClips(all, (id) => metas[id], known, { recordedOnly: true }).map((c) => c.id)).toEqual(['r1']);
  });

  it('action readiness: every sentence in classes.json, none included, at least 5 takes each', () => {
    const takes = (per: Record<string, number>) => Object.entries(per).flatMap(([label, n]) => Array.from({ length: n }, () => ({ label })));
    const all5 = Object.fromEntries(known.map((id) => [id, 5]));
    expect(MIN_TAKES_FOR_ACTIONS).toBe(5);
    expect(actionReadiness(takes(all5), known)).toEqual({ ready: true, done: 8, total: 8 });
    expect(actionReadiness(takes({ ...all5, none: 4 }), known)).toEqual({ ready: false, done: 7, total: 8 });
    expect(actionReadiness(takes({ ...all5, none: 0 }), known).ready).toBe(false);
    expect(actionReadiness(takes({ none: 15, text_mom: 15 }), known)).toEqual({ ready: false, done: 2, total: 8 });
    expect(actionReadiness([], known).ready).toBe(false);
    expect(actionReadiness([], []).ready).toBe(false);
  });

  it('plan, fake source: the demo model (a practice model from Record stays unless Re-train)', () => {
    const plan = (current: Provenance | null, force = false) =>
      planModel({ source: 'fake', ownReady: true, realClasses: 8, current, fresh: true, force });
    expect(plan(null)).toBe('demo');
    expect(plan('own')).toBe('demo'); // your real model doesn't know fake motion
    expect(plan('preview')).toBe('demo');
    expect(plan('public')).toBe('demo');
    expect(plan('demo')).toBe('keep');
    expect(plan('other')).toBe('keep');
    expect(plan('other', true)).toBe('demo');
  });

  it('plan, replay: Spiro\'s public model, never your clips (the held out score stays honest)', () => {
    const plan = (current: Provenance | null, force = false) =>
      planModel({ source: 'replay', ownReady: true, realClasses: 8, current, fresh: true, force });
    for (const cur of [null, 'own', 'preview', 'demo'] as const) expect(plan(cur)).toBe('public');
    expect(plan('public')).toBe('keep');
    expect(plan('other')).toBe('keep'); // set on purpose (a test, Record's "Train & use it")
    expect(plan('public', true)).toBe('public');
    expect(plan('other', true)).toBe('public');
  });

  it('plan, live: your model only when ready, a preview model from 2+ real sentences, else public', () => {
    const plan = (o: { ready?: boolean; real?: number; cur?: Provenance | null; fresh?: boolean; force?: boolean }) => planModel({
      source: 'live', ownReady: o.ready ?? false, realClasses: o.real ?? 0, current: o.cur ?? null, fresh: o.fresh ?? false, force: o.force ?? false,
    });
    expect(plan({ ready: true, real: 8 })).toBe('own');
    expect(plan({ ready: true, real: 8, cur: 'own', fresh: true })).toBe('keep');
    expect(plan({ ready: true, real: 8, cur: 'own', fresh: false })).toBe('own'); // new recordings since
    expect(plan({ ready: true, real: 8, cur: 'own', fresh: true, force: true })).toBe('own'); // Re-train
    expect(plan({ ready: true, real: 8, cur: 'preview', fresh: true })).toBe('own'); // became ready
    expect(plan({ ready: false, real: 2 })).toBe('preview');
    expect(plan({ ready: false, real: 8, cur: 'own', fresh: true })).toBe('preview'); // recorded takes were deleted
    expect(plan({ ready: false, real: 8, cur: 'preview', fresh: true })).toBe('keep');
    expect(plan({ ready: false, real: 8, cur: 'other' })).toBe('preview'); // Record's model is replaced
    expect(plan({ ready: false, real: 1 })).toBe('public');
    expect(plan({ ready: false, real: 0, cur: 'own', fresh: true })).toBe('public'); // your recordings are gone
    expect(plan({ ready: false, real: 1, cur: 'other' })).toBe('keep'); // practice model from Record stays
    expect(plan({ ready: false, real: 1, cur: 'public' })).toBe('keep');
    expect(plan({ ready: false, real: 1, cur: 'other', force: true })).toBe('public');
    expect(plan({ ready: false, real: 0, cur: 'demo' })).toBe('public'); // left fake mode
    // Source not picked yet: like live (the source event plans again).
    expect(planModel({ source: null, ownReady: false, realClasses: 0, current: null, fresh: false, force: false })).toBe('public');
  });

  // Reviewer finding: a model that knows only 2 sentences calls everything one of them. Spiro's real data:
  // train none + text_mom on s1 + s2 (exclude list), test the other sentences of s3.
  it('real data: a none + text_mom model accepts other sentences as text_mom, so it is never allowed to act', () => {
    const ds = ['ss-dataset-s1-20261031-1621.json', 'ss-dataset-s2-20261031-1637.json', 'ss-dataset-s3-20261031-1654.json']
      .map((f) => read(`../../data/raw/${f}`) as Dataset);
    const metaOf = new Map<string, ClipMeta>();
    for (const d of ds) for (const c of d.clips) {
      metaOf.set(c.id, { source: 'airpods', subject: d.subject, device: d.device, hz: d.hz, origin: 'recorded' }); // even "recorded here"
    }
    const pick = (d: Dataset, labels: string[]) => d.clips.filter((c) => labels.includes(c.label)).map((c) => ({ ...c, session: d.session }));
    const train = realClips([...pick(ds[0], ['none', 'text_mom']), ...pick(ds[1], ['none', 'text_mom'])], (id) => metaOf.get(id), known, { recordedOnly: true });
    expect(classCount(train)).toBe(2);
    // The panel's decision: 2 sentences recorded is not ready, so this is a preview model, not "your model".
    const ready = actionReadiness(train, known);
    expect(ready.ready).toBe(false);
    const plan = planModel({ source: 'live', ownReady: ready.ready, realClasses: classCount(train), current: null, fresh: false, force: false });
    expect(plan).toBe('preview');
    const ownModel = plan === 'own';

    const others = ds[2].clips.filter((c) => c.label !== 'none' && c.label !== 'text_mom' && !EXCLUDED.has(c.id));
    expect(others.length).toBeGreaterThanOrEqual(80);
    // Check the rule with the Phase 1 ml settings (where a 2 sentence model is most dangerous) and with the
    // settings the panel trains with today (Track F defaults, threshold CONFIDENCE.messaging). The rule must never send with either.
    const phase1 = { L: 64, band: 0.1, k: 1, norm: 'global' as const, threshold: 0.5 };
    const wrong: Record<string, number> = {};
    for (const [name, opts] of [['phase1', phase1], ['panel', { threshold: CONFIDENCE.messaging }]] as const) {
      const model = ml.train(train, opts);
      let wronglyAccepted = 0;
      for (const c of others) {
        const p = model.predict(c.samples, { loc: c.loc ?? ds[2].device.loc });
        if (p.accepted) wronglyAccepted++;
        const action = classes.find((k) => k.id === p.label)?.action ?? null;
        const d = decideAction(ok({ pred: p, action, ownModel })); // everything else allowed: armed, paired, live, real
        const expected = p.label === 'none' ? 'not-accepted' : clearsBar(action!, p) ? 'not-own-model' : 'low-confidence';
        expect(d).toEqual({ send: false, reason: expected });
      }
      wrong[name] = wronglyAccepted;
    }
    // The danger is real with the Phase 1 settings (reviewer: 70 of 90); the panel's settings are safer but not zero.
    expect(wrong.phase1).toBeGreaterThan(others.length / 4);
    expect(wrong.panel).toBeLessThan(wrong.phase1);
  }, 60_000);

  it('demo clips: every class, deterministic, long enough, labeled, never airpods', () => {
    const a = demoClips(classes);
    expect(a).toHaveLength(classes.length * DEMO_REPS);
    for (const c of classes) expect(a.filter((x) => x.label === c.id)).toHaveLength(DEMO_REPS);
    expect(a.every((c) => c.samples.length >= 10 && c.id.startsWith('demo-'))).toBe(true);
    expect(demoClips(classes)[5].samples).toEqual(a[5].samples); // same seed, same data
    expect(realClips(a.map((c) => ({ ...syn.clips[0], ...c })), () => undefined, classes.map((c) => c.id))).toEqual([]);
  });

  describe('building the demo model off the main thread', () => {
    type Fake = { onmessage: ((e: MessageEvent) => void) | null; onerror: ((e: Event) => void) | null; postMessage(m: unknown): void; terminate(): void; terminated: boolean };
    const fakeWorker = (behave: 'answer' | 'error' | 'silent'): Fake => {
      const w: Fake = {
        onmessage: null, onerror: null, terminated: false,
        postMessage(m) {
          const { classes: cs } = m as { classes: ClassDef[] };
          setTimeout(() => {
            if (behave === 'answer') w.onmessage?.({ data: cheap(cs) } as MessageEvent);
            if (behave === 'error') w.onerror?.(new Event('error'));
          }, 5);
        },
        terminate() { w.terminated = true; },
      };
      return w;
    };
    const asWorker = (f: Fake) => () => f as unknown as Worker;
    const cheap = (cs: ClassDef[]) => ({ ok: true as const, json: { kind: 'dtw-knn', v: 1, labels: cs.map((c) => c.id) } as unknown as DtwKnnModelJSON, n: 1 });

    it('pure build: a loadable model with every class', () => {
      const r = buildDemoJSON(classes);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.n).toBe(classes.length * DEMO_REPS);
      expect(ml.loadModel(r.json).labels.sort()).toEqual(classes.map((c) => c.id).sort());
    });
    it('uses the worker when it answers, then shuts it down', async () => {
      const f = fakeWorker('answer');
      const r = await buildDemoModelJSON(classes, { makeWorker: asWorker(f) });
      expect(r).toMatchObject({ ok: true, where: 'worker' });
      expect(f.terminated).toBe(true);
    });
    it('falls back to the main thread if the worker fails, does not answer, or cannot start', async () => {
      const build = cheap;
      expect(await buildDemoModelJSON(classes, { makeWorker: asWorker(fakeWorker('error')), build })).toMatchObject({ ok: true, where: 'main' });
      const silent = fakeWorker('silent');
      expect(await buildDemoModelJSON(classes, { makeWorker: asWorker(silent), timeoutMs: 30, build })).toMatchObject({ ok: true, where: 'main' });
      expect(silent.terminated).toBe(true);
      expect(await buildDemoModelJSON(classes, { makeWorker: () => { throw new Error('blocked'); }, build })).toMatchObject({ ok: true, where: 'main' });
      const real = await buildDemoModelJSON(classes); // node: no Worker at all, the real build on the main thread
      expect(real).toMatchObject({ ok: true, where: 'main', n: classes.length * DEMO_REPS });
    });
  });

  it('demo model recognizes fake source motion for any reasonable hold, and never accepts a wrong sentence', () => {
    const t0 = performance.now();
    const m = ml.train(demoClips(classes));
    const ms = performance.now() - t0;
    let right = 0, n = 0;
    const wrong: string[] = [];
    for (const c of classes) {
      for (const [i, extra] of [0.1, 0.6, 1.1].entries()) {
        // Like the browser: one continuous fake stream, the sentence 0.15 s after Space, cut with 0.3 s pads.
        const synth = new MotionSynth(42 + 17 * i);
        const press = 1003;
        const { t1 } = synth.utter(c, press + FAKE_SPEAK_DELAY);
        const all: MotionSample[] = [];
        for (let k = 0; k < 25 * 12; k++) { const s = synth.sampleAt(1000 + k / 25); if (s) all.push(s); }
        const p = m.predict(all.filter((s) => s.t >= press - 0.3 && s.t <= t1 + extra + 0.3));
        n++;
        if (c.id === 'none' ? !p.accepted : p.accepted && p.label === c.id) right++;
        else if (p.accepted && p.label !== c.id) wrong.push(`${c.id} -> ${p.label}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(right / n).toBeGreaterThanOrEqual(0.85);
    expect(ms).toBeLessThan(2000); // ~90 ms warm; generous for slow CI
  }, 30_000);

  it('a model trained on real clips is a working classifier', () => {
    const all = syn.clips.filter((c) => c.session !== 's3');
    const real = realClips(all, () => meta('airpods'), known);
    expect(real).toHaveLength(all.length);
    const m = ml.train(real);
    const test = syn.clips.find((c) => c.session === 's3' && c.label === 'text_mom')!;
    expect(m.predict(test.samples).label).toBe('text_mom');
  });

  describe('fetchPublicModel', () => {
    const model = ml.train(syn.clips.slice(0, 16)).toJSON();
    const stub = (body: string, status = 200) => (async () => new Response(body, { status })) as typeof fetch;
    it('loads a model', async () => {
      const r = await fetchPublicModel('/m.json', stub(JSON.stringify(model)));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.json.templates.length).toBe(16);
    });
    it('404 or an HTML fallback page: no public model yet', async () => {
      expect(await fetchPublicModel('/m.json', stub('nope', 404))).toMatchObject({ ok: false, why: 'missing', message: 'No public model yet' });
      expect(await fetchPublicModel('/m.json', stub('<!doctype html><html></html>'))).toMatchObject({ ok: false, why: 'missing' });
    });
    it('broken, wrong kind, server error or network failure: an error, never a throw', async () => {
      expect(await fetchPublicModel('/m.json', stub('{oops'))).toMatchObject({ ok: false, why: 'error' });
      expect(await fetchPublicModel('/m.json', stub('{"kind":"other"}'))).toMatchObject({ ok: false, why: 'error' });
      expect(await fetchPublicModel('/m.json', stub('x', 500))).toMatchObject({ ok: false, why: 'error' });
      const down = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
      expect(await fetchPublicModel('/m.json', down)).toMatchObject({ ok: false, why: 'error' });
    });
    it('gives up after the timeout', async () => {
      const hang = ((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as typeof fetch;
      expect(await fetchPublicModel('/m.json', hang, 30)).toMatchObject({ ok: false, why: 'error', message: expect.stringMatching(/too long/) });
    });
  });
});
