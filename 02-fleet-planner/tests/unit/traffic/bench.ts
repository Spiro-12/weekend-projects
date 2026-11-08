// Track B bench (not a test): planner time and liveness at 30 / 60 / 100 / 150 robots on the default layout.
//   npx tsx tests/unit/traffic/bench.ts [runs=3] [hours=8] [sizes=30,60,100,150] [people=16]
//   env: GOALS=work|any (harness goal model, default work), STATION=20 (percent of robot goals at stations),
//        ALL_AMR=1 (every robot an AMR)
// Prints per fleet size: planner ms/tick mean and p95 (averaged over runs, min-max in brackets), max tick, deadlocks
// (detect.ts), resets, detours, yields, the worst robot-hour (fewest goals reached by any robot in any hour) with the
// number of robot-hours at 0, and goals per hour. Seeds 42, 43, ...
import { Harness, meanP95, mix, TICKS_PER_HOUR } from './harness.ts';

const GOALS = (process.env.GOALS ?? 'work') as 'work' | 'any';
const STATION = Number(process.env.STATION ?? 20);
const ALL_AMR = process.env.ALL_AMR === '1';

const runs = Number(process.argv[2] ?? 3);
const hours = Number(process.argv[3] ?? 8);
const sizes = (process.argv[4] ?? '30,60,100,150').split(',').map(Number);
const people = Number(process.argv[5] ?? 16);

const fmt = (x: number) => x.toFixed(4);
console.log(`default layout, ${runs} runs x ${hours} h, ${people} people (${people - Math.round(people / 8)} pickers + ${Math.round(people / 8)} drivers); planner = recover() + plan()`);
console.log('robots | mean ms/tick (min-max) | p95 ms/tick (min-max) | max ms | deadlocks (>2 min, max s) | resets | detours | yields | worst robot-hour goals');
for (const robots of sizes) {
  const means: number[] = [];
  const p95s: number[] = [];
  let max = 0;
  let dl = 0;
  let over = 0;
  let maxDl = 0;
  let resets = 0;
  let detours = 0;
  let yields = 0;
  let worst = Infinity;
  let zeroHours = 0;
  let goals = 0;
  for (let r = 0; r < runs; r++) {
    const drivers = Math.round(people / 8);
    const h = new Harness({ seed: 42 + r, robots: ALL_AMR ? { amr: robots } : mix(robots), pickers: people - drivers, drivers, time: true, detect: true, pocketGoalPct: 10, goals: GOALS, stationPct: STATION });
    h.run(hours * TICKS_PER_HOUR);
    const s = meanP95(h.plannerMs);
    means.push(s.mean);
    p95s.push(s.p95);
    max = Math.max(max, s.max);
    const d = h.finishDeadlocks();
    dl += d.started;
    over += d.over2min;
    maxDl = Math.max(maxDl, d.maxTicks);
    resets += h.resets;
    detours += h.events.detour;
    yields += h.events.yield;
    for (const a of h.robots()) goals += a.goals;
    for (const a of h.robots())
      for (let k = 0; k < hours; k++) {
        const g = a.goalsByHour[k] ?? 0;
        worst = Math.min(worst, g);
        if (g === 0) zeroHours++;
      }
    const v = Object.entries(h.violations).filter(([, n]) => n > 0);
    if (v.length) console.log(`  !! violations seed ${42 + r}: ${JSON.stringify(Object.fromEntries(v))}`);
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const range = (xs: number[]) => `${fmt(Math.min(...xs))}-${fmt(Math.max(...xs))}`;
  console.log(
    `${String(robots).padStart(6)} | ${fmt(avg(means))} (${range(means)}) | ${fmt(avg(p95s))} (${range(p95s)}) | ${max.toFixed(2)} | ${dl} (${over}, ${(maxDl / 2).toFixed(0)}) | ${resets} | ${detours} | ${yields} | ${worst} (${zeroHours} of ${robots * hours * runs} robot-hours at 0) | goals/h ${(goals / runs / hours).toFixed(0)}`,
  );
}
