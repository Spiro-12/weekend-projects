// Live sim for the 3D view: a fixed 0.5 s tick advanced from wall time × speed. The renderer interpolates each
// agent from its (cell, to, moveStart, moveEnd) at the fractional time `renderTick`, so only the latest snapshot is
// needed. The numbers on screen come from the runner, not from here (PLAN §4 "two clocks, one truth").
import { TICK_MS, type Command, type Scenario, type Sim, type SimEvent, type Snapshot } from '../contracts/types.ts';
import { createSim, type SimData, type SimImpl } from '../sim/index.ts';

export const SPEEDS = [1, 10, 60] as const;
/** Never step more than this many ticks per frame (a slow frame skips sim time instead of freezing). */
export const MAX_TICKS_PER_FRAME = 240;

export class LiveSim {
  sim: Sim;
  snapshot: Snapshot;
  speed = 1;
  paused = false;
  private accMs = 0;
  private listeners = new Set<(s: Snapshot, events: SimEvent[]) => void>();

  constructor(
    public scenario: Scenario,
    public data: SimData,
    readonly impl?: SimImpl,
  ) {
    this.sim = createSim(scenario, data, impl);
    this.snapshot = this.sim.snapshot();
  }

  /** Fractional sim time for rendering, in ticks. */
  get renderTick(): number {
    return this.sim.tick - 1 + this.accMs / TICK_MS;
  }

  /** Advance by wall-clock milliseconds. Returns the number of ticks stepped. */
  advance(dtMs: number): number {
    if (this.paused) return 0;
    this.accMs += Math.min(dtMs, 250) * this.speed;
    let n = Math.floor(this.accMs / TICK_MS);
    this.accMs -= n * TICK_MS;
    if (n > MAX_TICKS_PER_FRAME) n = MAX_TICKS_PER_FRAME;
    if (n > 0) {
      this.sim.step(n);
      this.snapshot = this.sim.snapshot();
      const events = this.sim.drainEvents();
      for (const fn of this.listeners) fn(this.snapshot, events);
    }
    return n;
  }

  /** Step exactly n ticks (tests, capture). */
  stepTicks(n: number): void {
    this.sim.step(n);
    this.accMs = 0;
    this.snapshot = this.sim.snapshot();
    const events = this.sim.drainEvents();
    for (const fn of this.listeners) fn(this.snapshot, events);
  }

  command(c: Command): void {
    this.sim.command(c);
  }

  /** Restart from a new scenario (and layout). The same LiveSim object is kept, so listeners, speed and pause stay. */
  reset(scenario: Scenario, data: SimData = this.data): void {
    this.scenario = scenario;
    this.data = data;
    this.sim = createSim(scenario, this.data, this.impl);
    this.accMs = 0;
    this.snapshot = this.sim.snapshot();
    for (const fn of this.listeners) fn(this.snapshot, []);
  }

  onUpdate(fn: (s: Snapshot, events: SimEvent[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
