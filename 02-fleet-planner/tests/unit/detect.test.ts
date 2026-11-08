import { describe, expect, it } from 'vitest';
import { DeadlockTracker, DEADLOCK_MIN_TICKS, findCycles, JamTracker, JAM_MIN_TICKS } from '../../src/sim/detect.ts';

describe('findCycles', () => {
  it('finds each cycle once, members sorted', () => {
    // 0→1→2→0 is a cycle; 3→0 waits into it; 4↔5 swap; 6 free
    expect(findCycles([1, 2, 0, 0, 5, 4, -1])).toEqual([[0, 1, 2], [4, 5]]);
  });
  it('no cycles in chains', () => {
    expect(findCycles([1, 2, 3, -1])).toEqual([]);
  });
});

describe('DeadlockTracker', () => {
  it('starts a deadlock only after it lasts the minimum, ends it when the cycle breaks', () => {
    const t = new DeadlockTracker();
    let started = 0;
    for (let tick = 0; tick < DEADLOCK_MIN_TICKS - 1; tick++) started += t.update(tick, [1, 0]).started.length;
    expect(started).toBe(0);
    const r = t.update(DEADLOCK_MIN_TICKS - 1, [1, 0]);
    expect(r.started.map((d) => d.ids)).toEqual([[0, 1]]);
    expect(t.active()).toHaveLength(1);
    const e = t.update(DEADLOCK_MIN_TICKS, [-1, 0]);
    expect(e.ended).toHaveLength(1);
    expect(t.total).toBe(1);
  });
  it('a short cycle never counts', () => {
    const t = new DeadlockTracker();
    t.update(0, [1, 0]);
    expect(t.update(1, [-1, -1]).ended).toEqual([]);
    expect(t.total).toBe(0);
  });
});

describe('JamTracker', () => {
  it('3 agents stopped 10 s close together is a jam; it keeps its id while it lasts', () => {
    const w = 20;
    const j = new JamTracker(w);
    const cells = [w * 5 + 5, w * 5 + 6, w * 5 + 8, w * 15 + 15];
    expect(j.update(0, cells, [JAM_MIN_TICKS - 1, JAM_MIN_TICKS, JAM_MIN_TICKS, JAM_MIN_TICKS]).started).toEqual([]);
    const a = j.update(1, cells, [JAM_MIN_TICKS, JAM_MIN_TICKS, JAM_MIN_TICKS, JAM_MIN_TICKS]);
    expect(a.started.map((x) => x.agents)).toEqual([[0, 1, 2]]);
    const b = j.update(2, cells, [JAM_MIN_TICKS + 1, JAM_MIN_TICKS + 1, JAM_MIN_TICKS + 1, 0]);
    expect(b.started).toEqual([]);
    expect(j.active()[0].id).toBe(a.started[0].id);
    expect(j.update(3, cells, [0, 0, 0, 0]).ended).toHaveLength(1);
    expect(j.total).toBe(1);
  });
});

describe('detectors map positions to agent ids', () => {
  it('DeadlockTracker reports ids when given idOf', () => {
    const t = new DeadlockTracker();
    let r = { started: [] as { ids: number[] }[] };
    for (let tick = 0; tick < DEADLOCK_MIN_TICKS; tick++) r = t.update(tick, [1, 0, -1], [40, 17, 3]);
    expect(r.started.map((d) => d.ids)).toEqual([[17, 40]]);
  });
  it('JamTracker reports ids when given idOf', () => {
    const j = new JamTracker(20);
    const cells = [20 * 5 + 5, 20 * 5 + 6, 20 * 5 + 7];
    const r = j.update(0, cells, [JAM_MIN_TICKS, JAM_MIN_TICKS, JAM_MIN_TICKS], [9, 4, 12]);
    expect(r.started[0].agents).toEqual([4, 9, 12]);
  });
});
