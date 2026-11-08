import { defineConfig, devices } from '@playwright/test';

// Ports come from env so parallel tracks (separate worktrees) don't collide. Each brief assigns one (PLAN §8).
// The server is never reused, so a test can't hit another worktree's build.
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5180);
export const BASE = `http://localhost:${WEB_PORT}/weekend-projects/02-fleet-planner/`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: BASE, ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  webServer: {
    command: `npm run build && npx tsx scripts/serve-gz.ts dist ${WEB_PORT}`,
    url: BASE,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
