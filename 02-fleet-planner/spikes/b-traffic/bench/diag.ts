// Why do big fleets stall? One brain at 150 robots with and without people / pack dwell. npx tsx .../diag.ts [layout]
import { makeOpts, runShift, scaleFleet, SCENARIO } from '../src/index.ts';

const layout = process.argv[2] ?? 'large';
const hours = 3;
for (const robots of [30, 60, 150]) {
  const f = scaleFleet(SCENARIO.fleet, robots);
  const cases: [string, Parameters<typeof makeOpts>[1]][] = [
    ['as brief', { fleet: f }],
    ['no people', { fleet: { ...f, picker: 0, driver: 0 } }],
    ['no people, pack dwell 0', { fleet: { ...f, picker: 0, driver: 0 }, work: { packDwell: 1 } }],
  ];
  for (const [name, o] of cases) {
    const r = runShift(makeOpts('central', { ...o, silo: { retaskMin: 1 }, checks: false }), hours, layout);
    console.log(`${layout} ${robots} robots, ${name}: pick robots ${r.tasksPerHour.pickRobots}/h (${(r.tasksPerHour.pickRobots / (f.amr + f.humanoid)).toFixed(1)} per robot), blocked ${r.robotStates.blocked}%, resets/h ${r.resetsPerHour}`);
  }
}
