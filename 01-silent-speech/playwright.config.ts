import { defineConfig, devices } from '@playwright/test';

// Ports come from env so parallel agents (separate worktrees) don't collide.
// Each track brief assigns its own pair. Servers are never reused, so a test can't
// accidentally hit another worktree's build or the real Mac app on 8765.
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
export const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 18765);
export const BASE = `http://localhost:${WEB_PORT}/weekend-projects/01-silent-speech/`;
/** Use in specs: page.goto(`./?mode=live&ws=${MOCK_WS}`) */
export const MOCK_WS = `ws://127.0.0.1:${MOCK_PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: BASE, ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: `npm run build && npx vite preview --port ${WEB_PORT} --strictPort`,
      url: BASE,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npx tsx tests/mock-bridge.ts --port ${MOCK_PORT} --allow-origin http://localhost:${WEB_PORT}`,
      port: MOCK_PORT,
      reuseExistingServer: false,
    },
  ],
});
