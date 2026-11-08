import { describe, expect, it } from 'vitest';
import { CELL_MM } from '../../src/contracts/types.ts';
import { moveTicks } from '../../src/sim/motion.ts';

describe('moveTicks', () => {
  it('average speed is exact over continuous straight moves', () => {
    for (const speed of [400, 500, 670]) {
      let carry = 0;
      let ticks = 0;
      for (let k = 0; k < 1000; k++) {
        const m = moveTicks(carry, speed);
        carry = m.carryMm;
        ticks += m.ticks;
      }
      const mmPerTick = (1000 * CELL_MM) / ticks;
      expect(Math.abs(mmPerTick - speed) / speed).toBeLessThan(0.01);
    }
  });
  it('any turn resets the carry, even with zero turn ticks', () => {
    expect(moveTicks(1000, 500, 0, true)).toEqual({ ticks: 3, carryMm: 0 });
    expect(moveTicks(1000, 500, 0, false).ticks).toBe(1);
    expect(moveTicks(1000, 500, 2)).toEqual({ ticks: 5, carryMm: 0 });
  });
});
