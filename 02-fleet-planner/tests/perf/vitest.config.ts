// Harness self-tests, kept apart from the lead-owned root vitest.config.ts (its projects only include tests/unit and
// tests/golden). Run: npx vitest run --config tests/perf/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/perf/**/*.test.ts'], environment: 'node', root: new URL('../..', import.meta.url).pathname },
});
