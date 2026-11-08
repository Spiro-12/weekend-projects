// Hand-placed scenarios on the real default layout (62 x 35): people in 2-cell aisles, forklift safety fields,
// detours, pockets, and one-way hints on a small made-up layout.
import { describe, expect, it } from 'vitest';
import defaultLayout from '../../../data/layouts/default.json';
import type { LayoutFile } from '../../../src/contracts/types.ts';
import { CentralController } from '../../../src/sim/traffic/central/index.ts';
import { at, Harness } from './harness.ts';
import { NO_VIOLATIONS } from './property.ts';

const P = at(62);
const E = 0;
const S = 1;
const W = 2;
const N = 3;

function harness(layout?: LayoutFile): { h: Harness; c: CentralController } {
  const c = new CentralController();
  return { h: new Harness({ controller: c, checks: true, layout }), c };
}

describe('one brain: people in 2-cell aisles', () => {
  it('a robot and a person head-on in the same lane pass each other within 120 ticks', () => {
    const { h, c } = harness();
    const r = h.place('amr', P(4, 6), P(4, 24), S);
    const p = h.place('picker', P(4, 24), P(4, 6), N);
    h.runUntilReached(400);
    expect(r.reachedAt).toBeGreaterThan(0);
    expect(p.reachedAt).toBeGreaterThan(0);
    expect(Math.max(r.reachedAt, p.reachedAt)).toBeLessThanOrEqual(120); // 18 cells at 3 ticks/cell is 54 ticks
    expect(c.counters.yields).toBeGreaterThan(0); // the robot made way for the person
    expect(h.violations).toEqual(NO_VIOLATIONS);
  });

  // The spike's placement. Two people walking abreast meet two robots abreast, so the robots must back out of the aisle
  // (robots yield to people) before anyone gets through: 120 ticks is not reachable here. The spike's controller on the
  // same placement: 175 ticks (robots 175, 148, 64; people 125, 85, 67). This one: 147.
  it('three robots and three people crossing in one aisle all get through (within 150 ticks)', () => {
    const { h } = harness();
    const agents = [
      h.place('amr', P(4, 6), P(4, 24), S),
      h.place('amr', P(5, 8), P(5, 22), S),
      h.place('amr', P(4, 10), P(5, 25), S),
      h.place('picker', P(4, 24), P(4, 6), N),
      h.place('picker', P(5, 21), P(5, 7), N),
      h.place('picker', P(4, 19), P(4, 9), N),
    ];
    h.runUntilReached(800);
    const reached = agents.map((a) => a.reachedAt);
    expect(reached.every((t) => t > 0), `${reached}`).toBe(true);
    expect(Math.max(...reached), `${reached}`).toBeLessThanOrEqual(150);
    expect(h.violations).toEqual(NO_VIOLATIONS);
  });
});

describe('one brain: forklift safety fields', () => {
  it('two forklifts facing each other one cell apart in a cross aisle resolve', () => {
    const { h, c } = harness();
    const f1 = h.place('forklift', P(20, 4), P(30, 4), E);
    const f2 = h.place('forklift', P(22, 4), P(10, 4), W);
    h.runUntilReached(300);
    expect(f1.reachedAt).toBeGreaterThan(0);
    expect(f2.reachedAt).toBeGreaterThan(0);
    expect(Math.max(f1.reachedAt, f2.reachedAt)).toBeLessThanOrEqual(120);
    expect(c.counters.safetyPushes).toBeGreaterThan(0); // the first one pushed the other out of its safety cell
    expect(h.violations).toEqual(NO_VIOLATIONS);
  });

  it('two forklifts facing each other one cell apart in a 2-cell picking aisle resolve', () => {
    const { h } = harness();
    const f1 = h.place('forklift', P(8, 10), P(8, 20), S);
    const f2 = h.place('forklift', P(8, 12), P(8, 7), N);
    h.runUntilReached(300);
    expect(f1.reachedAt).toBeGreaterThan(0);
    expect(f2.reachedAt).toBeGreaterThan(0);
    expect(Math.max(f1.reachedAt, f2.reachedAt)).toBeLessThanOrEqual(150);
    expect(h.violations).toEqual(NO_VIOLATIONS);
  });

  it('a robot standing in a forklift’s safety cell is pushed out of it', () => {
    const { h, c } = harness();
    h.place('picker', P(13, 4), P(13, 4)); // stands still: the AMR's goal is taken
    const f = h.place('forklift', P(10, 4), P(20, 4), E, -10); // highest priority
    const r = h.place('amr', P(12, 4), P(13, 4), E);
    h.run(1);
    expect(r.to).toBeGreaterThanOrEqual(0); // pushed: moving out of the safety cell although its own way is blocked
    expect(r.to).not.toBe(P(11, 4)); // ... and not into the forklift's path
    expect(f.to).toBe(-1); // the forklift waits for the cell to clear
    expect(c.counters.safetyPushes).toBe(1);
    h.runUntilReached(200);
    expect(f.reachedAt).toBeGreaterThan(0);
    expect(f.reachedAt).toBeLessThanOrEqual(80);
    expect(h.violations).toEqual(NO_VIOLATIONS);
  });

  it('a forklift never moves with a person in its safety cell: it waits, then comes in from the side', () => {
    const { h, c } = harness();
    const f = h.place('forklift', P(10, 4), P(11, 4), E);
    const p = h.place('picker', P(12, 4), P(12, 4)); // stands still in the safety cell ahead of the goal
    let waited = 0;
    for (let t = 0; t < 100 && f.reachedAt < 0; t++) {
      h.step();
      if (f.to < 0 && f.cell === P(10, 4)) waited++;
      expect(f.safety).not.toBe(p.cell);
    }
    expect(waited).toBeGreaterThanOrEqual(5); // waitTicks, then the detour
    expect(c.counters.detours).toBeGreaterThan(0);
    expect(f.reachedAt).toBeGreaterThan(0);
    expect(f.heading).not.toBe(E); // it did not arrive heading at the person
    expect(h.violations).toEqual(NO_VIOLATIONS);
  });
});

