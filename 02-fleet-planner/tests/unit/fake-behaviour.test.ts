// FakeSim must stay lively for hours: render and UI tracks (and the live Phase 0 preview) depend on it.
import { describe, expect, it } from 'vitest';
import agents from '../../data/agents.json';
import layout from '../../data/layouts/default.json';
import scenarioJson from '../../data/scenarios/default.json';
import type { AgentsFile, LayoutFile, Scenario, SimEvent } from '../../src/contracts/types.ts';
import { createFakeSim } from '../../src/sim/fake.ts';

const H = 7200;
function run(hours: number) {
  const sim = createFakeSim(scenarioJson as Scenario, { agents: agents as AgentsFile, layout: layout as LayoutFile });
  const perHour: SimEvent[][] = [];
  for (let h = 0; h < hours; h++) {
    sim.step(H);
    perHour.push(sim.drainEvents());
  }
  return { sim, perHour };
}
const count = (ev: SimEvent[], t: SimEvent['t']) => ev.filter((e) => e.t === t).length;

describe('FakeSim stays lively (review fixes)', () => {
  const { sim, perHour } = run(6);
  it('work keeps flowing: picks in hours 4-6 are at least half of hour 1', () => {
    const first = count(perHour[0], 'pickDone') + count(perHour[0], 'toteDelivered') + count(perHour[0], 'palletMoved');
    for (const h of [3, 4, 5]) {
      const n = count(perHour[h], 'pickDone') + count(perHour[h], 'toteDelivered') + count(perHour[h], 'palletMoved');
      expect(n, `hour ${h + 1}: ${n} work events vs ${first} in hour 1`).toBeGreaterThanOrEqual(first * 0.5);
    }
    expect(count(perHour[5], 'palletMoved')).toBeGreaterThan(0);
  });
  it('robots charge every hour and chargeStart/chargeEnd pair up', () => {
    for (const h of [1, 2, 3, 4, 5]) expect(count(perHour[h], 'chargeStart'), `hour ${h + 1}`).toBeGreaterThanOrEqual(2);
    const all = perHour.flat();
    expect(Math.abs(count(all, 'chargeStart') - count(all, 'chargeEnd'))).toBeLessThanOrEqual(12);
    const stranded = sim.snapshot().agents.filter((a) => a.type !== 'picker' && a.type !== 'driver' && a.batteryPct === 0);
    expect(stranded.length).toBeLessThanOrEqual(1);
  });
  it('jams happen (render tracks need them) but deadlocks stay rare', () => {
    expect(count(perHour[0].concat(perHour[1]), 'jamStart')).toBeGreaterThanOrEqual(1);
    for (const h of perHour) expect(count(h, 'deadlockStart')).toBeLessThan(40);
  });
});
