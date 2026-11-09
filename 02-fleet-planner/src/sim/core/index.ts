// Track A sim core entry point: createCoreSim(scenario, {agents, layout}, {traffic?}) → Sim.
// The default traffic factory returns NaiveController; the lead switches it to Track B's controller at integration
// (pass `traffic: (mode) => new CentralController(...)`, or change the default in sim.ts).
export { CoreSim, createCoreSim, type CoreSimData, type CoreSimOptions, type Violations } from './sim.ts';
export {
  BATCH_WINDOW,
  CONVEYOR_TICKS,
  ORDERS_PER_CART,
  PRESEND_CELLS,
  TOTES_PER_AMR,
  ZONE_MAX_AMRS,
  ZONE_PICKERS,
} from './constants.ts';
