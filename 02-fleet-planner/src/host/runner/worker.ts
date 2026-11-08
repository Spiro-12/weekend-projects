// Runner worker: runs one scenario per message. The data files are bundled into the worker.
import agents from '../../../data/agents.json';
import type { AgentsFile, LayoutFile, RunResult, Scenario } from '../../contracts/types.ts';
import { basicRecorder } from './basic-recorder.ts';
import { runScenario } from './run.ts';

const layouts = Object.fromEntries(
  Object.values(import.meta.glob<{ default: LayoutFile }>('../../../data/layouts/*.json', { eager: true })).map((m) => [m.default.id, m.default]),
);

export interface RunRequest {
  id: number;
  scenario: Scenario;
  saturate?: boolean;
}
export type RunReply = { id: number; ok: true; result: RunResult } | { id: number; ok: false; error: string };

// Typed view of the worker global, without pulling the WebWorker lib into the DOM build.
const ctx = self as unknown as { onmessage: ((e: MessageEvent<RunRequest>) => void) | null; postMessage(m: RunReply): void };

ctx.onmessage = (e: MessageEvent<RunRequest>) => {
  const { id, scenario, saturate } = e.data;
  try {
    const result = runScenario(scenario, { agents: agents as AgentsFile, layout: layouts[scenario.layout] }, basicRecorder, { saturate });
    ctx.postMessage({ id, ok: true, result });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String(err) });
  }
};
