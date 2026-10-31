import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Dataset, DatasetClip, MotionSample, StatusMsg } from '../../web/src/core/contracts';
import { mulberry32 } from '../../web/src/core/rng';
import { fakeStatus } from '../../web/src/core/synth';
import { Evaluator } from '../../web/src/panels/enroll/accuracy';
import { runEval } from '../../web/src/panels/enroll/eval-core';
import {
  Prompter, cleanSessionName, clipHz, coverageReject, evalSet, exportFileName, makeBlock, nextSessionName, planImport,
  promptText, recKind, rejectReason, shortLabel, signalReject, takeReject,
} from '../../web/src/panels/enroll/logic';

const tiny = JSON.parse(readFileSync(new URL('../../shared/fixtures/dataset.tiny.json', import.meta.url), 'utf8')) as Dataset;

/** n samples every dt seconds from t0. */
const samples = (n: number, dt = 0.04, t0 = 100): MotionSample[] =>
  Array.from({ length: n }, (_, i) => ({ seq: i, t: t0 + i * dt, q: [1, 0, 0, 0], rr: [0, 0, 0], ua: [0, 0, 0] }));

describe('rejectReason', () => {
  it('accepts a normal clip', () => {
    expect(rejectReason({ samples: samples(50), gapPct: 0 })).toBeNull();
    expect(rejectReason({ samples: samples(10), gapPct: 20 })).toBeNull(); // limits are inclusive
  });
  it('rejects fewer than 10 samples', () => {
    expect(rejectReason({ samples: samples(9), gapPct: 0 })?.code).toBe('short');
  });
  it('rejects gaps over 20 %', () => {
    const r = rejectReason({ samples: samples(50), gapPct: 20.5 });
    expect(r?.code).toBe('gaps');
    expect(r?.message).toMatch(/patchy \(21% gaps\)/);
  });
  it('rejects a stall: any interval over 0.5 s', () => {
    const s = samples(40);
    for (let i = 20; i < s.length; i++) s[i].t += 0.47; // one 0.51 s hole
    expect(rejectReason({ samples: s, gapPct: 2 })?.code).toBe('stall');
    const ok = samples(40);
    for (let i = 20; i < ok.length; i++) ok[i].t += 0.45; // 0.49 s: fine
    expect(rejectReason({ samples: ok, gapPct: 2 })).toBeNull();
  });
  it('rejects clips longer than 10 s', () => {
    expect(rejectReason({ samples: samples(260), gapPct: 0 })?.code).toBe('long'); // 10.36 s
    expect(rejectReason({ samples: samples(250), gapPct: 0 })).toBeNull(); // 9.96 s
  });
});

describe('Prompter', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('hands out shuffled blocks with every class once', () => {
    const p = new Prompter(mulberry32(1));
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = p.current(ids)!;
      seen.push(id);
      p.done(id);
    }
    for (let b = 0; b < 3; b++) expect(seen.slice(4 * b, 4 * b + 4).sort()).toEqual(ids);
    expect(seen.slice(0, 4)).not.toEqual(ids); // shuffled (for this seed)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]); // never twice in a row
  });
  it('only asks for classes that still need recordings, and null when done', () => {
    const p = new Prompter(mulberry32(2));
    expect(['a', 'b']).toContain(p.current(['a', 'b']));
    expect(p.current(['b'])).toBe('b'); // a got full (e.g. imported): dropped from the block
    expect(p.current([])).toBeNull();
  });
  it('a rejected take keeps the same prompt', () => {
    const p = new Prompter(mulberry32(3));
    const first = p.current(ids);
    expect(p.current(ids)).toBe(first);
  });
  it('skip moves on, the skipped one comes back in the next block', () => {
    const p = new Prompter(mulberry32(4));
    const skipped = p.current(ids)!;
    p.done(skipped);
    const rest: string[] = [];
    for (let i = 0; i < 3; i++) { const id = p.current(ids)!; rest.push(id); p.done(id); }
    expect(rest).not.toContain(skipped);
    const next: string[] = [];
    for (let i = 0; i < 4; i++) { const id = p.current(ids)!; next.push(id); p.done(id); }
    expect(next.sort()).toEqual(ids);
  });
  it('redo puts the class back in front', () => {
    const p = new Prompter(mulberry32(5));
    const a = p.current(ids)!;
    p.done(a);
    expect(p.current(ids)).not.toBe(a);
    p.pushFront(a);
    expect(p.current(ids)).toBe(a);
  });
  it('makeBlock avoids starting with the last prompt', () => {
    for (let seed = 0; seed < 50; seed++) expect(makeBlock(['x', 'y', 'z'], 'x', mulberry32(seed))[0]).not.toBe('x');
    expect(makeBlock(['x'], 'x')).toEqual(['x']);
  });
});

