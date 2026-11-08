// Knob exploration: npx tsx spikes/b-traffic/bench/explore.ts [hours] [seeds] [robots]
import { makeOpts, runShift, type OptsOverride } from '../src/index.ts';

const hours = Number(process.argv[2] ?? 2);
const seeds = Number(process.argv[3] ?? 2);
const robots = Number(process.argv[4] ?? 0) || undefined;
const filter = process.argv[5];

const configs: Record<string, OptsOverride> = {
  base: {},
  noBalance: { work: { balanceStations: false } },
  noPeopleHold: { work: { peopleGoalHold: false } },
  robotHold: { work: { goalHold: true } },
  vendorStations: { work: { vendorStations: true } },
};

for (const [name, o] of Object.entries(configs)) {
  if (filter && !name.includes(filter)) continue;
  const rows: string[] = [];
  let c = 0;
  let s = 0;
  let cr = 0;
  let sr = 0;
  for (let k = 0; k < seeds; k++) {
    const seed = 42 + k;
    const rc = runShift(makeOpts('central', { ...o, seed, robots, checks: false }), hours);
    const rs = runShift(makeOpts('siloed', { ...o, seed, robots, checks: false }), hours);
    c += rc.tasksPerHour.pickRobots;
    s += rs.tasksPerHour.pickRobots;
    cr += rc.tasksPerHour.robots;
    sr += rs.tasksPerHour.robots;
    rows.push(`  seed ${seed}: pick ${rc.tasksPerHour.pickRobots}/${rs.tasksPerHour.pickRobots} blocked ${rc.robotStates.blocked}/${rs.robotStates.blocked} dl ${rc.deadlocks.count}/${rs.deadlocks.count} max ${rc.deadlocks.maxTicks}/${rs.deadlocks.maxTicks} resets/h ${rc.resetsPerHour}/${rs.resetsPerHour} people ${rc.tasksPerHour.people}/${rs.tasksPerHour.people}`);
  }
  console.log(`${name}: pick robots ${(c / seeds).toFixed(0)} vs ${(s / seeds).toFixed(0)} gap ${((100 * (c - s)) / c).toFixed(1)}%  all robots gap ${((100 * (cr - sr)) / cr).toFixed(1)}%`);
  for (const r of rows) console.log(r);
}
