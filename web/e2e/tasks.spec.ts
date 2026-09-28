import { expect, test, type Page } from '@playwright/test'
import { calendarId, login, monthGrid } from './helpers'

/** The task sidebar; tasks with a date also appear in the calendar views. */
const taskList = (page: Page) => page.getByTestId('tasks-list')

test('complete and reopen a task', async ({ page }) => {
  await login(page)
  const box = taskList(page).getByRole('checkbox', { name: 'Completed: Buy milk' })
  await expect(box).toHaveAttribute('aria-checked', 'false')

  await box.click()
  await expect(box).toHaveAttribute('aria-checked', 'true')

  // Persisted on the server.
  await page.reload()
  await expect(box).toHaveAttribute('aria-checked', 'true')

  // Restore the seed state for other runs.
  await box.click()
  await expect(box).toHaveAttribute('aria-checked', 'false')
})

test('checklist items are shown and editable', async ({ page }) => {
  await login(page)
  await page.getByTestId('task-row').filter({ hasText: 'Buy milk' }).getByRole('button', { name: /Buy milk/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit task' })
  await expect(dialog.getByRole('textbox', { name: 'Checklist item 1' })).toHaveValue('2 liters')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})

test('complete a task in the month view', async ({ page }) => {
  await login(page)
  const inGrid = monthGrid(page).getByRole('checkbox', { name: 'Completed: Buy milk' })
  const inList = taskList(page).getByRole('checkbox', { name: 'Completed: Buy milk' })
  await inGrid.click()
  await expect(inList).toHaveAttribute('aria-checked', 'true')

  // Restore the seed state for other runs.
  await inList.click()
  await expect(inGrid).toHaveAttribute('aria-checked', 'false')
})

test('hiding a task calendar in the sidebar keeps its tasks', async ({ page }) => {
  await login(page)
  const tasks = await calendarId(page, 'Tasks')
  await expect(monthGrid(page).locator(`[data-calendar-id="${tasks}"]`).first()).toBeVisible()
  await page.locator('label').filter({ has: page.getByTestId(`calendar-toggle-${tasks}`) }).click()
  await expect(page.getByTestId(`calendar-toggle-${tasks}`)).not.toBeChecked()
  await expect(monthGrid(page).locator(`[data-calendar-id="${tasks}"]`)).toHaveCount(0)
  await expect(taskList(page).getByRole('checkbox', { name: 'Completed: Buy milk' })).toBeVisible()
})

test('agenda lists tasks', async ({ page }) => {
  await login(page)
  await page.keyboard.press('a')
  await expect(page.getByTestId('agenda').getByRole('checkbox', { name: 'Completed: Call the landlord' })).toBeVisible()
})
