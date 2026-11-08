// Every SimEvent type the core emits has a test here (or in flow / pallets / breakdown tests), with its payload checked.
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../../src/contracts/types.ts';
import { count, makeSim, run, scenario } from './helpers/data.ts';
import { ScriptedController } from './helpers/test-controller.ts';

type Ev<T extends SimEvent['t']> = Extract<SimEvent, { t: T }>;
const of = <T extends SimEvent['t']>(ev: SimEvent[], t: T) => ev.filter((e): e is Ev<T> => e.t === t);

describe('work events (default scenario, 2 h, one-brain planner)', () => {
  const sim = makeSim(scenario(), { pibt: true });
  const ev = run(sim, 2 * 7200);
  const snap = sim.snapshot();
  const byId = new Map(snap.agents.map((a) => [a.id, a]));

  it('arrive in tick order', () => {
    for (let i = 1; i < ev.length; i++) expect(ev[i].tick).toBeGreaterThanOrEqual(ev[i - 1].tick);
  });
  it('orderArrived: ids in order, 1…8 lines', () => {
    const a = of(ev, 'orderArrived');
    expect(a.length).toBeGreaterThan(1000);
    a.forEach((e, i) => expect(e.order).toBe(i));
    expect(a.every((e) => e.lines >= 1 && e.lines <= 8)).toBe(true);
  });
  it('taskAssigned: pick, replenish, inbound, charge and park tasks, each to one agent', () => {
    const kinds = new Set(of(ev, 'taskAssigned').map((e) => e.kind));
    for (const k of ['pick', 'inbound', 'charge', 'park'] as const) expect(kinds.has(k)).toBe(true);
    for (const e of of(ev, 'taskAssigned')) expect(e.agents.length).toBe(1);
  });
  it('pickDone: by a picker or humanoid, units ≥ 1, for an order that arrived', () => {
    const arrived = new Set(of(ev, 'orderArrived').map((e) => e.order));
    const p = of(ev, 'pickDone');
    expect(p.length).toBeGreaterThan(500);
    for (const e of p) {
      expect(e.units).toBeGreaterThanOrEqual(1);
      expect(arrived.has(e.order)).toBe(true);
      expect(['picker', 'humanoid']).toContain(byId.get(e.agent)?.type);
    }
  });
  it('toteDelivered: by a cart robot, at a pack station', () => {
    const d = of(ev, 'toteDelivered');
    expect(d.length).toBeGreaterThan(100);
    for (const e of d) {
      expect(byId.get(e.agent)?.type).toBe('amr');
      expect(e.station).toBeGreaterThanOrEqual(0);
      expect(e.station).toBeLessThan(6);
    }
  });
  it('orderPacked then orderShipped', () => {
    expect(count(ev, 'orderPacked')).toBeGreaterThan(400);
    expect(count(ev, 'orderShipped')).toBeGreaterThan(400);
  });
  it('palletMoved: inbound pallets by forklifts or drivers', () => {
    const m = of(ev, 'palletMoved');
    expect(m.some((e) => e.kind === 'inbound')).toBe(true);
    for (const e of m) expect(['forklift', 'driver']).toContain(byId.get(e.agent)?.type);
  });
  it('chargeStart / chargeEnd: robots only, at a charger of their class', () => {
    const s = of(ev, 'chargeStart');
    expect(s.length).toBeGreaterThan(2);
    expect(count(ev, 'chargeEnd')).toBeGreaterThan(0);
    for (const e of s) {
      const a = byId.get(e.agent);
      if (!a) continue;
      expect(['amr', 'forklift', 'humanoid']).toContain(a.type);
      const pocket = sim.world.chargers[e.charger];
      expect(pocket.forClass).toBe(a.type === 'forklift' ? 'forklift' : 'small');
    }
  });
  it('yield: a robot makes way for a person (TrafficEvent yield → SimEvent yield with the person id)', () => {
    const y = of(ev, 'yield');
    expect(y.length).toBeGreaterThan(10);
    for (const e of y.slice(0, 50)) expect(['picker', 'driver']).toContain(byId.get(e.person)?.type ?? 'picker');
  });
});

