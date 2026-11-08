import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts', 'tests/perf/**/*.test.ts'], environment: 'node', testTimeout: 60_000 } },
      { test: { name: 'golden', include: ['tests/golden/**/*.test.ts'], environment: 'node', testTimeout: 300_000 } },
    ],
  },
});
