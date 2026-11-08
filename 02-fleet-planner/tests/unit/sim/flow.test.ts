// Order flow: every arrived order ships exactly once; Little's law holds within ±10% over a 2 h window at a demand the
// fleet can handle. People only: orders still flow on manual carts and robots never appear.
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../../src/contracts/types.ts';
import { TOTES_PER_AMR } from '../../../src/sim/core/index.ts';
import { count, makeSim, run, scenario } from './helpers/data.ts';

describe('order flow (test PIBT controller, 250 orders/h)', () => {
  const sim = makeSim(scenario({ orders: { mode: 'demand', perHour: 250 } }), { pibt: true });
  const events: SimEvent[] = [];
  // Little's law window: 30 min warm-up, then 2 h sampled every tick
  run(sim, 30 * 120, events);
  let openSum = 0;
  const w0 = sim.tick;
  for (let k = 0; k < 2 * 7200; k++) {
    sim.step(1);
    openSum += sim.stats().openOrders;
    for (const e of sim.drainEvents()) events.push(e);
  }
  const w1 = sim.tick;
  // then stop arrivals and drain
  sim.command({ t: 'setOrderRate', perHour: 0 });
  for (let k = 0; k < 12 && sim.stats().openOrders > 0; k++) run(sim, 600, events);

  it('every arrived order ships exactly once, with its arrival tick', () => {
    const arrived = new Map<number, number>();
    for (const e of events) if (e.t === 'orderArrived') arrived.set(e.order, e.tick);
    const shipped = events.filter((e): e is Extract<SimEvent, { t: 'orderShipped' }> => e.t === 'orderShipped');
    expect(arrived.size).toBeGreaterThan(500);
    expect(new Set(shipped.map((e) => e.order)).size).toBe(shipped.length);
    expect(shipped.length).toBe(arrived.size);
    for (const e of shipped) expect(e.arrivedTick).toBe(arrived.get(e.order));
    expect(sim.stats().openOrders).toBe(0);
    expect(sim.stats().shippedOrders).toBe(arrived.size);
  });

  it('every order is packed once before it ships, 60 ticks earlier (the conveyor)', () => {
    const packed = new Map<number, number>();
    for (const e of events) if (e.t === 'orderPacked') {
      expect(packed.has(e.order)).toBe(false);
      packed.set(e.order, e.tick);
    }
    for (const e of events) if (e.t === 'orderShipped') expect(e.tick - packed.get(e.order)!).toBe(60);
  });

  it("Little's law: mean open orders = throughput × mean time in system, within 10%", () => {
    const hours = (w1 - w0) / 7200;
    const shippedIn = events.filter((e) => e.t === 'orderShipped' && e.tick >= w0 && e.tick < w1) as Extract<SimEvent, { t: 'orderShipped' }>[];
    const L = openSum / (w1 - w0);
    const lambda = shippedIn.length / (w1 - w0); // per tick
    const W = shippedIn.reduce((s, e) => s + (e.tick - e.arrivedTick), 0) / shippedIn.length;
    expect(shippedIn.length / hours).toBeGreaterThan(200);
    expect(Math.abs(L - lambda * W) / L).toBeLessThan(0.1);
  });

  it('units picked = lines of the orders (one unit per line), counted per picking type', () => {
    const lines = events.filter((e) => e.t === 'orderArrived').reduce((s, e) => s + (e as Extract<SimEvent, { t: 'orderArrived' }>).lines, 0);
    const units = events.filter((e) => e.t === 'pickDone').reduce((s, e) => s + (e as Extract<SimEvent, { t: 'pickDone' }>).units, 0);
    const st = sim.stats();
    expect(units).toBe(lines); // no breakdowns here, so nothing is picked twice
    expect((st.unitsPicked.picker ?? 0) + (st.unitsPicked.humanoid ?? 0)).toBe(units);
    expect(st.unitsPicked.picker).toBeGreaterThan(0);
  });
});

describe('people only (all robot counts 0)', () => {
  const s = scenario({ fleet: { amr: 0, forklift: 0, humanoid: 0 }, orders: { mode: 'demand', perHour: 300 } });
  const sim = makeSim(s, { pibt: true });
  let robotsSeen = 0;
  const events: SimEvent[] = [];
  for (let k = 0; k < 2 * 12; k++) {
    run(sim, 600, events);
    robotsSeen += sim.snapshot().agents.filter((a) => a.type === 'amr' || a.type === 'forklift' || a.type === 'humanoid').length;
  }

  it('orders flow on manual carts', () => {
    expect(count(events, 'orderShipped')).toBeGreaterThan(450);
    expect(sim.debug().zoneMode).toBe(false);
    const carts = sim.snapshot().agents.filter((a) => a.type === 'picker' && a.cargo === 'cart').length;
    expect(carts).toBeGreaterThan(0);
  });
  it('pickers deliver totes to pack stations themselves', () => {
    const deliverers = new Set(events.filter((e) => e.t === 'toteDelivered').map((e) => (e as Extract<SimEvent, { t: 'toteDelivered' }>).agent));
    const pickers = new Set(sim.snapshot().agents.filter((a) => a.type === 'picker').map((a) => a.id));
    expect(deliverers.size).toBeGreaterThan(5);
    for (const id of deliverers) expect(pickers.has(id)).toBe(true);
  });
  it('robots never appear', () => {
    expect(robotsSeen).toBe(0);
    const st = sim.stats();
    for (const t of ['amr', 'forklift', 'humanoid'] as const) {
      expect(st.fleet[t]).toBe(0);
      expect(Object.values(st.ticksByState[t]).reduce((a, b) => a + b, 0)).toBe(0);
    }
    expect(count(events, 'chargeStart')).toBe(0);
  });
});

describe('cart-robot model (the Locus model)', () => {
  const sim = makeSim(scenario({ orders: { mode: 'saturate' } }), { pibt: true });
  const events = run(sim, 7200);
  it('pickers stay in their zones and meet cart robots; only cart robots visit pack stations', () => {
    const byId = new Map(sim.snapshot().agents.map((a) => [a.id, a]));
    const deliverers = new Set(events.filter((e) => e.t === 'toteDelivered').map((e) => (e as Extract<SimEvent, { t: 'toteDelivered' }>).agent));
    expect(deliverers.size).toBeGreaterThan(10);
    for (const id of deliverers) expect(byId.get(id)?.type).toBe('amr');
    const pickers = new Set(events.filter((e) => e.t === 'pickDone').map((e) => byId.get((e as Extract<SimEvent, { t: 'pickDone' }>).agent)?.type));
    expect([...pickers].sort()).toEqual(['humanoid', 'picker']);
    expect(sim.debug().zoneMode).toBe(true);
  });
  it('an order is never split: all its lines ride in one cart robot', () => {
    const tasks = sim.snapshot().tasks.filter((t) => t.kind === 'pick');
    const seen = new Set<number>();
    for (const t of tasks) {
      expect(t.orderIds.length).toBeLessThanOrEqual(TOTES_PER_AMR);
      for (const o of t.orderIds) {
        expect(seen.has(o)).toBe(false);
        seen.add(o);
      }
    }
  });
});
