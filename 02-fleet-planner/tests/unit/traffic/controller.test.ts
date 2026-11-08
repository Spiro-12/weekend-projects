// CentralController against hand-built TrafficInputs: the interface semantics one tick at a time (PROTOCOL §5).
import { describe, expect, it } from 'vitest';
import defaultLayout from '../../../data/layouts/default.json';
import smallLayout from '../../../data/layouts/small.json';
import type { LayoutFile, PassClass } from '../../../src/contracts/types.ts';
import { CentralController } from '../../../src/sim/traffic/central/index.ts';
import { createPlan, type TrafficAgent, type TrafficInput } from '../../../src/sim/traffic/types.ts';
import { buildWorld, DistanceCache } from '../../../src/sim/world.ts';

const world = buildWorld(defaultLayout as LayoutFile);
const dist = new DistanceCache(world);
const P = (x: number, y: number) => y * 62 + x;
const E = 0;
const S = 1;
const W = 2;

interface R {
  cell: number;
  goal: number;
  heading?: number;
  passClass?: PassClass;
  sinceProgress?: number;
  blocked?: number;
  /** Not at a cell boundary: moving into this cell (it holds both). */
  movingTo?: number;
}

/** Robots get ids 0..n-1 in the given order (also the priority order unless `order` is given); people after them. */
function scene(robots: R[], people: number[] = [], extra: Partial<TrafficInput> = {}, tick = 100) {
  const n = robots.length + people.length;
  const occ = new Int32Array(world.n).fill(-1);
  const ready = new Int32Array(n).fill(-1);
  const agents: (TrafficAgent | null)[] = [];
  robots.forEach((r, id) => {
    const fork = r.passClass === 'forklift';
    agents.push({
      id, vendor: 'A', passClass: r.passClass ?? 'small', cell: r.cell, heading: r.heading ?? E, goal: r.goal,
      safetyCells: fork ? 1 : 0, turnTicks: fork ? 2 : 1, sinceProgress: r.sinceProgress ?? 0, blockedSinceProgress: r.blocked ?? 0,
    });
    occ[r.cell] = id;
    if (r.movingTo !== undefined) occ[r.movingTo] = id;
    else if (r.goal >= 0 && r.goal !== r.cell) ready[id] = tick;
  });
  people.forEach((c, k) => {
    agents.push(null);
    occ[c] = robots.length + k;
  });
  const input: TrafficInput = { tick, world, dist, agents, order: robots.map((_, i) => i), ready, occ, yields: [], ...extra };
  return { input, out: createPlan(n), occ };
}

function plan(c: CentralController, input: TrafficInput, out = createPlan(input.agents.length)) {
  c.recover(input);
  c.plan(input, out);
  return out;
}

