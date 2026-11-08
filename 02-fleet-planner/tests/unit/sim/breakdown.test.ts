// Breakdown (the brief §9): the agent is broken and holds its cell for forMin, its batch goes back to the queue and is
// re-assigned, and breakdown / repair events fire. Works from scenario events and from inject.
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../../src/contracts/types.ts';
import { FaultSchedule, parseAgentRef } from '../../../src/sim/faults/index.ts';
import { makeSim, run, scenario } from './helpers/data.ts';

describe('breakdown from a scenario event', () => {
  const s = scenario({ orders: { mode: 'saturate' }, events: [{ type: 'breakdown', atMin: 30, agent: 'amr:3', forMin: 5 }] });
  const sim = makeSim(s, { pibt: true, checks: true });
  const id = sim.agentRef('amr', 3);
  run(sim, 30 * 120 - 1);
  const before = sim.snapshot();
  const task = before.tasks.find((t) => t.kind === 'pick' && t.agentIds[0] === id);
  const events: SimEvent[] = [];
  let brokeAt = -1;
  let cell = -1;
  const cells = new Set<number>();
  const states = new Set<string>();
  for (let k = 0; k < 5 * 120 + 40; k++) {
    sim.step(1);
    const ev = sim.drainEvents();
    events.push(...ev);
    const b = ev.find((e) => e.t === 'breakdown' && e.agent === id);
    if (b) {
      brokeAt = b.tick;
      cell = sim.snapshot().agents.find((a) => a.id === id)!.cell;
    }
    if (brokeAt >= 0 && sim.tick <= brokeAt + 600) {
      const a = sim.snapshot().agents.find((x) => x.id === id)!;
      cells.add(a.cell);
      states.add(a.state);
    }
  }
  const repair = events.find((e) => e.t === 'repair' && e.agent === id);

  it('fires at atMin (or as soon as a move in progress ends)', () => {
    expect(brokeAt).toBeGreaterThanOrEqual(30 * 120);
    expect(brokeAt).toBeLessThanOrEqual(30 * 120 + 5);
  });
  it('the agent stays put, broken, for forMin; then a repair event', () => {
    expect([...cells]).toEqual([cell]);
    expect([...states]).toEqual(['broken']);
    expect(repair?.tick).toBe(brokeAt + 5 * 120);
  });
  it('its orders go back to the queue and are re-assigned to others', () => {
    expect(task).toBeDefined();
    const later = run(sim, 2 * 7200);
    const shipped = new Set(later.filter((e) => e.t === 'orderShipped').map((e) => (e as Extract<SimEvent, { t: 'orderShipped' }>).order));
    for (const o of task!.orderIds) expect(shipped.has(o)).toBe(true);
    const carriers = later.filter((e) => e.t === 'toteDelivered').map((e) => e.agent);
    expect(carriers.length).toBeGreaterThan(0);
    expect(sim.debug().violations.overlap).toBe(0);
  });
});

describe('breakdown by inject', () => {
  it('both pickers of one zone break: no rezone, and pickers from the neighbouring zones serve its robots (zone bleed)', () => {
    const sim = makeSim(scenario({ orders: { mode: 'saturate' } }), { pibt: true });
    run(sim, 1200);
    const zonesBefore = sim.debug().zones!;
    // a middle zone staffed by two people (two neighbours to bleed from)
    const z = zonesBefore.members.findIndex((m, k) => k > 0 && k < zonesBefore.members.length - 1 && m.length === 2 && m.every((id) => sim.byId[id]!.typeId === 'picker'));
    expect(z).toBeGreaterThan(0);
    const team = zonesBefore.members[z];
    for (const id of team) sim.command({ t: 'inject', event: { type: 'breakdown', atMin: 0, agent: `picker:${sim.byId[id]!.spawnIndex}`, forMin: 6 } });
    let bleedPicks = 0;
    const ev = [];
    for (let k = 0; k < 6 * 120 + 20; k++) {
      sim.step(1);
      ev.push(...sim.drainEvents());
      const zs = sim.debug().zones!;
      for (const w of sim.people) {
        if (w.job !== 2 || w.stage !== 2 || w.zone < 0 || team.includes(w.id)) continue; // J_SERVE, SV_PICKING
        const amr = sim.byId[w.partner]!;
        const face = (sim as unknown as { taskById: Map<number, { stops: { face: number }[]; stop: number }> }).taskById.get(amr.taskId)!;
        if (zs.faceZone[face.stops[face.stop].face] === z && zs.members.findIndex((m) => m.includes(w.id)) !== z) bleedPicks++;
      }
    }
    for (const id of team) {
      expect(ev.some((e) => e.t === 'breakdown' && e.agent === id)).toBe(true);
      expect(ev.some((e) => e.t === 'repair' && e.agent === id)).toBe(true);
    }
    expect(JSON.stringify(sim.debug().zones)).toBe(JSON.stringify(zonesBefore)); // breakdowns never rezone
    expect(bleedPicks).toBeGreaterThan(0); // ticks a neighbour spent picking into a robot at a face of the broken zone
  });

  it('bad references and Phase 2 events are ignored', () => {
    const f = new FaultSchedule();
    expect(f.add({ type: 'breakdown', atMin: 1, agent: 'amr:99', forMin: 1 }, 0)).toBe(true); // valid ref, no such agent: no-op at fire time
    expect(f.add({ type: 'breakdown', atMin: 1, agent: 'robot:1', forMin: 1 }, 0)).toBe(false);
    expect(f.add({ type: 'orderSurge', atMin: 1, factorPct: 150, forMin: 5 }, 0)).toBe(false);
    expect(parseAgentRef('forklift:2')).toEqual({ type: 'forklift', n: 2 });
    expect(parseAgentRef('forklift')).toBeNull();
    const sim = makeSim(scenario({ events: [{ type: 'breakdown', atMin: 1, agent: 'amr:99', forMin: 1 }] }), {});
    expect(run(sim, 600).filter((e) => e.t === 'breakdown')).toEqual([]);
  });

  it('due faults come out in time order, an injected one at max(now, atMin)', () => {
    const f = new FaultSchedule([{ type: 'breakdown', atMin: 10, agent: 'amr:1', forMin: 1 }]);
    f.add({ type: 'breakdown', atMin: 2, agent: 'amr:2', forMin: 1 }, 5000);
    expect(f.due(1199)).toEqual([]);
    expect(f.due(1200).map((b) => b.n)).toEqual([1]);
    expect(f.due(4999)).toEqual([]);
    expect(f.due(5000).map((b) => b.n)).toEqual([2]);
    expect(f.pending).toBe(0);
  });
});
