import type { FpHooks } from './hooks.ts';

declare global {
  interface Window {
    __fp?: FpHooks;
  }
}
export {};
