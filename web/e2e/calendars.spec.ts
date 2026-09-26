import { expect, test } from '@playwright/test'
import { calendarId, login, monthGrid } from './helpers'

test('hiding a calendar removes its events and persists', async ({ page }) => {
  await login(page)
  const work = await calendarId(page, 'Work')
  const workEvents = monthGrid(page).locator(`[data-calendar-id="${work}"]`)
  await expect(workEvents.first()).toBeVisible()

  await page.locator('label', { hasText: 'Work' }).click()
  await expect(workEvents).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
  await expect(page.getByTestId(`calendar-toggle-${work}`)).not.toBeChecked()
  await expect(monthGrid(page).locator(`[data-calendar-id="${work}"]`)).toHaveCount(0)

  await page.locator('label', { hasText: 'Work' }).click()
  await expect(workEvents.first()).toBeVisible()
})
