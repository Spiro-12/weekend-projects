import type { RunResult, Scenario } from '../../contracts/types.ts';

export interface EvaluateOptions {
  /** Measure capacity: orders.mode = 'saturate'. */
  saturate?: boolean;
}

/** The single source of numbers (PLAN §4): tiles, money, compare and sweep all call evaluate(). */
export interface Runner {
  readonly kind: 'fake' | 'worker' | 'inline';
  evaluate(s: Scenario, opts?: EvaluateOptions): Promise<RunResult>;
  /** Cached result for these settings, if any. */
  peek(s: Scenario, opts?: EvaluateOptions): RunResult | undefined;
  dispose(): void;
}
