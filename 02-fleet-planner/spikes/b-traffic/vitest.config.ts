import { defineConfig } from 'vitest/config';

// Spike b's own tests: npx vitest run -c spikes/b-traffic/vitest.config.ts
export default defineConfig({
  test: { include: ['spikes/b-traffic/tests/**/*.test.ts'], environment: 'node', testTimeout: 120_000 },
});
