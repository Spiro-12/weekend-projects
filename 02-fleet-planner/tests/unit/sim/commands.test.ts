// Live commands (the brief §10): setFleet up and down mid-run, setOrderRate from the next tick, setTraffic through the
// factory, inject; all in the command log with their tick.
import { describe, expect, it } from 'vitest';
import type { TrafficMode } from '../../../src/contracts/types.ts';
import { NaiveController } from '../../../src/sim/traffic/naive.ts';
import { count, makeSim, run, scenario } from './helpers/data.ts';
import { TestPibtController } from './helpers/test-controller.ts';

describe('setFleet', () => {
  it('adds agents at once (parking or charger pockets first) and removes them after their task', () => {
    const sim = makeSim(scenario(), { pibt: true, checks: true });
    run(sim, 1000);
    const before = new Set(sim.snapshot().agents.map((a) => a.id));
    sim.command({ t: 'setFleet', type: 'amr', count: 34 });
    sim.step(1);
    const snap = sim.snapshot();
    expect(snap.agents.filter((a) => a.type === 'amr').length).toBe(34);
    expect(sim.stats().fleet.amr).toBe(34);
    const fresh = snap.agents.filter((a) => !before.has(a.id));
    expect(fresh.length).toBe(10);
    const pockets = new Set([...sim.world.parking, ...sim.world.chargers].map((p) => p.cell));
    expect(fresh.filter((a) => pockets.has(a.cell)).length).toBeGreaterThan(0);
    // vendors keep the 60/40 split (largest remainder): 34 → A 20, D 14
    expect(snap.agents.filter((a) => a.type === 'amr' && a.vendor === 'A').length).toBe(20);

    sim.command({ t: 'setFleet', type: 'amr', count: 10 });
    const ev = run(sim, 2 * 7200);
    expect(sim.stats().fleet.amr).toBe(10);
    // nobody left mid-task: every open pick task still has its carrier, and the orders kept shipping
    const ids = new Set(sim.snapshot().agents.map((a) => a.id));
    for (const t of sim.snapshot().tasks) for (const id of t.agentIds) expect(ids.has(id)).toBe(true);
    expect(count(ev, 'orderShipped')).toBeGreaterThan(300);
    expect(sim.debug().violations.overlap + sim.debug().violations.occMismatch).toBe(0);
  });

  it('setFleet with a vendor only changes that vendor', () => {
    const sim = makeSim(scenario(), {});
    sim.command({ t: 'setFleet', type: 'amr', count: 5, vendor: 'D' });
    run(sim, 3 * 7200);
    const amrs = sim.snapshot().agents.filter((a) => a.type === 'amr');
    expect(amrs.filter((a) => a.vendor === 'A').length).toBe(14);
    expect(amrs.filter((a) => a.vendor === 'D').length).toBe(5);
  });

  it('down and back up again: agents on their way out are kept first', () => {
    const sim = makeSim(scenario(), { pibt: true });
    run(sim, 600);
    sim.command({ t: 'setFleet', type: 'picker', count: 6 });
    sim.step(1);
    sim.command({ t: 'setFleet', type: 'picker', count: 14 });
    sim.step(1);
    const pickers = sim.agents.filter((a) => a.typeId === 'picker');
    expect(pickers.length).toBe(14);
    expect(pickers.every((a) => !a.removing)).toBe(true);
    // idle pickers leave in the tick they are told to; the others were still leaving and are simply kept
    const fresh = pickers.filter((a) => a.id >= 46).length;
    const kept = pickers.filter((a) => a.id < 46).length;
    expect(kept + fresh).toBe(14);
    expect(kept).toBeGreaterThanOrEqual(6);
  });

  it('people only and back: the work model switches between manual carts and cart robots', () => {
    const sim = makeSim(scenario(), { pibt: true });
    run(sim, 600);
    expect(sim.debug().zoneMode).toBe(true);
    sim.command({ t: 'setFleet', type: 'amr', count: 0 });
    sim.command({ t: 'setFleet', type: 'humanoid', count: 0 });
    sim.command({ t: 'setFleet', type: 'forklift', count: 0 });
    let ev = run(sim, 7200);
    expect(sim.stats().fleet.amr).toBe(0);
    expect(sim.debug().zoneMode).toBe(false);
    expect(ev.filter((e) => e.t === 'toteDelivered' && sim.snapshot().agents.find((a) => a.id === e.agent)?.type === 'picker').length).toBeGreaterThan(10);
    sim.command({ t: 'setFleet', type: 'amr', count: 24 });
    ev = run(sim, 7200);
    expect(sim.debug().zoneMode).toBe(true);
    expect(count(ev, 'orderShipped')).toBeGreaterThan(150);
  });
});

describe('setOrderRate', () => {
  it('changes arrivals from the next tick', () => {
    const sim = makeSim(scenario(), {});
    sim.step(100);
    sim.drainEvents();
    sim.command({ t: 'setOrderRate', perHour: 28_800 }); // every draw hits: 4 orders per tick
    sim.step(5);
    const ev = sim.drainEvents().filter((e) => e.t === 'orderArrived');
    expect(ev.length).toBe(20);
    expect(ev.filter((e) => e.tick === 100).length).toBe(4);
    sim.command({ t: 'setOrderRate', perHour: 0 });
    run(sim, 1000);
    const after = sim.drainEvents();
    expect(count(after, 'orderArrived')).toBe(0);
  });

  it('rate changes never shift the arrival stream: the same draws decide later ticks', () => {
    const a = makeSim(scenario({ orders: { perHour: 600 } }), {});
    const b = makeSim(scenario({ orders: { perHour: 600 } }), {});
    b.command({ t: 'setOrderRate', perHour: 0 });
    b.step(50);
    b.command({ t: 'setOrderRate', perHour: 600 });
    a.step(50);
    a.drainEvents();
    b.drainEvents();
    a.step(500);
    b.step(500);
    const ticks = (ev: ReturnType<typeof a.drainEvents>) => ev.filter((e) => e.t === 'orderArrived').map((e) => e.tick);
    expect(ticks(b.drainEvents())).toEqual(ticks(a.drainEvents()));
  });
});

describe('setTraffic and the command log', () => {
  it('swaps the controller through the factory', () => {
    const made: TrafficMode[] = [];
    const sim = makeSim(scenario(), {
      traffic: (m) => {
        made.push(m);
        return m === 'central' ? new NaiveController(m) : new TestPibtController(m);
      },
    });
    sim.step(10);
    sim.command({ t: 'setTraffic', mode: 'siloed' });
    sim.step(10);
    expect(made).toEqual(['central', 'siloed']);
  });

  it('logs every command with the tick it was applied', () => {
    const sim = makeSim(scenario(), {});
    sim.step(5);
    sim.command({ t: 'setOrderRate', perHour: 100 });
    sim.command({ t: 'setFleet', type: 'driver', count: 3 });
    sim.step(7);
    sim.command({ t: 'inject', event: { type: 'personInAisle', atMin: 0, cell: [10, 10], forMin: 1 } });
    sim.step(1);
    expect(sim.commandLog()).toEqual([
      { tick: 5, c: { t: 'setOrderRate', perHour: 100 } },
      { tick: 5, c: { t: 'setFleet', type: 'driver', count: 3 } },
      { tick: 12, c: { t: 'inject', event: { type: 'personInAisle', atMin: 0, cell: [10, 10], forMin: 1 } } },
    ]);
    // Phase 2 event types are accepted and ignored: no event, no throw
    expect(count(sim.drainEvents(), 'personInAisle')).toBe(0);
  });
});