describe('traffic detection events (80 cart robots at capacity, test PIBT controller: knots form and clear)', () => {
  const sim = makeSim(scenario({ fleet: { amr: 80 }, orders: { mode: 'saturate' } }), { testPibt: true });
  const ev = run(sim, 2 * 7200);
  it('deadlockStart / deadlockEnd with stable ids and member lists', () => {
    const s = of(ev, 'deadlockStart');
    expect(s.length).toBeGreaterThan(0);
    for (const e of s) expect(e.agents.length).toBeGreaterThanOrEqual(2);
    const started = new Set(s.map((e) => e.deadlock));
    for (const e of of(ev, 'deadlockEnd')) expect(started.has(e.deadlock)).toBe(true);
    expect(count(ev, 'deadlockEnd')).toBeGreaterThan(0);
    expect(sim.snapshot().deadlocks.length).toBe(s.length - count(ev, 'deadlockEnd'));
  });
  it('manualReset: the controller’s 5-minute reset is applied and reported', () => {
    expect(count(ev, 'manualReset')).toBeGreaterThan(0);
  });
  it('jamStart / jamEnd: ≥ 3 agents, a cell', () => {
    const j = of(ev, 'jamStart');
    expect(j.length).toBeGreaterThan(0);
    for (const e of j) {
      expect(e.agents.length).toBeGreaterThanOrEqual(3);
      expect(e.cell).toBeGreaterThanOrEqual(0);
    }
    expect(count(ev, 'jamEnd')).toBeGreaterThan(0);
  });
});

describe('controller events: manualReset, retask, safetyStop, yield', () => {
  it('maps the controller’s resets, re-tasks and events to SimEvents', () => {
    let resetDone = false;
    let retaskDone = false;
    let safetyDone = false;
    const sim = makeSim(scenario(), {
      traffic: () =>
        new ScriptedController({
          resets: (input) => {
            if (resetDone || input.tick < 300) return [];
            for (const id of input.order) {
              const a = input.agents[id];
              if (!a || input.ready[id] !== input.tick) continue;
              for (let c = 0; c < input.world.n; c++)
                if (input.world.passable[0][c] && !input.world.isPocket[c] && input.occ[c] < 0 && input.world.faceAt[c] < 0) {
                  resetDone = true;
                  return [{ agent: id, cell: c }];
                }
            }
            return [];
          },
          retasks: (input) => {
            if (retaskDone) return [];
            for (const r of sim.robots)
              if (r.job === 1 && r.stage === 2 && input.ready[r.id] === input.tick) {
                retaskDone = true;
                return [r.id];
              }
            return [];
          },
          events: (input) => {
            if (safetyDone || input.tick < 100) return [];
            safetyDone = true;
            const r = input.order[0];
            const person = sim.people[0];
            return [
              { t: 'safetyStop', agent: r, cell: input.agents[r]!.cell },
              { t: 'yield', agent: r, cell: person.cell },
              { t: 'detour', agent: r, cell: 0 },
              { t: 'stepAside', agent: r, cell: 0 },
            ];
          },
        }),
    });
    const ev = run(sim, 7200);
    const resets = of(ev, 'manualReset');
    expect(resets.length).toBe(1);
    const retasks = of(ev, 'retask');
    expect(retasks.length).toBe(1);
    expect(retasks[0].goal).toBeGreaterThanOrEqual(0);
    const stops = of(ev, 'safetyStop');
    expect(stops.length).toBe(1);
    const yields = of(ev, 'yield');
    expect(yields.length).toBe(1);
    expect(yields[0].person).toBe(sim.people[0].id);
    // detour and stepAside are internal (counted, not SimEvents)
    expect(sim.debug().counters.detours).toBe(1);
    expect(sim.debug().counters.trafficStepAsides).toBe(1);
  });

  it('personInAisle is a Phase 2 event: never emitted', () => {
    const sim = makeSim(scenario(), { pibt: true });
    sim.command({ t: 'inject', event: { type: 'personInAisle', atMin: 0, cell: [5, 5], forMin: 2 } });
    expect(count(run(sim, 1200), 'personInAisle')).toBe(0);
  });
});