describe('CentralController: one tick at a time', () => {
  it('moves a ready robot one step down its gradient, and reports want even when it has to stay', () => {
    const free = scene([{ cell: P(20, 4), goal: P(25, 4) }]);
    let out = plan(new CentralController(), free.input);
    expect([out.moveTo[0], out.dir[0], out.want[0], out.safety[0]]).toEqual([P(21, 4), E, P(21, 4), -1]);

    const blocked = scene([{ cell: P(20, 4), goal: P(25, 4) }], [P(21, 4)]);
    out = plan(new CentralController(), blocked.input);
    expect([out.moveTo[0], out.dir[0], out.want[0]]).toEqual([-1, -1, P(21, 4)]);
  });

  it('never starts a move into a cell that is being left (causal PIBT)', () => {
    const { input } = scene([
      { cell: P(20, 4), goal: P(25, 4) },
      { cell: P(21, 4), goal: P(30, 4), movingTo: P(22, 4) },
    ]);
    const out = plan(new CentralController(), input);
    expect(out.moveTo[0]).toBe(-1);
    expect(out.want[0]).toBe(P(21, 4)); // waits for the robot ahead (wait-for graph edge)
  });

  it('pushes a lower-priority robot out of the way and waits for the cell to clear (no swap)', () => {
    const { input } = scene([
      { cell: P(20, 4), goal: P(25, 4) },
      { cell: P(21, 4), goal: P(10, 4), heading: W },
    ]);
    const out = plan(new CentralController(), input);
    expect(out.moveTo[0]).toBe(-1); // the pusher waits
    expect(out.want[0]).toBe(P(21, 4));
    expect(out.moveTo[1]).toBeGreaterThanOrEqual(0); // the pushed robot steps aside...
    expect(out.moveTo[1]).not.toBe(P(20, 4)); // ...never through the pusher
  });

  it('the higher-priority robot wins a head-on: swapping the order swaps who gets pushed', () => {
    const robots: R[] = [
      { cell: P(20, 4), goal: P(25, 4) },
      { cell: P(21, 4), goal: P(10, 4), heading: W },
    ];
    const a = plan(new CentralController(), scene(robots).input);
    const b = plan(new CentralController(), scene(robots, [], { order: [1, 0] }).input);
    expect(a.moveTo[0]).toBe(-1);
    expect(a.moveTo[1]).toBeGreaterThanOrEqual(0);
    expect(b.moveTo[1]).toBe(-1);
    expect(b.moveTo[0]).toBeGreaterThanOrEqual(0);
  });

  it('robots yield to people: a robot asked by a person makes way and reports a yield event', () => {
    const person = P(20, 3);
    // the robot wants to go up past the person: on its own it would wait, but asked to make way it must move
    const { input } = scene([{ cell: P(20, 4), goal: P(20, 1), heading: 3 }], [person]);
    input.yields = [0, person];
    const out = plan(new CentralController(), input);
    expect(out.moveTo[0]).toBeGreaterThanOrEqual(0);
    expect(out.moveTo[0]).not.toBe(person);
    expect(out.events).toContainEqual({ t: 'yield', agent: 0, cell: person });
  });

  it('pockets are entered only by the robot whose goal they are, even when pushed', () => {
    // A robot in the pack lane above a charger, boxed in by people; a person asks it to make way.
    const charger = P(5, 31);
    const people = [P(4, 30), P(6, 30), P(5, 29)];
    const asked = scene([{ cell: P(5, 30), goal: P(40, 30) }], people);
    asked.input.yields = [0, P(5, 29)];
    expect(plan(new CentralController(), asked.input).moveTo[0]).toBe(-1); // nowhere to go but the pocket: stays

    const own = scene([{ cell: P(5, 30), goal: charger }], people);
    own.input.yields = [0, P(5, 29)];
    expect(plan(new CentralController(), own.input).moveTo[0]).toBe(charger);
  });

  it('a forklift reserves the safety cell ahead and pushes a robot standing in it', () => {
    const fork: R = { cell: P(10, 4), goal: P(20, 4), passClass: 'forklift' };
    const free = plan(new CentralController(), scene([fork]).input);
    expect([free.moveTo[0], free.safety[0]]).toEqual([P(11, 4), P(12, 4)]);

    const { input } = scene([fork, { cell: P(12, 4), goal: P(13, 4) }], [P(13, 4)]);
    const c = new CentralController();
    const out = plan(c, input);
    expect(out.moveTo[0]).toBe(-1); // waits for the field to clear
    expect(out.moveTo[1]).toBeGreaterThanOrEqual(0); // pushed out of the safety cell...
    expect([P(11, 4), P(10, 4)]).not.toContain(out.moveTo[1]); // ...not into the forklift's path
    expect(c.counters.safetyPushes).toBe(1);
  });

  it('a forklift waiting on its safety field keeps its wanted cell from robots it outranks', () => {
    // person in the field; an AMR of lower priority wants the free cell the forklift is waiting to enter
    const robots: R[] = [
      { cell: P(10, 4), goal: P(20, 4), passClass: 'forklift' },
      { cell: P(11, 3), goal: P(11, 5), heading: S },
    ];
    const lower = plan(new CentralController(), scene(robots, [P(12, 4)]).input);
    expect(lower.moveTo[0]).toBe(-1);
    expect(lower.moveTo[1]).not.toBe(P(11, 4));
    const higher = plan(new CentralController(), scene(robots, [P(12, 4)], { order: [1, 0] }).input);
    expect(higher.moveTo[1]).toBe(P(11, 4)); // with higher priority the AMR may take it
  });

  it('a forklift never plans onto a "." cell', () => {
    // forklift on the cross aisle row 28 with its goal on row 28: the pack lane below is not forklift-rated
    const { input } = scene([{ cell: P(30, 28), goal: P(40, 28), passClass: 'forklift' }], [P(31, 28)]);
    input.yields = [0, P(31, 28)];
    const out = plan(new CentralController(), input);
    expect(out.moveTo[0]).toBeGreaterThanOrEqual(0); // it does make way...
    expect(world.code[out.moveTo[0]]).not.toBe(2); // ...but never onto the pack lane
  });

  it('plans a bounded detour around a standing person after waitTicks blocked ticks, and reports it', () => {
    const c = new CentralController();
    const robots: R[] = [{ cell: P(4, 10), goal: P(4, 20), heading: S }];
    for (let b = 0; b <= 5; b++) {
      robots[0].blocked = b;
      const { input } = scene(robots, [P(4, 11)], {}, 100 + b);
      const out = plan(c, input);
      if (b < 5) expect(out.events).toEqual([]);
      else {
        expect(out.events).toHaveLength(1);
        expect(out.events[0].t).toBe('detour');
        expect(out.moveTo[0]).toBe(P(5, 10)); // into the other lane
      }
    }
    expect(c.counters.detours).toBe(1);
    expect(c.stateWords().length).toBeGreaterThan(7 + 8); // the detour path is part of the state
  });

  it('a robot parked at its goal (ready, goal = cell) decides last and is pushed aside once the robot behind has waited', () => {
    // Track A marks parked robots ready with goal = their cell. Whatever the priority order: a robot that has just
    // been blocked waits (or goes round); one blocked 2 x waitTicks pushes the parked robot aside.
    for (const order of [[0, 1], [1, 0]]) {
      for (const [blocked, pushed] of [[0, false], [9, false], [10, true]] as const) {
        const robots: R[] = [
          { cell: P(21, 4), goal: P(21, 4) },
          { cell: P(20, 4), goal: P(25, 4), blocked },
        ];
        const { input } = scene(robots, [P(20, 3), P(20, 5), P(19, 4)], { order });
        input.ready[0] = input.tick; // parked but pushable
        const c = new CentralController();
        const out = plan(c, input);
        const tag = `order ${order} blocked ${blocked}`;
        expect(out.moveTo[0] >= 0, tag).toBe(pushed); // the parked robot steps aside...
        expect(out.moveTo[1], tag).toBe(-1); // ...and the mover waits for the cell to clear
        expect(out.want[1], tag).toBe(P(21, 4));
        expect(c.counters.pushes, tag).toBe(pushed ? 1 : 0);
      }
    }
    // unpushed, a parked robot stays put
    const alone = scene([{ cell: P(21, 4), goal: P(21, 4) }]);
    alone.input.ready[0] = alone.input.tick;
    expect(plan(new CentralController(), alone.input).moveTo[0]).toBe(-1);
  });

  it('a parked robot on the cell that is the pusher’s own goal: left alone for 6 x waitTicks, then pushed aside', () => {
    for (const [blocked, pushed] of [[0, false], [29, false], [30, true]] as const) {
      const { input } = scene([
        { cell: P(21, 4), goal: P(21, 4) },
        { cell: P(20, 4), goal: P(21, 4), blocked },
      ]);
      input.ready[0] = input.tick;
      const out = plan(new CentralController(), input);
      expect(out.moveTo[0] >= 0, `blocked ${blocked}`).toBe(pushed);
      expect([out.moveTo[1], out.want[1]]).toEqual([-1, P(21, 4)]);
    }
  });

  it('a push chain carries the longest wait: a person’s yield moves parked C through parked D', () => {
    // person above C asks it to make way; C is parked and boxed in except for parked D's cell, which leads on to free
    const person = P(20, 3);
    const { input } = scene([
      { cell: P(20, 4), goal: P(20, 4) },
      { cell: P(21, 4), goal: P(21, 4) },
    ], [person, P(19, 4), P(20, 5), P(21, 3), P(21, 5)]);
    input.ready[0] = input.tick;
    input.ready[1] = input.tick;
    input.yields = [0, person];
    const out = plan(new CentralController(), input);
    expect(out.moveTo[1]).toBe(P(22, 4)); // D steps on
    expect(out.moveTo[0]).toBe(-1); // C waits for D's cell to clear (causal)
    expect(out.want[0]).toBe(P(21, 4));
  });

  it('a moving robot reports the cell it moves into as want (also when it can’t take its first choice)', () => {
    const { input } = scene([{ cell: P(20, 4), goal: P(25, 5) }], [P(21, 4)]);
    const out = plan(new CentralController(), input);
    expect(out.moveTo[0]).toBe(P(20, 5));
    expect(out.want[0]).toBe(out.moveTo[0]);
  });

  it('detour searches are skipped when nothing is in sight, or when they would repeat the current detour', () => {
    const c = new CentralController();
    const people = [P(4, 11)];
    // blocked 5 ticks behind a standing person: one search, one detour
    plan(c, scene([{ cell: P(4, 10), goal: P(4, 20), heading: S, blocked: 5 }], people, {}, 100).input);
    expect([c.counters.detours, c.counters.detourSkips]).toEqual([1, 0]);
    // still there 5 ticks later, same blocker, detour still active: kept, not searched again
    plan(c, scene([{ cell: P(4, 10), goal: P(4, 20), heading: S, blocked: 10 }], people, {}, 105).input);
    expect([c.counters.detours, c.counters.detourSkips]).toEqual([1, 1]);
    // a different blocker: searched again
    plan(c, scene([{ cell: P(4, 10), goal: P(4, 20), heading: S, blocked: 15 }], [P(5, 11), P(4, 11)], {}, 110).input); // another person in front
    expect(c.counters.detours + c.counters.detourFails).toBe(2); // searched (with both lanes blocked it finds no way)
    expect(c.counters.detourSkips).toBe(1);
    // blocked by a moving robot with no person or parked robot within sensor range: no search at all
    const d = new CentralController();
    plan(d, scene([{ cell: P(30, 4), goal: P(40, 4), blocked: 5 }, { cell: P(31, 4), goal: P(50, 4), movingTo: P(32, 4) }]).input);
    expect([d.counters.detours, d.counters.detourFails, d.counters.detourSkips]).toEqual([0, 0, 1]);
    // the skip state is part of stateWords
    expect(c.stateWords()).toContain(P(4, 10));
  });

  it('no detour when the blocker is a robot it can push', () => {
    const c = new CentralController();
    // the robot ahead is ready and lower priority, its own way blocked by nothing: PIBT handles it
    const { input } = scene([{ cell: P(4, 10), goal: P(4, 20), heading: S, blocked: 5 }, { cell: P(4, 11), goal: P(4, 12), heading: S }]);
    plan(c, input);
    expect(c.counters.detours).toBe(0);
  });
});

