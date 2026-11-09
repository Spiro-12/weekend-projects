import { defineConfig, devices } from '@playwright/test';

// Ports come from env so parallel tracks (separate worktrees) don't collide. Each brief assigns one (PLAN §8).
// The server is never reused, so a test can't hit another worktree's build. It serves dist/ gzipped like Pages.
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5180);
export const BASE = `http://localhost:${WEB_PORT}/weekend-projects/02-fleet-planner/`;
// Linux CI has no GPU: let Chromium's WebGL fall back to SwiftShader (fps there is meaningless; budgets use counts).
const gl = process.env.CI ? { launchOptions: { args: ['--enable-unsafe-swiftshader'] } } : {};

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  // CI (macOS runner, 3 cores): two browsers at a time. Locally one, so other work on the Mac doesn't skew timings.
  workers: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  projects: [
    // New headless Chromium uses the real GPU on a Mac (SwiftShader on Linux CI).
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium', viewport: { width: 1440, height: 900 }, ...gl }, testIgnore: /determinism/ },
    // The same sim must give the same hash in every engine (PROTOCOL §8).
    { name: 'det-chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium', ...gl }, testMatch: /determinism/ },
    { name: 'det-firefox', use: { ...devices['Desktop Firefox'] }, testMatch: /determinism/ },
    { name: 'det-webkit', use: { ...devices['Desktop Safari'] }, testMatch: /determinism/ },
  ],
  use: { baseURL: BASE },
  webServer: {
    command: `npm run build && npx tsx scripts/serve-gz.ts dist ${WEB_PORT}`,
    url: BASE,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
