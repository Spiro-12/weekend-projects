import type { FpHooks } from './hooks.ts';

declare global {
  interface Window {
    __fp?: FpHooks;
    __fpSim?: { runHash(scenarioId: string, ticks: number): string };
  }
}
export {};
