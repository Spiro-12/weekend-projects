// Same scenario + seed + command log ⇒ the same hash (PROTOCOL §8); a different seed ⇒ a different hash; hash() throws
// on any non-integer state.
import { describe, expect, it } from 'vitest';
import type { Command } from '../../../src/contracts/types.ts';
import type { CoreSim } from '../../../src/sim/core/index.ts';
import { makeSim, scenario } from './helpers/data.ts';

const COMMANDS: { tick: number; c: Command }[] = [
  { tick: 600, c: { t: 'setFleet', type: 'amr', count: 30 } },
  { tick: 1800, c: { t: 'setOrderRate', perHour: 450 } },
  { tick: 2400, c: { t: 'inject', event: { type: 'breakdown', atMin: 0, agent: 'amr:2', forMin: 4 } } },
  { tick: 3600, c: { t: 'setFleet', type: 'picker', count: 10 } },
];

function hourRun(seed: number, pibt: boolean): { sim: CoreSim; hash: string } {
  const sim = makeSim(scenario({ seed }), { pibt });
  for (const { tick, c } of COMMANDS) {
    sim.step(tick - sim.tick);
    sim.command(c);
  }
  sim.step(7200 - sim.tick);
  return { sim, hash: sim.hash() };
}

describe('determinism', () => {
  for (const pibt of [false, true]) {
    const label = pibt ? 'test PIBT controller' : 'NaiveController';
    it(`same scenario, seed and commands give the same hash after 1 h (${label})`, () => {
      const a = hourRun(42, pibt);
      const b = hourRun(42, pibt);
      expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(b.hash).toBe(a.hash);
      expect(b.sim.commandLog()).toEqual(a.sim.commandLog());
      expect(b.sim.snapshot()).toEqual(a.sim.snapshot());
    });
    it(`a different seed gives a different hash (${label})`, () => {
      expect(hourRun(7, pibt).hash).not.toBe(hourRun(42, pibt).hash);
    });
  }

  it('hash() is stable across calls and reflects every step', () => {
    const sim = makeSim(scenario(), { pibt: true });
    sim.step(100);
    const h = sim.hash();
    expect(sim.hash()).toBe(h);
    sim.step(1);
    expect(sim.hash()).not.toBe(h);
  });

  it('hash() throws on a non-integer state value', () => {
    const sim = makeSim(scenario(), { pibt: true });
    sim.step(10);
    sim.agents[0].carry = 0.5;
    expect(() => sim.hash()).toThrow(/non-integer/);
  });

  it('order contents do not depend on the order rate or the fleet (common random numbers)', () => {
    const a = makeSim(scenario({ orders: { mode: 'demand', perHour: 300 } }), {});
    const b = makeSim(scenario({ orders: { mode: 'demand', perHour: 900 }, fleet: { amr: 0, humanoid: 0 } }), {});
    const lines = (sim: CoreSim, n: number) => {
      const out = new Map<number, number>();
      while (out.size < n) {
        sim.step(60);
        for (const e of sim.drainEvents()) if (e.t === 'orderArrived') out.set(e.order, e.lines);
      }
      return [...out.entries()].sort((x, y) => x[0] - y[0]).slice(0, n);
    };
    expect(lines(b, 50)).toEqual(lines(a, 50));
  });
});
