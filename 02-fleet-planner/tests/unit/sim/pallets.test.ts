// Pallets: stock per face, replenishment, inbound, and forklift starvation (0 forklifts and 0 drivers ⇒ faces run dry
// and throughput falls; 2 drivers ⇒ it recovers).
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../../src/contracts/types.ts';
import { count, makeSim, run, scenario } from './helpers/data.ts';

// People only, so nothing but stock limits the pickers; 80% of picks on 12 faces, so hot faces drain within the hour.
const starved = (driver: number) =>
  scenario({
    fleet: { amr: 0, forklift: 0, humanoid: 0, driver },
    orders: { mode: 'demand', perHour: 200, sku: { aPct: 2, aPicksPct: 80 } },
    pallets: { linesPerReplenish: 20, inboundPerHour: 0 },
  });

const shippedIn = (ev: SimEvent[]) => count(ev, 'orderShipped');

describe('forklift starvation', () => {
  it('0 forklifts and 0 drivers: faces run dry and throughput falls; adding 2 drivers recovers it', () => {
    const sim = makeSim(starved(0), { pibt: true });
    const h1 = shippedIn(run(sim, 7200));
    run(sim, 7200);
    const h3 = shippedIn(run(sim, 7200));
    // the first hot face to run dry holds every cart that needs it, so only a few faces get to empty
    const dry = sim.debug().stock.filter((x) => x === 0).length;
    expect(dry).toBeGreaterThan(0);
    expect(sim.debug().palletTasks).toBeGreaterThan(0); // replenishments asked for, nobody to do them
    expect(h3).toBeLessThan(h1 * 0.3);
    // pickers wait at the empty faces (the rest queue behind them)
    const waiting = sim.snapshot().agents.filter((a) => a.type === 'picker' && a.state === 'wait').length;
    expect(waiting).toBeGreaterThan(0);
    sim.command({ t: 'setFleet', type: 'driver', count: 2 });
    run(sim, 3600);
    const h5 = shippedIn(run(sim, 7200));
    console.log(`[track A] starvation: ${h1} shipped in hour 1, ${h3} in hour 3 with no forklifts or drivers, ${h5} in hour 5 after 2 drivers arrive`);
    expect(h5).toBeGreaterThan(160); // back to (and above, working off the backlog) the 200/h demand
  });

  it('with 2 drivers from the start the same orders keep flowing', () => {
    const sim = makeSim(starved(2), { pibt: true });
    const ev = run(sim, 3 * 7200);
    const h3 = shippedIn(ev.filter((e) => e.tick >= 2 * 7200));
    expect(h3).toBeGreaterThan(170);
    expect(count(ev, 'palletMoved')).toBeGreaterThan(30);
  });
});

describe('replenishment and inbound', () => {
  const s = scenario({ orders: { mode: 'demand', perHour: 300, sku: { aPct: 5, aPicksPct: 80 } }, pallets: { linesPerReplenish: 20, inboundPerHour: 12 } });
  const sim = makeSim(s, { pibt: true });
  const L = 20;
  const start = sim.debug().stock;
  const ev = run(sim, 2 * 7200);
  const moved = ev.filter((e): e is Extract<SimEvent, { t: 'palletMoved' }> => e.t === 'palletMoved');

  it('every face starts with more than linesPerReplenish and at most 2 × linesPerReplenish lines', () => {
    expect(start.every((x) => x > L && x <= 2 * L)).toBe(true);
    expect(new Set(start).size).toBeGreaterThan(5); // spread, so replenishment does not come in one wave
  });
  it('stock stays within 0 … 2 × linesPerReplenish', () => {
    expect(sim.debug().stock.every((x) => x >= 0 && x <= 2 * L)).toBe(true);
  });
  it('inbound: one pallet every floor(7200 / inboundPerHour) ticks', () => {
    const created = ev.filter((e) => e.t === 'taskAssigned' && e.kind === 'inbound').length;
    // 2 h × 12/h = 24 created (one every 600 ticks from tick 600); nearly all assigned by now
    expect(created).toBeGreaterThanOrEqual(20);
    expect(created).toBeLessThanOrEqual(24);
    expect(moved.filter((e) => e.kind === 'inbound').length).toBeGreaterThanOrEqual(18);
  });
  it('replenishment pallets are moved by forklifts and drivers only', () => {
    const types = new Map(sim.snapshot().agents.map((a) => [a.id, a.type]));
    const reps = moved.filter((e) => e.kind === 'replenish');
    expect(reps.length).toBeGreaterThan(5);
    for (const e of reps) expect(['forklift', 'driver']).toContain(types.get(e.agent));
  });
  it('a pallet move visits the dock (cargo pallet) and then the face', () => {
    const snap = sim.snapshot();
    const carrying = snap.agents.filter((a) => a.cargo === 'pallet');
    for (const a of carrying) expect(['forklift', 'driver']).toContain(a.type);
    const open = snap.tasks.filter((t) => t.kind === 'replenish' || t.kind === 'inbound');
    for (const t of open) expect(t.agentIds.length).toBeLessThanOrEqual(1);
  });
});
