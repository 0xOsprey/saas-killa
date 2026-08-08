import { defineConfig, devices } from '@playwright/test';

const PORT = 9141;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * The suite runs against a production build on its own port, not the dev
 * server on 9140, so a `pnpm dev` you have open in another terminal does not
 * collide with a test run and the code under test is the code that deploys.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next start -H 127.0.0.1 -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { APP_URL: BASE_URL },
    // Server-side exceptions reach the browser as an opaque digest. Piping the
    // server's own output is the only way a failing run shows the stack that
    // caused it.
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
