// Review fixes: the planner's view after a reset or re-task is fresh; units are counted once even when a batch is
// dropped and re-picked; trips to rest and to chargers are not counted as productive travel.
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../../src/contracts/types.ts';
import type { TrafficAgent, TrafficInput } from '../../../src/sim/traffic/types.ts';
import { makeSim, run, scenario } from './helpers/data.ts';
import { ScriptedController } from './helpers/test-controller.ts';

describe('planner input after recovery', () => {
  it('a reset and a re-task reach plan() with the new cell / goal and zeroed progress counters', () => {
    let resetId = -1;
    let resetCell = -1;
    let retaskId = -1;
    let resetTick = -1;
    let retaskTick = -1;
    let before: TrafficAgent | null = null;
    const seen: { tick: number; id: number; view: TrafficAgent; ready: boolean }[] = [];
    const sim = makeSim(scenario(), {
      traffic: () => {
        const c = new ScriptedController({
          resets: (input: TrafficInput) => {
            if (resetId >= 0 || input.tick < 1200) return [];
            for (const id of input.order) {
              const a = input.agents[id];
              if (!a || input.ready[id] !== input.tick || a.sinceProgress < 20) continue;
              for (let cell = 0; cell < input.world.n; cell++)
                if (input.world.passable[0][cell] && !input.world.isPocket[cell] && input.occ[cell] < 0 && input.world.faceAt[cell] < 0 && cell !== a.goal) {
                  resetId = id;
                  resetCell = cell;
                  resetTick = input.tick;
                  before = { ...a };
                  return [{ agent: id, cell }];
                }
            }
            return [];
          },
          retasks: (input: TrafficInput) => {
            if (retaskId >= 0 || resetId < 0) return [];
            for (const r of sim.robots)
              if (r.job === 1 && r.stage === 2 && input.ready[r.id] === input.tick && r.id !== resetId && input.agents[r.id]!.sinceProgress > 0) {
                retaskId = r.id;
                retaskTick = input.tick;
                return [r.id];
              }
            return [];
          },
        });
        const plan = c.plan.bind(c);
        c.plan = (input, out) => {
          for (const id of [resetId, retaskId])
            if (id >= 0 && (input.tick === resetTick || input.tick === retaskTick)) seen.push({ tick: input.tick, id, view: { ...input.agents[id]! }, ready: input.ready[id] === input.tick });
          plan(input, out);
        };
        return c;
      },
    });
    const ev = run(sim, 4 * 7200);
    expect(resetId).toBeGreaterThanOrEqual(0);
    expect(before!.sinceProgress).toBeGreaterThanOrEqual(20);
    const r = seen.find((x) => x.id === resetId && x.tick === resetTick)!;
    expect(r.view.cell).toBe(resetCell);
    expect(r.view.sinceProgress).toBe(0);
    expect(r.view.blockedSinceProgress).toBe(0);
    expect(ev.some((e) => e.t === 'manualReset' && e.agent === resetId && e.tick === resetTick)).toBe(true);

    expect(retaskId).toBeGreaterThanOrEqual(0);
    const q = seen.find((x) => x.id === retaskId && x.tick === retaskTick)!;
    const retask = ev.find((e): e is Extract<SimEvent, { t: 'retask' }> => e.t === 'retask' && e.agent === retaskId)!;
    expect(q.view.goal).toBe(retask.goal);
    expect(q.view.sinceProgress).toBe(0);
    expect(q.view.blockedSinceProgress).toBe(0);
    expect(q.ready).toBe(true);
  });
});

describe('units are counted once', () => {
  it('with breakdowns dropping batches mid-pick, units counted equal the lines of the shipped orders', () => {
    const events = [];
    for (let k = 0; k < 12; k++) events.push({ type: 'breakdown' as const, atMin: 20 + 7 * k, agent: `amr:${(k * 5) % 24}`, forMin: 3 });
    events.push({ type: 'breakdown' as const, atMin: 45, agent: 'picker:2', forMin: 4 }, { type: 'breakdown' as const, atMin: 60, agent: 'humanoid:0', forMin: 4 });
    const sim = makeSim(scenario({ orders: { mode: 'demand', perHour: 250 }, events }), { pibt: true });
    const ev: SimEvent[] = run(sim, 2 * 7200);
    sim.command({ t: 'setOrderRate', perHour: 0 });
    for (let k = 0; k < 12 && sim.stats().openOrders > 0; k++) run(sim, 600, ev);
    expect(ev.filter((e) => e.t === 'breakdown').length).toBe(14);
    expect(sim.stats().openOrders).toBe(0);
    const lines = new Map<number, number>();
    for (const e of ev) if (e.t === 'orderArrived') lines.set(e.order, e.lines);
    const shipped = ev.filter((e): e is Extract<SimEvent, { t: 'orderShipped' }> => e.t === 'orderShipped');
    const total = shipped.reduce((s, e) => s + lines.get(e.order)!, 0);
    const st = sim.stats();
    expect((st.unitsPicked.picker ?? 0) + (st.unitsPicked.humanoid ?? 0)).toBe(total);
    // re-picks did happen (more pickDone units than lines), and stock never went above a face's capacity
    const picked = ev.filter((e): e is Extract<SimEvent, { t: 'pickDone' }> => e.t === 'pickDone').reduce((s, e) => s + e.units, 0);
    expect(picked).toBeGreaterThan(total);
    expect(sim.debug().stock.every((x) => x <= 2 * 40)).toBe(true);
  });
});

describe('robot states', () => {
  it('a trip to rest is idle and a trip to a charger is charge, never productive travel', () => {
    const sim = makeSim(scenario({ orders: { mode: 'demand', perHour: 100 } }), { pibt: true });
    let restMoving = 0;
    let chargeMoving = 0;
    for (let k = 0; k < 3600; k++) {
      sim.step(1);
      for (const a of sim.robots) {
        if (a.to < 0) continue;
        if (a.job === 5) {
          restMoving++;
          expect(['idle', 'wait']).toContain(['idle', 'travel', 'work', 'wait', 'blocked', 'charge', 'broken'][a.state]);
        }
        if (a.job === 4) {
          chargeMoving++;
          expect(a.state).toBe(5);
        }
      }
    }
    expect(restMoving).toBeGreaterThan(50);
    expect(chargeMoving).toBeGreaterThan(10);
  });
});
