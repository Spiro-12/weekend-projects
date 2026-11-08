// No permanent gridlock (brief): an 8 h run at 150 robots on the default layout. Every robot reaches at least one goal
// in every simulated hour; deadlocks (detect.ts: a wait-for cycle lasting >= 10 ticks) are counted and printed.
import { describe, expect, it } from 'vitest';
import { Harness, meanP95, mix, TICKS_PER_HOUR } from './harness.ts';

describe('one brain: no permanent gridlock', () => {
  it('8 h at 150 robots + 16 people: every robot reaches a goal every hour', () => {
    const hours = 8;
    const h = new Harness({ seed: 42, robots: mix(150), pickers: 14, drivers: 2, detect: true, time: true, pocketGoalPct: 10 });
    h.run(hours * TICKS_PER_HOUR);
    const d = h.finishDeadlocks();
    let worst = Infinity;
    let goals = 0;
    for (const a of h.robots()) {
      goals += a.goals;
      for (let k = 0; k < hours; k++) worst = Math.min(worst, a.goalsByHour[k] ?? 0);
    }
    const t = meanP95(h.plannerMs);
    console.log(
      `[traffic] 8 h @150: ${(goals / hours).toFixed(0)} goals/h, worst robot-hour ${worst} goals, deadlocks ${d.started}` +
        ` (over 2 min ${d.over2min}, longest ${(d.maxTicks / 2).toFixed(0)} s, active at end ${d.activeAtEnd}), resets ${h.resets}` +
        ` (${(h.resets / hours).toFixed(1)}/h), detours ${h.events.detour}, yields ${h.events.yield};` +
        ` planner mean ${t.mean.toFixed(4)} ms, p95 ${t.p95.toFixed(4)} ms`,
    );
    expect(worst).toBeGreaterThanOrEqual(1);
    const { overlap: _o, occMismatch: _m, ...moves } = h.violations;
    expect(Object.values(moves).every((n) => n === 0), JSON.stringify(h.violations)).toBe(true);
  });
});
