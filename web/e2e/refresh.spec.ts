import { expect, test, type APIRequestContext } from '@playwright/test'
import { login, MOCKDAV_URL, monthGrid } from './helpers'

const TITLE = 'E2E Changed elsewhere'
const EVENT_URL = new URL('demo/calendars/personal/e2e-refresh.ics', MOCKDAV_URL).href
const DAV_AUTH = { Authorization: `Basic ${Buffer.from('demo:demo').toString('base64')}` }

/** Writes an event for today straight to the CalDAV server, as another app would. */
async function putElsewhere(request: APIRequestContext): Promise<void> {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//e2e//refresh//EN',
    'BEGIN:VEVENT',
    'UID:e2e-refresh',
    'DTSTAMP:20260101T000000Z',
    `DTSTART;VALUE=DATE:${day}`,
    `SUMMARY:${TITLE}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
  const res = await request.put(EVENT_URL, {
    headers: { ...DAV_AUTH, 'Content-Type': 'text/calendar' },
    data: ics,
  })
  expect(res.ok()).toBe(true)
}

test.afterEach(async ({ request }) => {
  await request.delete(EVENT_URL, { headers: DAV_AUTH })
})

test('a refresh shows what another app changed at once, by key and by button (FR-23)', async ({ page, request }) => {
  const loaded = page.waitForResponse((r) => r.url().includes('/events?') && r.ok())
  await login(page)
  await loaded

  // Within LUCID_CACHE_FRESHNESS (10 s) of that load, an ordinary load is served from the backend
  // cache: only a refresh goes past it. (Browsers send Cache-Control: no-cache with every API
  // request, so that header must not count as a refresh.)
  await putElsewhere(request)
  const weekLoaded = page.waitForResponse((r) => r.url().includes('/events?') && r.ok())
  await page.keyboard.press('w')
  expect((await weekLoaded).request().headers()['x-lucid-revalidate']).toBeUndefined()
  await expect(page.getByRole('banner').getByLabel('Loading')).toHaveCount(0)
  const main = page.getByRole('main')
  await expect(main.getByText(TITLE)).toHaveCount(0)

  const refreshed = page.waitForRequest((r) => r.url().includes('/events?'))
  await page.keyboard.press('r')
  expect((await refreshed).headers()['x-lucid-revalidate']).toBe('1')
  await expect(main.getByText(TITLE)).toBeVisible({ timeout: 5_000 })

  // A refresh that is still running ignores another.
  const refresh = page.getByRole('button', { name: 'Refresh' })
  await expect(refresh).not.toHaveAttribute('aria-busy')
  await request.delete(EVENT_URL, { headers: DAV_AUTH })
  await refresh.click()
  await expect(main.getByText(TITLE)).toHaveCount(0, { timeout: 5_000 })
})

for (const { status, code } of [
  { status: 404, code: 'not_found' }, // fails at once
  { status: 502, code: 'upstream_error' }, // retried first
]) {
  test(`a failed refresh says once which state is still shown (${status})`, async ({ page }) => {
    const loaded = page.waitForResponse((r) => r.url().includes('/events?') && r.ok())
    await login(page)
    await loaded
    const shown = monthGrid(page).locator('[data-calendar-id]')
    await expect(shown.first()).toBeVisible()
    // Every toast that shows up during the run, however briefly.
    await page.evaluate(() => {
      const seen: string[] = []
      const counted = new WeakSet<Element>()
      Object.assign(window, { seenToasts: seen })
      new MutationObserver(() => {
        for (const toast of document.querySelectorAll('[data-sonner-toast]')) {
          if (counted.has(toast)) continue
          counted.add(toast)
          seen.push(toast.textContent)
        }
      }).observe(document.body, { childList: true, subtree: true })
    })

    await page.route('**/api/v1/calendars/*/events?*', (route) =>
      route.fulfill({ status, json: { error: { code, message: 'failed' } } }),
    )
    await page.keyboard.press('r')

    await expect(page.getByText(/^Couldn't refresh\. Showing what was loaded at /)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Refresh' })).not.toHaveAttribute('aria-busy')
    const seen = await page.evaluate(() => (window as unknown as { seenToasts: string[] }).seenToasts)
    expect(seen).toEqual([expect.stringMatching(/^Couldn't refresh\. Showing what was loaded at /)])
    await expect(shown.first()).toBeVisible()
  })
}
