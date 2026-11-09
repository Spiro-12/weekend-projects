// Battery and charging (the brief §7): seeded start spread, charging below chargeAtPct after the task, charge rate
// runtime ÷ charge time, a queue when chargers are busy, chargers never shared.
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../../src/contracts/types.ts';
import { count, makeSim, run, scenario } from './helpers/data.ts';

describe('battery', () => {
  it('starts spread between chargeAtPct and full (seeded) when run.batterySpread, else full', () => {
    const spread = makeSim(scenario(), {}).snapshot().agents.filter((a) => a.type === 'amr').map((a) => a.batteryPct);
    expect(Math.min(...spread)).toBeGreaterThanOrEqual(20);
    expect(new Set(spread).size).toBeGreaterThan(8);
    const full = makeSim(scenario({ run: { warmupMin: 30, measureMin: 120, batterySpread: false } }), {}).snapshot().agents;
    expect(full.filter((a) => a.type !== 'picker' && a.type !== 'driver').every((a) => a.batteryPct === 100)).toBe(true);
  });

  it('drains one tick of run time per tick; charges at runtime ÷ charge time per tick', () => {
    const sim = makeSim(scenario({ run: { warmupMin: 30, measureMin: 120, batterySpread: false } }), {});
    const hu = sim.robots.find((r) => r.typeId === 'humanoid')!;
    expect(hu.batteryMax).toBe(2 * 7200);
    expect([hu.chargeQ, hu.chargeR]).toEqual([2, 0]); // 2 h runtime / 1 h charge
    sim.step(100);
    expect(hu.battery).toBe(2 * 7200 - 100);
  });

  it('humanoids queue for chargers when they are all busy, and every one gets its charge', () => {
    // 20 humanoids, all full at the start, all reach 20% at about the same time; 12 small chargers.
    const s = scenario({
      fleet: { amr: 0, humanoid: 20, picker: 0, forklift: 0, driver: 2 },
      run: { warmupMin: 30, measureMin: 120, batterySpread: false },
      orders: { mode: 'saturate' },
    });
    const sim = makeSim(s, { pibt: true, checks: true });
    let maxQueue = 0;
    const ev: SimEvent[] = [];
    for (let k = 0; k < 7 * 12; k++) {
      run(sim, 600, ev);
      maxQueue = Math.max(maxQueue, sim.debug().chargeQueue.length);
      const holders = sim.snapshot().chargers.map((c) => c.agentId).filter((x) => x >= 0);
      expect(new Set(holders).size).toBe(holders.length);
    }
    expect(maxQueue).toBeGreaterThan(0);
    const charged = new Set(ev.filter((e) => e.t === 'chargeStart').map((e) => e.agent));
    expect(charged.size).toBe(20);
    expect(count(ev, 'chargeEnd')).toBeGreaterThanOrEqual(15);
    expect(sim.snapshot().agents.every((a) => a.batteryPct >= 0)).toBe(true);
    expect(sim.debug().violations.negativeBattery).toBe(0);
  });
});
