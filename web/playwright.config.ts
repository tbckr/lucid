import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests against the real Go backend and the in-memory CalDAV mock
 * (cmd/lucid-mockdav, login demo/demo). Run with `pnpm e2e`.
 *
 * On systems where Playwright's bundled browsers cannot run (e.g. NixOS), set
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE to a system Chromium.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CI = !!process.env.CI
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE

export default defineConfig({
  testDir: './e2e',
  // The mock CalDAV server keeps state in memory; run specs one after another.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:8080',
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) },
    },
  ],
  webServer: [
    {
      command: 'go run ./cmd/lucid-mockdav',
      cwd: repoRoot,
      url: 'http://127.0.0.1:5232/',
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'pipe',
    },
    {
      // Build the SPA first: the Go binary embeds web/dist.
      command: 'pnpm run build && go -C .. run ./cmd/lucid',
      url: 'http://127.0.0.1:8080/healthz',
      reuseExistingServer: !CI,
      timeout: 300_000,
      stdout: 'pipe',
      env: {
        LUCID_ADDR: '127.0.0.1:8080',
        LUCID_ALLOW_PRIVATE_NETWORKS: 'true',
        LUCID_COOKIE_INSECURE: 'true',
        // Every spec signs in; keep the login rate limit out of the way.
        LUCID_LOGIN_RATE_LIMIT_PER_MIN: '1000',
        LUCID_LOG_LEVEL: 'warn',
      },
    },
  ],
})
