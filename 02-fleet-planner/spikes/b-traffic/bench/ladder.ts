// Ladder knob sweep (many brains vs a fixed one-brain reference):
//   npx tsx spikes/b-traffic/bench/ladder.ts [hours] [seeds] [robots]
import { makeOpts, runShift, type SiloKnobs } from '../src/index.ts';

const hours = Number(process.argv[2] ?? 3);
const seeds = Number(process.argv[3] ?? 2);
const robots = Number(process.argv[4] ?? 0) || undefined;

const refSilo: Partial<SiloKnobs> = process.argv[5] ? JSON.parse(process.argv[5]) : {};
const ref: number[] = [];
for (let k = 0; k < seeds; k++) ref.push(runShift(makeOpts('central', { seed: 42 + k, robots, silo: refSilo, checks: false }), hours).tasksPerHour.pickRobots);
const refMean = ref.reduce((a, b) => a + b, 0) / seeds;
console.log(`one brain pick tasks/h: ${refMean.toFixed(0)} (${ref.join(', ')})`);

const only = process.argv[6]?.split(',');
const variants: [string, Partial<SiloKnobs>][] = ([
  ['default', {}],
  ['retask1', { retaskMin: 1 }],
  ['retask2', { retaskMin: 2 }],
  ['retaskOff', { retaskMin: 0 }],
  ['wait3', { waitTicks: 3 }],
  ['wait8', { waitTicks: 8 }],
  ['wait12', { waitTicks: 12 }],
  ['sensor1', { sensorCells: 1 }],
  ['sensor2', { sensorCells: 2 }],
  ['sensor5', { sensorCells: 5 }],
  ['radius3', { detourRadius: 3 }],
  ['radius10', { detourRadius: 10 }],
  ['backoff1', { backoffMax: 1 }],
  ['backoff6', { backoffMax: 6 }],
  ['backoff10', { backoffMax: 10 }],
  ['noJitter', { jitter: false }],
  ['reset2', { resetMin: 2 }],
  ['reset10', { resetMin: 10 }],
  ['sharedQueues', { vendorQueues: false }],
  ['sharedChargers', { vendorChargers: false }],
] as [string, Partial<SiloKnobs>][]).filter(([n]) => !only || only.includes(n));
console.log('variant        pick/h   gap%  blocked%  dl/h  maxDl(s) dl>2min  resets/h  detours/h  steps/h  stops/h');
for (const [name, silo] of variants) {
  let pick = 0;
  let blocked = 0;
  let dl = 0;
  let maxDl = 0;
  let over = 0;
  let resets = 0;
  let det = 0;
  let steps = 0;
  let stops = 0;
  let h = 0;
  for (let k = 0; k < seeds; k++) {
    const r = runShift(makeOpts('siloed', { seed: 42 + k, robots, silo, checks: false }), hours);
    pick += r.tasksPerHour.pickRobots;
    blocked += r.robotStates.blocked;
    dl += r.deadlocks.perHour;
    maxDl = Math.max(maxDl, r.deadlocks.maxTicks);
    over += r.deadlocks.over2min;
    resets += r.resetsPerHour;
    det += r.ladder.detours / hours;
    steps += r.ladder.randomSteps / hours;
    stops += r.ladder.safetyStops / hours;
    h += r.measureHours;
  }
  const m = (x: number) => x / seeds;
  console.log(
    `${name.padEnd(14)} ${m(pick).toFixed(0).padStart(6)} ${((100 * (refMean - m(pick))) / refMean).toFixed(1).padStart(6)} ${m(blocked).toFixed(1).padStart(8)} ${m(dl).toFixed(0).padStart(5)} ${(maxDl / 2).toFixed(0).padStart(8)} ${String(over).padStart(7)} ${m(resets).toFixed(1).padStart(9)} ${m(det).toFixed(0).padStart(10)} ${m(steps).toFixed(0).padStart(8)} ${m(stops).toFixed(0).padStart(8)}`,
  );
}