describe('signalReject (finding 1: a stalled stream must not be saved)', () => {
  // A clip as the shell cuts it: samples from pressT - pad to releaseT + pad.
  const cut = (pressT: number, releaseT: number, s = samples(Math.round((releaseT - pressT + 0.6) / 0.02) + 1, 0.02, pressT - 0.3)) =>
    ({ samples: s, pressT, releaseT, padSec: 0.3 });
  const ok = { wallHoldSec: 1.2, msSinceMotionAtRelease: 30 };
  it('accepts a normal take', () => {
    expect(signalReject(ok, cut(100, 101.2))).toBeNull();
  });
  it('rejects when the stream died at the press (sample clock stopped, wall clock didn\'t)', () => {
    // stream dead: press and release both get the last sample time, the shell cuts the old samples
    const dead = cut(100, 100, samples(16, 0.02, 99.7));
    expect(signalReject(ok, dead)?.code).toBe('nosignal');
  });
  it('rejects when the stream stalled mid hold', () => {
    expect(signalReject({ wallHoldSec: 1.4, msSinceMotionAtRelease: 30 }, cut(100, 100.4))?.code).toBe('nosignal');
    expect(signalReject({ wallHoldSec: 0.85, msSinceMotionAtRelease: 30 }, cut(100, 100.4))).toBeNull(); // 0.45 s skew: fine
  });
  it('rejects when no sample arrived in the last 0.5 s before letting go', () => {
    expect(signalReject({ ...ok, msSinceMotionAtRelease: 600 }, cut(100, 101.2))?.code).toBe('nosignal');
  });
  it('rejects when the samples stop short of release + pad (stream died after release)', () => {
    const c = cut(100, 101.2);
    expect(coverageReject({ ...c, samples: c.samples.filter((x) => x.t < 101.35) })?.code).toBe('nosignal');
    expect(coverageReject({ ...c, samples: c.samples.filter((x) => x.t < 101.45) })).toBeNull(); // within 0.1 s
  });
  it('rejects when there is no data before the press (pressed right as the stream started)', () => {
    const c = cut(100, 101.2);
    expect(coverageReject({ ...c, samples: c.samples.filter((x) => x.t > 99.85) })?.code).toBe('early');
  });
  it('takeReject: a dead stream that comes back mid hold says "No signal", not "Too long" (finding 4 of round 2)', () => {
    // dead at press (sample clock stuck at 100), back 10 s later while Space is still held
    const before = samples(16, 0.02, 99.7);
    const after = samples(76, 0.02, 110.2);
    const c = { samples: [...before, ...after], pressT: 100, releaseT: 111.4, padSec: 0.3, gapPct: 1.3 };
    expect(rejectReason(c)?.code).toBe('long'); // what the old order said
    expect(takeReject({ wallHoldSec: 1.4, msSinceMotionAtRelease: 20 }, c)).toMatchObject({ code: 'nosignal' });
  });
  it('takeReject: a patchy stream says "patchy", not "No signal"', () => {
    const c = cut(100, 101.2);
    const holey = { ...c, samples: c.samples.filter((_, i) => i % 3 === 0 && i > 3), gapPct: 60 };
    expect(coverageReject(holey)).not.toBeNull();
    expect(takeReject(ok, holey)?.code).toBe('gaps');
  });
  it('takeReject: a normal take passes every check', () => {
    expect(takeReject(ok, { ...cut(100, 101.2), gapPct: 0 })).toBeNull();
  });
});

