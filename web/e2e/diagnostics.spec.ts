import { readFile } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createTestEvent, deleteTestEvents, login, MOCKDAV_URL } from './helpers'

/*
 * The problem report (FR-36, NFR-36): a downloaded report holds no calendar contents by default, an object's
 * content goes in only after the user has shown it and ticked the box, and the login error offers the report.
 * Every spec reads the file the browser downloads: it is what leaves, not the preview.
 */

/** A title no part of a report may carry unless the user added the event's content. */
const CANARY = 'E2E zz-canary'

// A failed test never reaches its own clean-up; the event would stay on the mock for the next one.
test.afterEach(async ({ page }) => {
  await deleteTestEvents(page)
})

/** The parts of the downloaded file the specs look at; the rest of it is not their business. */
interface Report {
  format: number
  authenticated: boolean
  exchanges: { method: string; status?: number }[]
  client: { corrupted: unknown[]; objects: { source: string; skeleton: { text: string }; content?: string }[] }
}

/** Sign in, create `CANARY` today at 11:00 through the API and show it in the day view; returns its block. */
async function showCanary(page: Page): Promise<Locator> {
  await login(page)
  // Today in the browser's time zone, the one of the config. 11:00 is clear of the seeded "Standup" (9:00).
  const today = await page.evaluate(() => {
    const at = (h: number, m: number) => {
      const d = new Date()
      d.setHours(h, m, 0, 0)
      return d.toISOString()
    }
    return { start: at(11, 0), end: at(11, 30) }
  })
  await createTestEvent(page, { title: CANARY, ...today })
  // Load the events again: the title has now passed through the server's answers and the browser.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
  await page.keyboard.press('d')
  const block = page.getByRole('main').locator('[data-event-key]', { hasText: CANARY })
  await expect(block).toBeVisible()
  return block
}

function reportDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Report a problem' })
}

/** Download the report from the open dialog, once it is complete, and read the file. */
async function downloadReport(page: Page): Promise<{ text: string; report: Report }> {
  const button = reportDialog(page).getByRole('button', { name: 'Download report' })
  // Disabled while the report or an added item's structure is still loading.
  await expect(button).toBeEnabled()
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
  expect(download.suggestedFilename()).toMatch(/^lucid-report-\d{8}-\d{6}Z\.json$/)
  const text = await readFile(await download.path(), 'utf8')
  return { text, report: JSON.parse(text) as Report }
}

/** Open the details of `block` and add the event to the problem report: the dialog opens with it in the list. */
async function addToReport(page: Page, block: Locator): Promise<Locator> {
  await block.click()
  await page.getByRole('dialog', { name: CANARY }).getByRole('button', { name: 'Add to problem report' }).click()
  const dialog = reportDialog(page)
  await expect(dialog).toBeVisible()
  const row = dialog.getByRole('listitem', { name: CANARY })
  await expect(row).toBeVisible()
  return row
}

test('report from the account menu holds no contents', async ({ page }) => {
  await showCanary(page)

  await page.getByRole('button', { name: /^Account/ }).click()
  await page.getByRole('menuitem', { name: 'Report a problem' }).click()
  const dialog = reportDialog(page)
  await expect(dialog).toBeVisible()
  // No item was added: the list says how to add one, and the file shows only the server's trace.
  await expect(dialog.getByText('To add an event or task, open it and choose Add to problem report.')).toBeVisible()

  const { text, report } = await downloadReport(page)
  expect(report.format).toBe(1)
  expect(report.authenticated).toBe(true)
  expect(report.exchanges.length).toBeGreaterThan(0)
  expect(report.client.objects).toEqual([])
  expect(text).not.toContain('zz-canary')
  await expect(page.getByText('Report downloaded')).toBeVisible()
})

test('content only after consent', async ({ page }) => {
  const block = await showCanary(page)

  // Added, shown and left unticked: the file has the structure of the event and none of what it says.
  const row = await addToReport(page, block)
  const dialog = reportDialog(page)
  // No box to tick before the content was shown: nobody can agree to what they have not seen.
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  await row.getByRole('button', { name: 'Show content' }).click()
  await expect(dialog.getByRole('region', { name: CANARY })).toContainText(`SUMMARY:${CANARY}`)
  const include = dialog.getByRole('checkbox', { name: 'Add this content to the report' })
  await expect(include).not.toBeChecked()
  const sheet = dialog.getByRole('region', { name: 'The file that will be downloaded' })
  await expect(sheet).not.toContainText('zz-canary')

  const unticked = await downloadReport(page)
  expect(unticked.text).not.toContain('zz-canary')
  expect(unticked.report.client.objects).toHaveLength(1)
  expect(unticked.report.client.objects[0]).toMatchObject({ source: 'event' })
  expect(unticked.report.client.objects[0]).not.toHaveProperty('content')
  // The download clears the list of added items.
  await expect(dialog.getByText('To add an event or task, open it and choose Add to problem report.')).toBeVisible()
  await expect(row).toHaveCount(0)
  await expect(page.getByText('Report downloaded')).toBeVisible()

  // Added again after the dialog was closed: it forgot what was shown, so the content has to be shown again.
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
  const again = await addToReport(page, block)
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  await again.getByRole('button', { name: 'Show content' }).click()
  await expect(include).not.toBeChecked()
  await include.check()
  // The preview is the file: the content shows in it as soon as it is ticked.
  await expect(sheet).toContainText('zz-canary')

  const ticked = await downloadReport(page)
  expect(ticked.report.client.objects).toHaveLength(1)
  expect(ticked.report.client.objects[0]?.content).toContain(`SUMMARY:${CANARY}`)
})

test('report from the login page', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Server address').fill(MOCKDAV_URL)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('zz-wrong-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('rejected this username or password')
  await expect(alert).toContainText(/Reference: [0-9a-f]{8}/)

  await alert.getByRole('button', { name: 'Report a problem' }).click()
  const dialog = reportDialog(page)
  await expect(dialog).toBeVisible()
  // Signed out, no event or task can be added and no content shown.
  await expect(dialog.getByText('Sign in to add events or tasks.')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Show content' })).toHaveCount(0)

  const { text, report } = await downloadReport(page)
  expect(report.format).toBe(1)
  expect(report.authenticated).toBe(false)
  // The discovery the failed sign-in started, which the anonymous session's trace holds.
  expect(report.exchanges.map((e) => e.method)).toContain('PROPFIND')
  expect(report.client.objects).toEqual([])
  // Credentials are no part of a report (NFR-36).
  expect(text).not.toContain('zz-wrong-password')
})
