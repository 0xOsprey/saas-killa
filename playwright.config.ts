import { defineConfig, devices } from '@playwright/test';

const PORT = 9143;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// The seeded fixture and the auth spec both expect the bootstrap organizer to
// be at this address. Pin it so the suite is not hostage to .env.local.
process.env.BOOTSTRAP_ORGANIZER_EMAIL = process.env.BOOTSTRAP_ORGANIZER_EMAIL ?? 'organizer@example.com';

// Keep the suite away from a live Resend key. Magic links and notifications must
// be written to .mail/ for tests to read and assert on.
process.env.RESEND_API_KEY = '';
process.env.MAIL_NOTIFICATIONS = 'off';

/**
 * The suite runs against a production build on its own port, not the dev
 * server on 9140, so a `pnpm dev` you have open in another terminal does not
 * collide with a test run and the code under test is the code that deploys.
 *
 * Not 9141 either: that is the dev mail inbox, the thing you sign in through.
 * `reuseExistingServer` is false, so a run would try to bind a port the inbox
 * already holds and fail to start its own server at all.
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
    env: {
      APP_URL: BASE_URL,
      BOOTSTRAP_ORGANIZER_EMAIL: process.env.BOOTSTRAP_ORGANIZER_EMAIL,
      RESEND_API_KEY: '',
      MAIL_NOTIFICATIONS: 'off',
    },
    // Server-side exceptions reach the browser as an opaque digest. Piping the
    // server's own output is the only way a failing run shows the stack that
    // caused it.
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
