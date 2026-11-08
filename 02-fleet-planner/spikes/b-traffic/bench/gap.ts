// The gap: one brain vs many brains, 8 h shifts, mean over seeds. Writes out/gap.json and prints markdown tables.
//   npx tsx spikes/b-traffic/bench/gap.ts [seedsDefault] [seedsScaled]
import { writeFileSync, mkdirSync } from 'node:fs';
import { makeOpts, runShift, type OptsOverride, type RunResult } from '../src/index.ts';

const seedsDefault = Number(process.argv[2] ?? 6);
const seedsScaled = Number(process.argv[3] ?? 3);
const part = process.argv[4] ?? 'all'; // 'all' | 'large'
const HOURS = 8;

interface Row {
  label: string;
  robots: number;
  mode: string;
  n: number;
  pick: number;
  robotTasks: number;
  allTasks: number;
  idle: number;
  blocked: number;
  jamsPerHour: number;
  deadlocksPerHour: number;
  deadlockMaxS: number;
  deadlockMeanS: number;
  over2min: number;
  activeAtEndS: number;
  resetsPerHour: number;
  retasksPerHour: number;
  stepAsidesPerHour: number;
  swapsPerHour: number;
  safetyStopsPerHour: number;
  detoursPerHour: number;
  randomStepsPerHour: number;
  violations: number;
}

function agg(label: string, robots: number, mode: string, rs: RunResult[]): Row {
  const m = (f: (r: RunResult) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
  const H = rs[0].measureHours;
  return {
    label,
    robots,
    mode,
    n: rs.length,
    pick: m((r) => r.tasksPerHour.pickRobots),
    robotTasks: m((r) => r.tasksPerHour.robots),
    allTasks: m((r) => r.tasksPerHour.all),
    idle: m((r) => r.robotStates.idle),
    blocked: m((r) => r.robotStates.blocked),
    jamsPerHour: m((r) => r.jams.perHour),
    deadlocksPerHour: m((r) => r.deadlocks.perHour),
    deadlockMaxS: Math.max(...rs.map((r) => r.deadlocks.maxTicks)) / 2,
    deadlockMeanS: m((r) => r.deadlocks.meanTicks) / 2,
    over2min: rs.reduce((s, r) => s + r.deadlocks.over2min, 0),
    activeAtEndS: Math.max(...rs.map((r) => r.deadlocks.activeAtEndTicks)) / 2,
    resetsPerHour: m((r) => r.resetsPerHour),
    retasksPerHour: m((r) => r.retasksPerHour),
    stepAsidesPerHour: m((r) => r.people.stepAsidesPerHour),
    swapsPerHour: m((r) => r.people.swaps / H),
    safetyStopsPerHour: m((r) => r.ladder.safetyStops / H),
    detoursPerHour: m((r) => r.ladder.detours / H),
    randomStepsPerHour: m((r) => r.ladder.randomSteps / H),
    violations: rs.reduce((s, r) => s + Object.values(r.violations).reduce((a, b) => a + b, 0), 0),
  };
}

function runPair(label: string, robots: number, seeds: number, o: OptsOverride, layout = 'default'): [Row, Row] {
  const out: Row[] = [];
  for (const mode of ['central', 'siloed'] as const) {
    const rs: RunResult[] = [];
    for (let k = 0; k < seeds; k++) {
      rs.push(runShift(makeOpts(mode, { ...o, seed: 42 + k, robots: robots === 30 ? undefined : robots, checks: true }), HOURS, layout));
    }
    out.push(agg(label, robots, mode, rs));
  }
  return [out[0], out[1]];
}

const rows: Row[] = [];
const f0 = (x: number) => x.toFixed(0);
const f1 = (x: number) => x.toFixed(1);
const line = (c: Row, s: Row) =>
  `| ${c.label} | ${c.robots} | ${f0(c.pick)} / ${f0(s.pick)} | **${f1((100 * (c.pick - s.pick)) / c.pick)}%** | ${f1((100 * (c.robotTasks - s.robotTasks)) / c.robotTasks)}% | ${f1((100 * (c.allTasks - s.allTasks)) / c.allTasks)}% | ${f1(c.idle)} / ${f1(s.idle)} | ${f1(c.blocked)} / ${f1(s.blocked)} | ${f1(c.jamsPerHour)} / ${f1(s.jamsPerHour)} | ${f1(c.deadlocksPerHour)} / ${f1(s.deadlocksPerHour)} | ${f0(c.deadlockMaxS)} / ${f0(s.deadlockMaxS)} | ${c.over2min} / ${s.over2min} | ${f1(c.resetsPerHour)} / ${f1(s.resetsPerHour)} | ${f1(c.retasksPerHour)} / ${f1(s.retasksPerHour)} | ${f0(c.stepAsidesPerHour)} / ${f0(s.stepAsidesPerHour)} | ${f0(s.safetyStopsPerHour)} | ${c.violations + s.violations} |`;
const header =
  '| setup | robots | pick tasks/h one / many | gap (pick) | gap (all robots) | gap (all tasks) | idle % | blocked % | jams/h | deadlocks/h | max deadlock s | deadlocks > 2 min | resets/h | re-tasks/h | person step-asides/h | safety stops/h (many) | invariant violations |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';

const lines: string[] = [];
if (part === 'large') {
  console.log(`Large layout (22 aisles, 10 pack stations), pickers stay in zones, retaskMin 1.5, ${HOURS} h, ${seedsScaled} seeds:`);
  console.log(header);
  for (const robots of [30, 60, 100, 150]) {
    const [c, s] = runPair('large, pickers in zones', robots, seedsScaled, { work: { peoplePack: false } }, 'large');
    rows.push(c, s);
    console.log(line(c, s));
  }
  mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../out/gap-large.json', import.meta.url), JSON.stringify(rows, null, 1));
  process.exit(0);
}
console.log(`Default fleet, ${HOURS} h shifts, ${seedsDefault} seeds (one / many):`);
console.log(header);
for (const rt of [1.5, 1, 2, 0]) {
  const [c, s] = runPair(`retaskMin ${rt}${rt === 1.5 ? ' (default)' : rt === 0 ? ' (off)' : ''}`, 30, seedsDefault, { silo: { retaskMin: rt } });
  rows.push(c, s);
  const l = line(c, s);
  lines.push(l);
  console.log(l);
}
console.log(`\nScaled fleets, default layout, retaskMin 1.5, ${HOURS} h, ${seedsScaled} seeds (one / many):`);
console.log(header);
for (const [label, o] of [
  ['brief loop', {}],
  ['pickers stay in zones', { work: { peoplePack: false } }],
] as [string, OptsOverride][]) {
  for (const robots of [30, 60, 100, 150]) {
    const [c, s] = runPair(label, robots, seedsScaled, o);
    rows.push(c, s);
    const l = line(c, s);
    lines.push(l);
    console.log(l);
  }
}
mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
writeFileSync(new URL('../out/gap.json', import.meta.url), JSON.stringify(rows, null, 1));
