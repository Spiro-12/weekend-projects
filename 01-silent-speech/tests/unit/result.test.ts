// Track J: the Recognize screen's action rule, guard, words and model source (no DOM).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Mode, SourceKind } from '../../web/src/core/app';
import type { ActionResultMsg, ClassDef, Dataset, DatasetClip, HelloMsg, StatusMsg } from '../../web/src/core/contracts';
import { fakeStatus } from '../../web/src/core/synth';
import * as ml from '../../web/src/ml/index';
import {
  EXCLUDED, classCount, fetchPublicModel, fingerprint, planModel, realClips, type Provenance,
} from '../../web/src/panels/result/model-source';
import {
  ACTION_GAP_MS, ActionGuard, BLOCK_REASONS, decideAction, type BlockReason, type GuardInput, type RuleInput,
} from '../../web/src/panels/result/rule';
import { OUTCOME_UNKNOWN, UNPAIRED_TEXT, describeAction, ghostReason, toastFor } from '../../web/src/panels/result/text';
import type { ClipMeta } from '../../web/src/store';

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const classes = read('../../shared/classes.json') as ClassDef[];
const ACTIONS = classes.filter((c) => c.action).map((c) => c.action as string);

const hello = (actions = ACTIONS): HelloMsg => ({ type: 'hello', v: 1, app: 'MockBridge', version: 't', actions, armed: true });
const status = (p: Partial<StatusMsg> = {}): StatusMsg => fakeStatus({ armed: true, simulated: false, ...p });

/** Everything allowed: the rule sends. */
const ok = (p: Partial<RuleInput> = {}): RuleInput => ({
  mode: 'classify', source: 'live', connOpen: true, hello: hello(), status: status(), ownModel: true,
  pred: { label: 'volume_up', accepted: true, confidence: 0.9 }, action: 'volume_up', token: 'abc123',
  now: 100_000, lastSentAt: null, inflight: false, ...p,
});