describe('CentralController: recover()', () => {
  it('no resets until 5 minutes without progress; then one, to a free non-pocket cell at least 2 steps away', () => {
    const c = new CentralController();
    const people = [P(21, 4), P(20, 3), P(20, 5), P(19, 4)];
    const at = (since: number, tick: number) => c.recover(scene([{ cell: P(20, 4), goal: P(40, 4), sinceProgress: since }], people, {}, tick).input);
    expect(at(599, 1000)).toEqual({ resets: [], retasks: [] });
    const r = at(600, 1001);
    expect(r.retasks).toEqual([]);
    expect(r.resets).toHaveLength(1);
    const cell = r.resets[0].cell;
    const dx = Math.abs((cell % 62) - 20);
    const dy = Math.abs(Math.floor(cell / 62) - 4);
    expect(dx + dy).toBeGreaterThanOrEqual(2);
    expect(people).not.toContain(cell);
    expect(world.isPocket[cell]).toBe(0);
    // at most one reset per 5 minutes, even if the sim's counter lagged
    expect(at(601, 1002).resets).toEqual([]);
    expect(at(1200, 1601).resets).toHaveLength(1);
  });

  it('returns the same frozen empty result when there is nothing to do (no per-tick allocation)', () => {
    const c = new CentralController();
    const a = c.recover(scene([{ cell: P(20, 4), goal: P(40, 4) }]).input);
    const b = c.recover(scene([{ cell: P(20, 4), goal: P(40, 4) }], [], {}, 101).input);
    expect(a).toBe(b);
    expect(Object.isFrozen(a) && Object.isFrozen(a.resets) && Object.isFrozen(a.retasks)).toBe(true);
  });

  it('never resets a robot parked at its goal, even when its counter is old', () => {
    const c = new CentralController();
    const { input } = scene([{ cell: P(20, 4), goal: P(20, 4), sinceProgress: 5000 }]);
    input.ready[0] = input.tick;
    expect(c.recover(input).resets).toEqual([]);
  });

  it('never resets a robot that is moving, dwelling or idle; never re-tasks', () => {
    const c = new CentralController();
    const { input } = scene([
      { cell: P(20, 4), goal: P(40, 4), sinceProgress: 5000, movingTo: P(21, 4) },
      { cell: P(30, 4), goal: P(30, 4), sinceProgress: 5000 },
      { cell: P(30, 10), goal: -1, sinceProgress: 5000 },
    ]);
    expect(c.recover(input)).toEqual({ resets: [], retasks: [] });
  });

  it('two robots reset in the same tick get different cells', () => {
    const c = new CentralController();
    const { input } = scene([
      { cell: P(20, 4), goal: P(40, 4), sinceProgress: 700 },
      { cell: P(21, 4), goal: P(40, 4), sinceProgress: 700 },
    ]);
    const r = c.recover(input);
    expect(r.resets).toHaveLength(2);
    expect(r.resets[0].cell).not.toBe(r.resets[1].cell);
  });
});