describe('recKind (finding 3: real data only from live, non simulated, connected AirPods)', () => {
  const st = (p: Partial<StatusMsg>) => fakeStatus({ simulated: false, ...p });
  it('live + real AirPods = real', () => expect(recKind('live', 'open', st({}))).toBe('real'));
  it('fake source or Mac simulate = practice', () => {
    expect(recKind('fake', 'open', fakeStatus())).toBe('practice');
    expect(recKind('live', 'open', st({ simulated: true }))).toBe('practice');
  });
  it('anything else records nothing', () => {
    expect(recKind('live', 'open', null)).toBeNull();
    expect(recKind('live', 'closed', st({}))).toBeNull();
    expect(recKind('live', 'open', st({ headphones: 'disconnected' }))).toBeNull();
    expect(recKind('live', 'open', st({ auth: 'denied' }))).toBeNull();
    expect(recKind('replay', 'open', st({}))).toBeNull();
    expect(recKind(undefined, 'connecting', null)).toBeNull();
  });
});

describe('planImport (finding 6: no merging by session name)', () => {
  const known = new Set(['text_mom', 'volume_up', 'none', 'help']);
  const local = (o: Record<string, string[]>) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
  const airpods = (session: string, ids: string[], subject = 'spiro'): Dataset => ({
    ...tiny, subject, source: 'airpods', session,
    clips: ids.map((id, i) => ({ ...tiny.clips[i % tiny.clips.length], id, session })),
  });
  it('someone else\'s or fake data gets <subject>-<session>', () => {
    const p = planImport(tiny, local({ s1: ['mine-1'] }), 'spiro', known);
    expect(p.renames).toEqual([['s1', 'synthetic-s1']]);
    expect(new Set(p.clips.map((c) => c.session))).toEqual(new Set(['synthetic-s1']));
    expect(planImport(tiny, local({}), 'spiro', known).renames).toEqual([['s1', 'synthetic-s1']]); // fake: even if s1 is free
  });
  it('your own real session goes in as is when the name is free', () => {
    const p = planImport(airpods('s2', ['a', 'b']), local({ s1: ['x'] }), 'Spiro', known);
    expect(p.renames).toEqual([]);
    expect(p.clips.map((c) => c.session)).toEqual(['s2', 's2']);
  });
  it('a different session with a name that exists here is renamed, the same session merges', () => {
    expect(planImport(airpods('s1', ['a', 'b']), local({ s1: ['x'] }), 'spiro', known).renames).toEqual([['s1', 'spiro-s1']]);
    expect(planImport(airpods('s1', ['a', 'b']), local({ s1: ['x'], 'spiro-s1': ['y'] }), 'spiro', known).renames)
      .toEqual([['s1', 'spiro-s1-2']]);
    expect(planImport(airpods('s1', ['x', 'b']), local({ s1: ['x'] }), 'spiro', known).renames).toEqual([]); // shares clip x
  });
  it('re-importing the same fake file lands in the same renamed session', () => {
    const p = planImport(tiny, local({ 'synthetic-s1': tiny.clips.map((c) => c.id) }), 'spiro', known);
    expect(p.renames).toEqual([['s1', 'synthetic-s1']]);
  });
  it('drops clips with unknown labels', () => {
    const p = planImport({ ...tiny, clips: [...tiny.clips, { ...tiny.clips[0], id: 'q', label: 'mystery' }] }, local({}), 'spiro', known);
    expect(p.unknown).toBe(1);
    expect(p.clips).toHaveLength(6);
  });
});

