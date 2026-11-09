// Outputs: snapshot() (every AgentView field, routes, tasks, stats, chargers, deadlocks, heat) and stats() (cheap
// counters for Track C's KPI recorder: fresh objects, units per picking type, current fleet).
import { describe, expect, it } from 'vitest';
import { AGENT_STATES, AGENT_TYPES } from '../../../src/contracts/types.ts';
import { makeSim, run, scenario } from './helpers/data.ts';

describe('snapshot', () => {
  const sim = makeSim(scenario(), { pibt: true });
  run(sim, 3600);
  const snap = sim.snapshot();
  const w = sim.world;

  it('is plain, structured-clone-safe data', () => {
    expect(structuredClone(snap)).toEqual(snap);
    expect(snap.tick).toBe(3600);
    expect([snap.width, snap.height]).toEqual([w.width, w.height]);
    expect(snap.heat.length).toBe(w.n);
    expect(snap.chargers.length).toBe(w.chargers.length);
  });

  it('has every AgentView field with sane values', () => {
    expect(snap.agents.length).toBe(46);
    for (const a of snap.agents) {
      expect(Object.keys(a).sort()).toEqual(
        ['batteryPct', 'blockedTicks', 'cargo', 'cell', 'goal', 'heading', 'id', 'model', 'moveEnd', 'moveStart', 'name', 'route', 'state', 'taskId', 'to', 'type', 'vendor', 'waitOn'].sort(),
      );
      expect(AGENT_TYPES).toContain(a.type);
      expect(AGENT_STATES).toContain(a.state);
      expect(['none', 'tote', 'pallet', 'cart']).toContain(a.cargo);
      expect(a.heading).toBeGreaterThanOrEqual(0);
      expect(a.heading).toBeLessThanOrEqual(3);
      expect(a.batteryPct).toBeGreaterThanOrEqual(0);
      expect(a.batteryPct).toBeLessThanOrEqual(100);
      if (a.type === 'picker' || a.type === 'driver') expect(a.batteryPct).toBe(100);
      if (a.to >= 0) expect(a.moveEnd).toBeGreaterThan(a.moveStart);
      expect(a.route.length).toBeLessThanOrEqual(12);
      // route: consecutive 4-neighbours starting next to where the agent is (or is going)
      let prev = a.to >= 0 ? a.to : a.cell;
      for (const c of a.route) {
        expect([0, 1, 2, 3].some((d) => w.nbr[prev * 4 + d] === c)).toBe(true);
        prev = c;
      }
      if (a.goal < 0) expect(a.route).toEqual([]);
      expect(a.model).toBe(sim.snapshot().agents.find((x) => x.id === a.id)!.model);
    }
    expect(snap.agents.some((a) => a.route.length > 0)).toBe(true);
    expect(snap.agents.filter((a) => a.type === 'amr').every((a) => a.name.startsWith('AMR-A') || a.name.startsWith('AMR-D'))).toBe(true);
  });

  it('tasks: open tasks with their orders, stage and agents', () => {
    expect(snap.tasks.length).toBeGreaterThan(5);
    const ids = new Set(snap.agents.map((a) => a.id));
    for (const t of snap.tasks) {
      expect(typeof t.stage).toBe('string');
      expect(t.stage.length).toBeGreaterThan(0);
      for (const id of t.agentIds) expect(ids.has(id)).toBe(true);
      if (t.kind === 'pick') {
        expect(t.orderIds.length).toBeGreaterThan(0);
        expect(t.lines).toBeGreaterThanOrEqual(t.orderIds.length);
      }
    }
    for (const a of snap.agents) if (a.taskId >= 0) expect(snap.tasks.some((t) => t.id === a.taskId)).toBe(true);
  });

  it('stats.ticksByState counts every agent once per tick', () => {
    let total = 0;
    for (const t of AGENT_TYPES) for (const s of AGENT_STATES) total += snap.stats.ticksByState[t][s];
    expect(total).toBe(46 * 3600);
  });

  it('chargers report who holds them; deadlocks are listed', () => {
    const holders = snap.chargers.map((c) => c.agentId).filter((x) => x >= 0);
    expect(new Set(holders).size).toBe(holders.length);
    expect(Array.isArray(snap.deadlocks)).toBe(true);
  });

  it('waitOn points at a real agent when set', () => {
    const ids = new Set(snap.agents.map((a) => a.id));
    for (const a of snap.agents) if (a.waitOn >= 0) expect(ids.has(a.waitOn)).toBe(true);
  });
});

describe('stats()', () => {
  it('returns fresh objects: unitsPicked per picking type, fleet = agents present now', () => {
    const sim = makeSim(scenario(), { pibt: true });
    run(sim, 1800);
    const a = sim.stats();
    const copy = structuredClone(a);
    run(sim, 1800);
    const b = sim.stats();
    expect(a).toEqual(copy); // the first result was not mutated by later steps
    expect(b.tick).toBe(3600);
    expect(Object.keys(b.unitsPicked).sort()).toEqual(['humanoid', 'picker']);
    expect(b.unitsPicked.picker!).toBeGreaterThan(a.unitsPicked.picker!);
    expect(b.fleet).toEqual({ amr: 24, forklift: 4, humanoid: 2, picker: 14, driver: 2 });
    expect(b.openOrders).toBe(sim.snapshot().openOrders);
    expect(b.shippedOrders).toBe(sim.snapshot().shippedOrders);
    sim.command({ t: 'setFleet', type: 'picker', count: 16 });
    sim.step(1);
    expect(sim.stats().fleet.picker).toBe(16);
  });
});
