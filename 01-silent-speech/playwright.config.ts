import { defineConfig, devices } from '@playwright/test';

export const BASE = 'http://localhost:4173/weekend-projects/01-silent-speech/';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  reporter: 'list',
  use: { baseURL: BASE, ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: 'npm run build && npm run preview',
      url: BASE,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npx tsx tests/mock-bridge.ts --port 8765',
      port: 8765,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
