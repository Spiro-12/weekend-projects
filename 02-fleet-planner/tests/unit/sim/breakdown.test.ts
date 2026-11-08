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
  it('a zone picker breaks: its zone is re-split among the others, and it comes back', () => {
    const sim = makeSim(scenario({ orders: { mode: 'saturate' } }), { pibt: true });
    run(sim, 1200);
    const id = sim.agentRef('picker', 1);
    const members = () => sim.debug().zones!.members.flat();
    expect(members()).toContain(id);
    sim.command({ t: 'inject', event: { type: 'breakdown', atMin: 0, agent: 'picker:1', forMin: 2 } });
    const ev = run(sim, 2, [], 1);
    run(sim, 10);
    expect(ev.some((e) => e.t === 'breakdown' && e.agent === id) || sim.snapshot().agents.find((a) => a.id === id)!.state === 'broken').toBe(true);
    expect(members()).not.toContain(id);
    const rest = run(sim, 2 * 120 + 20);
    expect(rest.some((e) => e.t === 'repair' && e.agent === id)).toBe(true);
    expect(members()).toContain(id);
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
