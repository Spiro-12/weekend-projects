// Follow card helpers (Track F): plain words for agent states and tasks, and a short history of what the followed
// agent did (kept from live snapshots; the sim has no per-agent history).
import type { AgentState, AgentView, Snapshot, TaskKind, TaskView } from '../../../contracts/types.ts';

export const STATE_WORDS: Record<AgentState, string> = {
  idle: 'Idle',
  travel: 'Moving',
  work: 'Working',
  wait: 'Waiting',
  blocked: 'Blocked',
  charge: 'Charging',
  broken: 'Broken down',
};

export const TASK_WORDS: Record<TaskKind, string> = {
  pick: 'Picking an order',
  replenish: 'Restocking a rack',
  inbound: 'Bringing in a pallet',
  charge: 'Charging',
  park: 'Parking',
};

const STOPS: Record<string, string> = {
  face: 'a pick face',
  station: 'a pack station',
  pack: 'a pack station',
  dock: 'the dock',
  charger: 'a charger',
  park: 'parking',
  parking: 'parking',
  rack: 'a rack',
  staging: 'staging',
};

/** "to station" → "a pack station". Undefined when the stage isn't a destination. */
export function stopWords(stage: string | undefined): string | undefined {
  const m = stage ? /^to (.+)$/.exec(stage.trim()) : null;
  if (!m) return undefined;
  return STOPS[m[1]] ?? m[1].replace(/[_-]+/g, ' ');
}

export function describe(a: AgentView, task: TaskView | undefined): string {
  const st = STATE_WORDS[a.state] ?? a.state;
  const stop = stopWords(task?.stage);
  if (stop && a.state === 'travel') return `${st} to ${stop}`;
  if (stop && a.state === 'work') return `${st} at ${stop}`;
  return st;
}

export interface Step {
  tick: number;
  text: string;
}

export class FollowHistory {
  steps: Step[] = [];
  private key = '';
  private lastTick = -1;
  constructor(
    readonly agentId: number,
    private max = 5,
  ) {}

  update(s: Snapshot): void {
    if (s.tick < this.lastTick) {
      this.steps = [];
      this.key = '';
    }
    this.lastTick = s.tick;
    const a = s.agents.find((x) => x.id === this.agentId);
    if (!a) return;
    const task = a.taskId >= 0 ? s.tasks.find((t) => t.id === a.taskId) : undefined;
    const text = describe(a, task);
    const key = `${a.state}|${task?.id ?? -1}|${text}`;
    if (key === this.key) return;
    this.key = key;
    this.steps = [{ tick: s.tick, text }, ...this.steps].slice(0, this.max);
  }
}