describe('decideAction: the strict rule', () => {
  it('sends when every condition holds', () => {
    expect(decideAction(ok())).toEqual({ send: true, action: 'volume_up' });
  });

  // One condition off at a time: blocked, with the right reason.
  const cases: [string, Partial<RuleInput>, BlockReason][] = [
    ['not accepted', { pred: { label: 'volume_up', accepted: false, confidence: 0.9 } }, 'not-accepted'],
    ['label none (even if a model says accepted)', { pred: { label: 'none', accepted: true, confidence: 0.99 } }, 'not-accepted'],
    ['confidence NaN', { pred: { label: 'volume_up', accepted: true, confidence: NaN } }, 'not-accepted'],
    ['confidence Infinity', { pred: { label: 'volume_up', accepted: true, confidence: Infinity } }, 'not-accepted'],
    ['class has no action', { action: null }, 'no-action'],
    ['action undefined', { action: undefined }, 'no-action'],
    ['action empty', { action: '' }, 'no-action'],
    ['Record mode', { mode: 'enroll' }, 'not-recognize'],
    ['fake source', { source: 'fake' }, 'not-live'],
    ['replay source', { source: 'replay' }, 'not-live'],
    ['no source', { source: null }, 'not-live'],
    ['connection not open', { connOpen: false }, 'not-connected'],
    ['no status yet', { status: null }, 'not-connected'],
    ['no hello yet', { hello: null }, 'not-connected'],
    ['Simulate mode', { status: status({ simulated: true }) }, 'simulated'],
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
    expect(decideAction(ok({ pred: { label: 'volume_up', accepted: 1 as unknown as boolean, confidence: 0.9 } })).send).toBe(false);
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

  it('every class: only accepted sentences with an action send', () => {
    for (const c of classes) {
      for (const accepted of [true, false]) {
        const d = decideAction(ok({ pred: { label: c.id, accepted, confidence: 0.95 }, action: c.action }));
        expect(d.send).toBe(accepted && c.id !== 'none' && !!c.action);
        if (d.send) expect(d.action).toBe(c.action);
      }
    }
  });

  // Exhaustive: every combination of these values (about 260k inputs) against an independent oracle
  // written straight from the brief. Sends iff all conditions hold; when blocked, the reason is the
  // first failing check in the documented order.
  it('exhaustive grid agrees with the brief', () => {
    const NOW = 50_000;
    const modes: Mode[] = ['classify', 'enroll'];
    const sources: (SourceKind | null)[] = ['live', 'fake', 'replay', null];
    const hellos = [hello(), hello(['text_mom']), null];
    const statuses = [null, status(), status({ armed: false }), status({ simulated: true }), status({ armed: false, simulated: true })];
    const preds = [
      { label: 'volume_up', accepted: true, confidence: 0.9 }, { label: 'volume_up', accepted: false, confidence: 0.4 },
      { label: 'none', accepted: true, confidence: 0.9 }, { label: 'none', accepted: false, confidence: 0.9 },
      { label: 'volume_up', accepted: true, confidence: NaN }, { label: 'help', accepted: true, confidence: 0.7 },
    ];
    const actions = ['volume_up', null, ''];
    const tokens = ['tok', '', null];
    const lasts = [null, NOW - 3000, NOW - 2999, NOW + 5, NaN];
    let n = 0, sent = 0;
    const wrong: unknown[] = [];
    for (const mode of modes) for (const source of sources) for (const connOpen of [true, false])
    for (const h of hellos) for (const st of statuses) for (const ownModel of [true, false]) for (const pred of preds)
    for (const action of actions) for (const token of tokens) for (const lastSentAt of lasts) for (const inflight of [true, false]) {
      const x: RuleInput = { mode, source, connOpen, hello: h, status: st, ownModel, pred, action, token, now: NOW, lastSentAt, inflight };
      const checks: [BlockReason, boolean][] = [
        ['not-accepted', pred.accepted && pred.label !== 'none' && Number.isFinite(pred.confidence)],
        ['no-action', !!action],
        ['not-recognize', mode === 'classify'],
        ['not-live', source === 'live'],
        ['not-connected', connOpen && st !== null && h !== null],
        ['simulated', st?.simulated === false],
        ['not-armed', st?.armed === true],
        ['not-own-model', ownModel],
        ['not-offered', !!action && !!h && h.actions.includes(action)],
        ['unpaired', !!token],
        ['busy', !inflight],
        ['too-soon', lastSentAt === null || NOW - lastSentAt >= 3000],
      ];
      const firstFail = checks.find(([, pass]) => !pass)?.[0];
      const d = decideAction(x);
      n++;
      if (!firstFail) sent++;
      const right = firstFail
        ? d.send === false && d.reason === firstFail && Object.keys(d).length === 2
        : d.send === true && d.action === action && Object.keys(d).length === 2;
      if (!right && wrong.length < 5) wrong.push({ x, d, firstFail });
    }
    expect(wrong).toEqual([]);
    expect(n).toBe(259_200);
    expect(sent).toBeGreaterThan(0);
    expect(BLOCK_REASONS).toHaveLength(12);
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

describe('words', () => {
  it('describes every action in classes.json, and unknown ones generically', () => {
    for (const a of ACTIONS) expect(describeAction(a)).not.toMatch(/^Run /);
    expect(describeAction('launch_rocket')).toBe('Run “launch_rocket”');
  });

  it('has a ghost reason for every block reason and source', () => {
    for (const r of BLOCK_REASONS) for (const s of ['live', 'fake', 'replay', null] as const) expect(ghostReason(r, s).length).toBeGreaterThan(5);
    expect(ghostReason('not-live', 'replay')).toMatch(/Replay/);
    expect(ghostReason('not-armed', 'live')).toMatch(/Armed/);
  });

  const res = (p: Partial<ActionResultMsg>) => ({ action: 'text_mom', ok: false, dryRun: false, message: 'm', ...p });
  it('toasts: done, dry run, unpaired, unknown outcome, cooldown, others', () => {
    expect(toastFor(res({ ok: true, message: 'Mock ran text_mom' }))).toEqual({ kind: 'ok', title: 'Done on your Mac', body: 'Mock ran text_mom' });
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
    expect(toastFor(res({ error: 'weird', message: 'Something odd happened' })).body).toBe('Something odd happened');
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

  it('plan: train on 2+ real classes, else keep a practice or public model, else public', () => {
    const plan = (realClasses: number, current: Provenance | null, fresh = false, force = false) => planModel({ realClasses, current, fresh, force });
    expect(plan(2, null)).toBe('train');
    expect(plan(8, 'public')).toBe('train');
    expect(plan(8, 'other')).toBe('train'); // Record's model is replaced by one we know is yours
    expect(plan(8, 'own', false)).toBe('train'); // new recordings since
    expect(plan(8, 'own', true)).toBe('keep');
    expect(plan(8, 'own', true, true)).toBe('train'); // Re-train
    expect(plan(1, null)).toBe('public');
    expect(plan(0, 'own', true)).toBe('public'); // your recordings are gone
    expect(plan(1, 'other')).toBe('keep'); // practice model from Record stays
    expect(plan(1, 'public')).toBe('keep');
    expect(plan(1, 'other', false, true)).toBe('public');
  });

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