describe('one brain: detours and pockets', () => {
  it('a robot blocked by a parked robot in its lane detours through the other lane', () => {
    const { h, c } = harness();
    h.place('amr', P(4, 12), P(4, 12)); // parked (reached its goal, stays)
    const r = h.place('amr', P(4, 8), P(4, 20), S);
    h.runUntilReached(300);
    expect(r.reachedAt).toBeGreaterThan(0);
    expect(r.reachedAt).toBeLessThanOrEqual(100);
    expect(c.counters.detours).toBeGreaterThan(0);
    expect(h.events.detour).toBe(c.counters.detours); // reported as detour TrafficEvents
    expect(h.violations).toEqual(NO_VIOLATIONS);
  });

  it('a robot blocked by a person standing in its lane detours around them', () => {
    const { h, c } = harness();
    h.place('picker', P(5, 14), P(5, 14)); // standing still
    const r = h.place('humanoid', P(5, 8), P(5, 22), S);
    h.runUntilReached(300);
    expect(r.reachedAt).toBeGreaterThan(0);
    expect(r.reachedAt).toBeLessThanOrEqual(120);
    expect(c.counters.detours).toBeGreaterThan(0);
    expect(h.violations).toEqual(NO_VIOLATIONS);
  });

  it('a robot drives into a charger pocket when it is the goal, and other robots drive past pockets', () => {
    const { h } = harness();
    const charger = P(5, 31);
    const r = h.place('amr', P(1, 30), charger, E);
    const passer = h.place('amr', P(2, 29), P(12, 30), E);
    h.runUntilReached(200);
    expect(r.reachedAt).toBeGreaterThan(0);
    expect(r.cell).toBe(charger);
    expect(passer.reachedAt).toBeGreaterThan(0);
    expect(h.violations).toEqual(NO_VIOLATIONS); // pocketNotGoal included
  });
});

describe('one brain: parked robots (ready, goal = cell, as Track A marks them)', () => {
  it('a robot whose exact goal is held by a resting robot gets there (the resting robot is moved aside)', () => {
    const c = new CentralController();
    const h = new Harness({ controller: c, checks: true, parkedReady: true });
    const goal = P(30, 4);
    h.place('amr', goal, goal); // resting on the cell: parked, no work to finish
    const r = h.place('amr', P(24, 4), goal, E);
    h.runUntilReached(300);
    expect(r.reachedAt).toBeGreaterThan(0);
    expect(r.reachedAt).toBeLessThanOrEqual(80); // 6 cells, then 6 x waitTicks blocked before it may push
    expect(c.counters.pushes).toBeGreaterThan(0);
    expect(h.violations).toEqual(NO_VIOLATIONS);
  });
});

describe('one brain: guidance', () => {
  // Two 1-cell lanes: row 1 one-way east, row 2 one-way west; columns 1..8.
  const oneWay = { ...(defaultLayout as LayoutFile), id: 'one-way-test', zones: [], grid: ['XXXXXXXXXX', 'X>>>>>>>>X', 'X<<<<<<<<X', 'XXXXXXXXXX'] } as LayoutFile;
  const plain = { ...oneWay, id: 'plain-test', grid: ['XXXXXXXXXX', 'X========X', 'X========X', 'XXXXXXXXXX'] } as LayoutFile;
  const Q = at(10);

  it('one-way hints: of two equal routes the robot takes the lane that runs its way', () => {
    for (const [layout, wantRow] of [[oneWay, 2], [plain, 1]] as const) {
      const { h } = harness(layout);
      const r = h.place('amr', Q(8, 1), Q(1, 2), W);
      const rows = new Set<number>();
      for (let t = 0; t < 100 && r.reachedAt < 0; t++) {
        h.step();
        if (r.cell !== Q(8, 1) && r.cell !== Q(1, 2)) rows.add(Math.floor(r.cell / 10));
      }
      expect(r.reachedAt, layout.id).toBeGreaterThan(0);
      // with hints: down to row 2 first, then west with the arrows; without: straight on (fewer turns) along row 1
      expect([...rows], layout.id).toEqual([wantRow]);
    }
  });

  it('one-way hints are a soft cost: when the only short way is against the arrows the robot still goes', () => {
    const { h } = harness(oneWay);
    const r = h.place('amr', Q(1, 2), Q(8, 2), E);
    h.runUntilReached(100);
    expect(r.reachedAt).toBeGreaterThan(0);
    expect(r.reachedAt).toBeLessThanOrEqual(30); // 7 cells at 3 ticks, straight against the arrows
  });

  it('ties go to fewer turns', () => {
    const { h } = harness();
    // goal 6 east and 2 south across the open cross aisle: any monotone route is shortest; fewest turns is one turn
    const r = h.place('amr', P(20, 3), P(26, 5), E);
    let turns = 0;
    let heading = E;
    for (let t = 0; t < 100 && r.reachedAt < 0; t++) {
      h.step();
      if (r.heading !== heading) {
        turns++;
        heading = r.heading;
      }
    }
    expect(r.reachedAt).toBeGreaterThan(0);
    expect(turns).toBe(1);
  });
});
