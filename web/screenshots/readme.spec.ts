import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { MOCKDAV_ADDR, SCREENSHOT_DATE } from './shared'

const outDir = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url))

test.beforeEach(async ({ page }) => {
  // Mid-morning in Europe/Berlin (CET in March), the time zone of the base config.
  await page.clock.setFixedTime(new Date(`${SCREENSHOT_DATE}T10:00:00+01:00`))
})

async function login(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Server address').fill(`http://${MOCKDAV_ADDR}/`)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('demo')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('main').getByText('Quarterly review')).toBeVisible()
}

async function shoot(page: Page, name: string): Promise<void> {
  // No hover state from the last click, no focus ring and no selected text.
  await page.mouse.move(0, 0)
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.screenshot({ path: `${outDir}${name}.png`, animations: 'disabled', caret: 'hide' })
}

test('login', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Server address').fill('cloud.example.com')
  await page.getByLabel('Username').fill('anna')
  await page.getByLabel('Password').fill('correct horse battery staple')
  await shoot(page, 'login')
})

test('month view, light', async ({ page }) => {
  await login(page)
  await page.keyboard.press('m')
  await shoot(page, 'month-light')
})

test('week view, dark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await login(page)
  await page.keyboard.press('w')
  await shoot(page, 'week-dark')
})

test('tasks in the calendar', async ({ page }) => {
  await login(page)
  await page.keyboard.press('w')
  // Without the task sidebar, the tasks show only in the calendar: an all-day
  // bar, a block from start to due and a point at the due time. Without the
  // calendar sidebar, the columns are wide enough for their titles.
  await page.getByRole('button', { name: 'Close tasks' }).click()
  await expect(page.getByRole('complementary', { name: 'Tasks' })).toBeHidden()
  await page.getByRole('button', { name: 'Show or hide the sidebar' }).click()
  await expect(page.getByRole('heading', { name: 'Calendars' })).toBeHidden()
  await shoot(page, 'calendar-tasks')
})

test('tasks with a checklist', async ({ page }) => {
  await login(page)
  await page.getByTestId('task-row').filter({ hasText: 'Buy milk' }).getByRole('button', { name: /Buy milk/ }).click()
  await expect(page.getByRole('dialog', { name: 'Edit task' })).toBeVisible()
  await shoot(page, 'tasks')
})

test('event dialog', async ({ page }) => {
  await login(page)
  await page.getByRole('main').locator('[data-event-key]', { hasText: 'Quarterly review' }).click()
  await expect(page.getByRole('dialog', { name: 'Quarterly review' })).toBeVisible()
  await shoot(page, 'event-dialog')
})
