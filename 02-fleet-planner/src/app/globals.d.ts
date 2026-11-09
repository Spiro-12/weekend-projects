import type { FpHooks } from './hooks.ts';

declare global {
  interface Window {
    __fp?: FpHooks;
    __fpSim?: { runHash(scenario: string | import('../contracts/types.ts').Scenario, ticks: number): string };
  }
}
export {};
