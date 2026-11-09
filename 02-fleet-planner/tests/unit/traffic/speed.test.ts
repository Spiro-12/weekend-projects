// Planner speed (brief: <= 0.1 ms per tick at 150 robots; budgets.json plannerMsPerTick). recover() + plan() wall time
// per tick over 1 h at 30 / 60 / 100 / 150 robots + 16 people on the default layout. Other tracks and test files share
// the machine, so the assertion uses the mean without the slowest 1% of ticks (preemption and GC spikes) and allows
// budgets.json ciSlack. The report numbers come from tests/unit/traffic/bench.ts (repeated 8 h runs).
import { describe, expect, it } from 'vitest';
import budgets from '../../../budgets.json';
import { Harness, meanP95, mix, TICKS_PER_HOUR } from './harness.ts';

function trimmedMean(xs: number[], drop: number): number {
  const s = Float64Array.from(xs).sort();
  const n = s.length - Math.floor(s.length * drop);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  return sum / n;
}

describe('one brain: planner speed', () => {
  it('ms per tick at 30 / 60 / 100 / 150 robots', () => {
    const rows: string[] = [];
    let at150 = 0;
    for (const robots of [30, 60, 100, 150]) {
      const h = new Harness({ seed: 42, robots: mix(robots), pickers: 14, drivers: 2, time: true, pocketGoalPct: 10 });
      h.run(TICKS_PER_HOUR);
      const ms = h.plannerMs.slice(600); // skip the first 5 minutes (JIT warm-up)
      const s = meanP95(ms);
      const t = trimmedMean(ms, 0.01);
      rows.push(`${robots}: mean ${s.mean.toFixed(4)} (99% ${t.toFixed(4)}) p95 ${s.p95.toFixed(4)} max ${s.max.toFixed(3)}`);
      if (robots === 150) at150 = t;
    }
    console.log(`[traffic] planner ms/tick (1 h each): ${rows.join(' | ')}`);
    expect(at150).toBeLessThanOrEqual(budgets.plannerMsPerTick * budgets.ciSlack);
  });
});
