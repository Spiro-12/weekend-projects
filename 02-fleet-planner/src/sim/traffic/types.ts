// TrafficController: the seam between the sim core (Track A) and the planners (Track B one brain, Track G many
// brains). Lead-owned, frozen from spike b's working shape (PROTOCOL §5). The controller never mutates sim state:
// the sim applies resets and re-tasks, then the planned moves.
import type { PassClass, TrafficMode } from '../../contracts/types.ts';
import type { DistanceCache, World } from '../world.ts';

/** What a planner may read about each robot (indexed by agent id; people are never planned). */
export interface TrafficAgent {
  id: number;
  vendor: string;
  passClass: PassClass;
  cell: number;
  /** 0 E, 1 S, 2 W, 3 N. */
  heading: number;
  /** Travel goal cell or -1. */
  goal: number;
  safetyCells: number;
  turnTicks: number;
  /** Ticks since this robot last got closer to its goal. */
  sinceProgress: number;
  /** Of those, ticks it spent blocked. */
  blockedSinceProgress: number;
}

export interface TrafficInput {
  tick: number;
  world: World;
  dist: DistanceCache;
  /** Robot views, indexed by agent id (holes are null: people or removed agents). */
  agents: readonly (TrafficAgent | null)[];
  /** Robot ids, highest priority first. The sim owns priority: oldest goalTick, then a seeded tie-break redrawn at
   *  each new goal, then id. */
  order: readonly number[];
  /** ready[id] === tick: at a cell boundary with a travel goal (not moving, dwelling, charging or broken). */
  ready: Int32Array;
  /** occ[cell] = holder id (robots and people, including move targets and forklift safety cells), -1 if free. */
  occ: Int32Array;
  /** Pairs [robotId, personCell, ...]: a blocked person asks this robot to make way (robots yield to people). */
  yields: readonly number[];
}

export interface TrafficEvent {
  t: 'detour' | 'stepAside' | 'safetyStop' | 'yield';
  agent: number;
  cell: number;
}

/** Output buffers, indexed by agent id, preallocated by the sim (length ≥ max agent id + 1). */
export interface TrafficPlan {
  /** Cell to start moving into this tick, or -1 to stay. Conflict-free with occ and with each other. */
  moveTo: Int32Array;
  /** Safety cell reserved ahead (forklifts), or -1. */
  safety: Int32Array;
  /** Heading of the move (0..3), or -1. */
  dir: Int8Array;
  /** Preferred next cell even when staying (wait-for graph, "waiting for" arrows, ribbons). */
  want: Int32Array;
  events: TrafficEvent[];
}

export interface Recovery {
  /** Manual resets: move the robot to this free cell (a person walked over). Costs supervisor minutes. */
  resets: { agent: number; cell: number }[];
  /** Fleet-manager job timeouts: give these robots another station or job. */
  retasks: number[];
}

export interface TrafficController {
  readonly mode: TrafficMode;
  /** Step 1 of a tick: ladder decisions, applied by the sim before planning (so every brain sees them). */
  recover(input: TrafficInput): Recovery;
  /** Step 2: plan moves into `out` (the sim cleared it to -1 / empty). */
  plan(input: TrafficInput, out: TrafficPlan): void;
  /** Controller-private state (detour paths, ladder marks, backoff) for hash() and snapshots. Integers only. */
  stateWords(): number[];
}

export function createPlan(capacity: number): TrafficPlan {
  return {
    moveTo: new Int32Array(capacity).fill(-1),
    safety: new Int32Array(capacity).fill(-1),
    dir: new Int8Array(capacity).fill(-1),
    want: new Int32Array(capacity).fill(-1),
    events: [],
  };
}

export function clearPlan(p: TrafficPlan): void {
  p.moveTo.fill(-1);
  p.safety.fill(-1);
  p.dir.fill(-1);
  p.want.fill(-1);
  p.events.length = 0;
}
