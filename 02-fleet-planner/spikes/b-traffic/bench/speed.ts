// Speed: ms per tick (mean, p95) and 8 h shift wall time, both modes, at 30/60/100/150 robots.
//   npx tsx spikes/b-traffic/bench/speed.ts [runs] [layout] [checks]
import { createSim, makeOpts, TICKS_PER_HOUR } from '../src/index.ts';

const runs = Number(process.argv[2] ?? 3);
const layout = process.argv[3] ?? 'default';
const checks = process.argv[4] === 'checks';
const sizes = (process.argv[5] ?? '30,60,100,150').split(',').map(Number);
const TICKS = 8 * TICKS_PER_HOUR;

console.log(`layout ${layout}, ${runs} runs of 8 h (${TICKS} ticks), checks ${checks ? 'on' : 'off'}; whole tick (people, planner, detection)`);
console.log('mode     robots agents  mean ms/tick (min-max over runs)  p95 ms/tick (min-max)  8 h wall s (mean)  max tick ms');
for (const robots of sizes) {
  for (const mode of ['central', 'siloed'] as const) {
    const means: number[] = [];
    const p95s: number[] = [];
    const walls: number[] = [];
    let maxTick = 0;
    let agents = 0;
    for (let r = 0; r < runs; r++) {
      const sim = createSim(makeOpts(mode, { seed: 42 + r, robots: robots === 30 ? undefined : robots, checks }), layout);
      agents = sim.agents.length;
      const dt = new Float64Array(TICKS);
      const w0 = performance.now();
      for (let t = 0; t < TICKS; t++) {
        const t0 = performance.now();
        sim.step();
        dt[t] = performance.now() - t0;
      }
      walls.push((performance.now() - w0) / 1000);
      let sum = 0;
      for (let t = 0; t < TICKS; t++) {
        sum += dt[t];
        if (dt[t] > maxTick) maxTick = dt[t];
      }
      means.push(sum / TICKS);
      const sorted = Array.from(dt).sort((a, b) => a - b);
      p95s.push(sorted[Math.floor(TICKS * 0.95)]);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const rng = (xs: number[]) => `${Math.min(...xs).toFixed(4)}-${Math.max(...xs).toFixed(4)}`;
    console.log(
      `${mode.padEnd(8)} ${String(robots).padStart(6)} ${String(agents).padStart(6)}  ${avg(means).toFixed(4)} (${rng(means)})`.padEnd(58) +
        `${avg(p95s).toFixed(4)} (${rng(p95s)})`.padEnd(25) +
        `${avg(walls).toFixed(2)}`.padEnd(19) +
        `${maxTick.toFixed(2)}`,
    );
  }
}
