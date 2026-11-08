// The core runs on every layout preset with its own scenario: orders flow and the occupancy invariants hold.
import { describe, expect, it } from 'vitest';
import largeScenario from '../../../data/scenarios/large.json';
import smallScenario from '../../../data/scenarios/small.json';
import type { Scenario } from '../../../src/contracts/types.ts';
import { count, makeSim, run } from './helpers/data.ts';

describe('layout presets', () => {
  for (const s of [smallScenario as Scenario, largeScenario as Scenario]) {
    it(`${s.id}: orders ship and invariants hold for 1 h`, () => {
      const sim = makeSim(s, { pibt: true, checks: true });
      const ev = run(sim, 7200);
      expect(count(ev, 'orderShipped')).toBeGreaterThan(s.orders.perHour * 0.3);
      expect(count(ev, 'pickDone')).toBeGreaterThan(0);
      const v = sim.debug().violations;
      expect(v.overlap + v.occMismatch + v.moveIntoHeld + v.forkOnNarrow + v.pocketNotGoal + v.badMove + v.negativeBattery).toBe(0);
      expect(sim.hash()).toMatch(/^[0-9a-f]{16}$/);
    });
  }
});
