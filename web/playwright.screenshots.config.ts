import { execFileSync } from 'node:child_process'
import { defineConfig } from '@playwright/test'
import base from './playwright.config'
import { LUCID_ADDR, MOCKDAV_ADDR, SCREENSHOT_DATE } from './screenshots/shared'

/**
 * Screenshots for the README, written to docs/screenshots. Run with
 * `just screenshots` (or `pnpm screenshots`).
 *
 * Reuses the E2E setup, but starts fresh servers on their own ports, so a
 * running `just dev` is never picked up: mockdav seeds its demo data around
 * SCREENSHOT_DATE, the browser clock is set to the same day, and the backend
 * reports a fixed version. The images only change when the UI does.
 */

// The latest release tag, or "dev" before the first release.
function latestRelease(): string {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0'], { encoding: 'utf8', stdio: 'pipe' })
      .trim()
      .replace(/^v/, '')
  } catch {
    return 'dev'
  }
}

type WebServer = Extract<NonNullable<typeof base.webServer>, unknown[]>[number]
const [mockdav, lucid] = base.webServer as [WebServer, WebServer]

export default defineConfig({
  ...base,
  testDir: './screenshots',
  retries: 0,
  use: { ...base.use, baseURL: `http://${LUCID_ADDR}` },
  // The device preset sets the viewport, so override it per project.
  projects: base.projects?.map((p) => ({
    ...p,
    use: { ...p.use, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 },
  })),
  webServer: [
    {
      ...mockdav,
      url: `http://${MOCKDAV_ADDR}/`,
      reuseExistingServer: false,
      env: { LUCID_MOCKDAV_ADDR: MOCKDAV_ADDR, LUCID_MOCKDAV_NOW: SCREENSHOT_DATE },
    },
    {
      ...lucid,
      command: `pnpm run build && go -C .. run -ldflags '-X main.version=${latestRelease()}' ./cmd/lucid`,
      url: `http://${LUCID_ADDR}/healthz`,
      reuseExistingServer: false,
      env: { ...lucid.env, LUCID_ADDR },
    },
  ],
})