describe('CentralController: state', () => {
  it('stateWords are integers and only cover robots it has seen', () => {
    const c = new CentralController();
    expect(c.stateWords()).toEqual([0, 0, 0, 0, 0, 0, 0]);
    plan(c, scene([{ cell: P(20, 4), goal: P(25, 4) }]).input);
    const w = c.stateWords();
    expect(w.every((x) => Number.isSafeInteger(x))).toBe(true);
    expect(w.slice(7, 9)).toEqual([0, P(25, 4)]); // robot 0 and the goal it saw
  });

  it('a layout switch (new world) drops every robot’s cell-based state', () => {
    const c = new CentralController();
    plan(c, scene([{ cell: P(4, 10), goal: P(4, 20), heading: S, blocked: 5 }], [P(4, 11)]).input);
    expect(c.stateWords().length).toBeGreaterThan(7);
    const small = buildWorld(smallLayout as LayoutFile);
    const input: TrafficInput = { tick: 200, world: small, dist: new DistanceCache(small), agents: [null], order: [], ready: new Int32Array(1).fill(-1), occ: new Int32Array(small.n).fill(-1), yields: [] };
    c.plan(input, createPlan(1));
    expect(c.stateWords().slice(7)).toEqual([]);
  });

  it('the same inputs give the same outputs and state', () => {
    const robots: R[] = [
      { cell: P(4, 10), goal: P(4, 20), heading: S, blocked: 5 },
      { cell: P(20, 4), goal: P(25, 4) },
      { cell: P(21, 4), goal: P(10, 4), heading: W },
      { cell: P(10, 4), goal: P(5, 4), passClass: 'forklift', heading: W },
    ];
    const run = () => {
      const c = new CentralController();
      const s = scene(robots, [P(4, 11), P(8, 4)]);
      s.input.yields = [0, P(4, 11)];
      const out = plan(c, s.input);
      return JSON.stringify([out, c.stateWords()], (_, v) => (ArrayBuffer.isView(v) ? Array.from(v as Int32Array) : v));
    };
    expect(run()).toBe(run());
  });
});