describe('accuracy runner (finding 7)', () => {
  const clips = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, label: i % 2 ? 'a' : 'b', session: 's1', samples: samples(3) }));
  it('the main thread fallback skips big sets instead of freezing the page', () => {
    const r = runEval({ id: 1, loo: clips(151), loso: clips(200) }, 150);
    expect(r).toEqual({ id: 1, ok: true, res: { loo: null, loso: null, skipped: ['loo', 'loso'] } });
  });
  it('a worker that never answers times out, and the next run gets a fresh worker', async () => {
    vi.useFakeTimers();
    const made: { terminated: boolean }[] = [];
    const makeWorker = () => {
      const w = { onmessage: null, onerror: null, terminated: false, postMessage() {}, terminate() { w.terminated = true; } };
      made.push(w);
      return w as unknown as Worker;
    };
    const ev = new Evaluator({ makeWorker, timeoutMs: 1000 });
    const p = ev.run(clips(4), null);
    const caught = p.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await caught).toBe('timed out');
    expect(made[0].terminated).toBe(true);
    void ev.run(clips(4), null).catch(() => {});
    expect(made).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1001);
    vi.useRealTimers();
  });
  it('answers from the worker are matched to their request', async () => {
    let w!: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: { id: number }): void };
    const makeWorker = () => {
      w = { onmessage: null, postMessage: (m) => setTimeout(() => w.onmessage?.({ data: { id: m.id, ok: true, res: { loo: null, loso: null, skipped: [] } } }), 0) };
      return w as unknown as Worker;
    };
    const ev = new Evaluator({ makeWorker });
    await expect(ev.run(clips(4), null)).resolves.toEqual({ loo: null, loso: null, skipped: [] });
  });
});

describe('names', () => {
  it('next session is the next free sN (or fake-N for practice)', () => {
    expect(nextSessionName([])).toBe('s1');
    expect(nextSessionName(['s1', 's3', 'demo', 's10x', 'fake-7'])).toBe('s4');
    expect(nextSessionName(['s1', 'fake-1', 'fake-3', 'fake-x'], 'fake-')).toBe('fake-4');
    expect(nextSessionName([], 'fake-')).toBe('fake-1');
  });
  it('session names are safe for files and ids', () => {
    expect(cleanSessionName('  s 2 / test ')).toBe('s-2-test');
    expect(cleanSessionName('///')).toBe('');
    expect(cleanSessionName('x'.repeat(40))).toHaveLength(24);
  });
  it('export file name uses local time and a safe session name', () => {
    expect(exportFileName('s1', new Date(2026, 9, 5, 7, 3))).toBe('ss-dataset-s1-20261005-0703.json');
    expect(exportFileName('a b/c', new Date(2026, 9, 5, 7, 3))).toBe('ss-dataset-a-b-c-20261005-0703.json');
  });
  it('short labels and prompt text', () => {
    expect(['text_mom', 'volume_up', 'calendar', 'demo_48h', 'none'].map(shortLabel)).toEqual(['text', 'volume'.slice(0, 5), 'calen', 'demo', 'none']);
    expect(promptText('none', '(still, swallow, nod, glance)')).toBe('Stay still. Maybe swallow or nod.');
    expect(promptText('help', 'I need help right now')).toBe('I need help right now');
  });
});

describe('dataset helpers', () => {
  it('clipHz is 1 / median interval, so dropped samples do not lower it', () => {
    expect(clipHz(samples(50, 0.04), 0)).toBe(25);
    expect(clipHz(samples(80, 0.02), 0)).toBe(50);
    const gappy = samples(80, 0.02).filter((_, i) => i % 5 !== 0);
    expect(clipHz(gappy, 0)).toBe(50);
    expect(clipHz(samples(1), 25)).toBe(25);
  });
  it('evalSet needs 2+ clips for 2+ classes and drops classes with one clip', () => {
    const c = (label: string, session = 's1') => ({ id: `${label}-${Math.random()}`, label, session } as DatasetClip);
    expect(evalSet([c('a'), c('a'), c('b')], ['a', 'b'])).toBeNull();
    const set = evalSet([c('a'), c('a'), c('b'), c('b', 's2'), c('d'), c('z'), c('z')], ['a', 'b', 'd'])!;
    expect(set.labels).toEqual(['a', 'b']);
    expect(set.clips.map((x) => x.label).sort()).toEqual(['a', 'a', 'b', 'b']);
    expect(set.sessions.sort()).toEqual(['s1', 's2']);
  });
});
