// Gap vs fleet size for a few re-task settings: npx tsx spikes/b-traffic/bench/scale.ts [hours] [seeds] [retaskList]
import { makeOpts, runShift } from '../src/index.ts';

const hours = Number(process.argv[2] ?? 4);
const seeds = Number(process.argv[3] ?? 3);
const retasks = (process.argv[4] ?? '0,1,2').split(',').map(Number);
const sizes = (process.argv[5] ?? '30,60,100,150').split(',').map(Number);
const layout = process.argv[6] ?? 'default';
console.log('layout', layout);
console.log('retaskMin robots  one/h  many/h  gap%  blocked one/many  resets/h one/many  maxDl s one/many');
for (const rt of retasks) {
  for (const robots of sizes) {
    const acc = { c: 0, s: 0, bc: 0, bs: 0, rc: 0, rs: 0, mc: 0, ms: 0 };
    for (let k = 0; k < seeds; k++) {
      const o = { seed: 42 + k, robots: robots === 30 ? undefined : robots, silo: { retaskMin: rt }, checks: false };
      const c = runShift(makeOpts('central', o), hours, layout);
      const s = runShift(makeOpts('siloed', o), hours, layout);
      acc.c += c.tasksPerHour.pickRobots;
      acc.s += s.tasksPerHour.pickRobots;
      acc.bc += c.robotStates.blocked;
      acc.bs += s.robotStates.blocked;
      acc.rc += c.resetsPerHour;
      acc.rs += s.resetsPerHour;
      acc.mc = Math.max(acc.mc, c.deadlocks.maxTicks);
      acc.ms = Math.max(acc.ms, s.deadlocks.maxTicks);
    }
    const m = (x: number) => (x / seeds).toFixed(0);
    const m1 = (x: number) => (x / seeds).toFixed(1);
    console.log(`${String(rt).padStart(9)} ${String(robots).padStart(6)} ${m(acc.c).padStart(6)} ${m(acc.s).padStart(7)} ${((100 * (acc.c - acc.s)) / acc.c).toFixed(1).padStart(5)}  ${m1(acc.bc)}/${m1(acc.bs)}  ${m1(acc.rc)}/${m1(acc.rs)}  ${acc.mc / 2}/${acc.ms / 2}`);
  }
}
