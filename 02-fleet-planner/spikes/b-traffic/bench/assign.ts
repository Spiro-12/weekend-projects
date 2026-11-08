// Assignment cost: greedy vs optimal (Hungarian / JV-style shortest augmenting path) on real warehouse distances.
// Called every 10 ticks over an 8 h shift = 5,760 calls. npx tsx spikes/b-traffic/bench/assign.ts [runs]
import { buildWorld, DistanceCache } from '../../../src/sim/world.ts';
import { stream } from '../../../src/sim/rng.ts';
import { LAYOUTS } from '../src/index.ts';
import { assignGreedy, assignOptimal, HungarianScratch } from '../src/assign.ts';

const runs = Number(process.argv[2] ?? 3);
const CALLS = (8 * 7200) / 10;
const w = buildWorld(LAYOUTS.default);
const dist = new DistanceCache(w);
const rng = stream(7, 'assign-bench');
const cells: number[] = [];
for (let i = 0; i < w.n; i++) if (w.passable[0][i] && !w.isPocket[i]) cells.push(i);
const faces = w.faces.map((f) => f.cell);

function matrix(n: number): Int32Array {
  const robots = Array.from({ length: n }, () => cells[rng.int(cells.length)]);
  const tasks = Array.from({ length: n }, () => faces[rng.int(faces.length)]);
  const m = new Int32Array(n * n);
  for (let j = 0; j < n; j++) {
    const d = dist.to('small', tasks[j]);
    const age = rng.int(60); // age penalty in ticks
    for (let i = 0; i < n; i++) m[i * n + j] = d[robots[i]] * 3 + age;
  }
  return m;
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p95: s[Math.floor(s.length * 0.95)] };
}

console.log('size     greedy ms/call (mean, p95)   optimal ms/call (mean, p95)   8 h greedy s   8 h optimal s   optimal saves');
for (const n of [16, 64, 150]) {
  const mats = Array.from({ length: 40 }, () => matrix(n));
  const out = new Int32Array(n);
  const used = new Uint8Array(n);
  const scratch = new HungarianScratch(n, n);
  // warm up
  for (const m of mats) {
    assignGreedy(m, n, n, out, used);
    assignOptimal(m, n, n, out, scratch);
  }
  const g: number[] = [];
  const o: number[] = [];
  let gCost = 0;
  let oCost = 0;
  for (let r = 0; r < runs; r++) {
    const callsPerRun = n >= 150 ? 600 : CALLS; // 150x150: time a sample of calls and scale
    for (let c = 0; c < callsPerRun; c++) {
      const m = mats[c % mats.length];
      let t0 = performance.now();
      gCost += assignGreedy(m, n, n, out, used);
      g.push(performance.now() - t0);
      t0 = performance.now();
      oCost += assignOptimal(m, n, n, out, scratch);
      o.push(performance.now() - t0);
    }
  }
  const gs = stats(g);
  const os = stats(o);
  console.log(
    `${String(n).padStart(3)}x${n}`.padEnd(9) +
      `${gs.mean.toFixed(4)}, ${gs.p95.toFixed(4)}`.padEnd(29) +
      `${os.mean.toFixed(4)}, ${os.p95.toFixed(4)}`.padEnd(30) +
      `${((gs.mean * CALLS) / 1000).toFixed(3)}`.padEnd(15) +
      `${((os.mean * CALLS) / 1000).toFixed(2)}`.padEnd(16) +
      `${((100 * (gCost - oCost)) / gCost).toFixed(1)}% total cost`,
  );
}
