import { describe, expect, it } from 'vitest';
import type { DatasetClip, MotionSample } from '../../web/src/core/contracts';
import { mulberry32 } from '../../web/src/core/rng';
import {
  Prompter, cleanSessionName, estimateHz, evalSet, exportFileName, makeBlock, nextSessionName, promptText,
  rejectReason, shortLabel, sourceNow,
} from '../../web/src/panels/enroll/logic';

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

describe('names', () => {
  it('next session is the next free sN', () => {
    expect(nextSessionName([])).toBe('s1');
    expect(nextSessionName(['s1', 's3', 'demo', 's10x'])).toBe('s4');
  });
  it('session names are safe for files and ids', () => {
    expect(cleanSessionName('  s 2 / test ')).toBe('s-2-test');
    expect(cleanSessionName('///')).toBe('');
    expect(cleanSessionName('x'.repeat(40))).toHaveLength(24);
  });
  it('export file name uses local time', () => {
    expect(exportFileName('s1', new Date(2026, 9, 5, 7, 3))).toBe('ss-dataset-s1-20261005-0703.json');
  });
  it('short labels and prompt text', () => {
    expect(['text_mom', 'volume_up', 'calendar', 'demo_48h', 'none'].map(shortLabel)).toEqual(['text', 'volume'.slice(0, 5), 'calen', 'demo', 'none']);
    expect(promptText('none', '(still, swallow, nod, glance)')).toBe('Stay still. Maybe swallow or nod.');
    expect(promptText('help', 'I need help right now')).toBe('I need help right now');
  });
});

describe('dataset helpers', () => {
  it('estimateHz is the median rate, rounded', () => {
    expect(estimateHz([{ samples: samples(50, 0.04) }, { samples: samples(50, 0.02) }, { samples: samples(60, 0.04) }], 0)).toBe(25);
    expect(estimateHz([{ samples: samples(80, 0.02) }], 25)).toBe(50);
    expect(estimateHz([], 25)).toBe(25);
    expect(estimateHz([{ samples: samples(1) }], 25)).toBe(25);
  });
  it('source is airpods only for a live, non simulated bridge', () => {
    expect(sourceNow('live', false)).toBe('airpods');
    expect(sourceNow('live', true)).toBe('fake');
    expect(sourceNow('live', undefined)).toBe('fake');
    expect(sourceNow('fake', false)).toBe('fake');
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
