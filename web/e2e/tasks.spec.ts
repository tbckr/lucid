import { expect, test, type Page } from '@playwright/test'
import { calendarId, deleteTestTasks, login, monthGrid } from './helpers'

/** The task sidebar; tasks with a date also appear in the calendar views. */
const taskList = (page: Page) => page.getByTestId('tasks-list')

// A failed test never reaches its own clean-up; remove the tasks the specs created.
test.afterEach(async ({ page }) => {
  await deleteTestTasks(page)
})

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
  // Whichever seeded task falls into the grid: they are dated relative to today.
  const inGrid = monthGrid(page).locator('[data-task-key]').getByRole('checkbox').first()
  await expect(inGrid).toBeVisible()
  const name = (await inGrid.getAttribute('aria-label')) ?? ''
  const inList = taskList(page).getByRole('checkbox', { name, exact: true })
  await expect(inList).toHaveAttribute('aria-checked', 'false')
  await inGrid.click()
  await expect(inList).toHaveAttribute('aria-checked', 'true')

  // Restore the seed state for other runs.
  await inList.click()
  await expect(inGrid).toHaveAttribute('aria-checked', 'false')
})

test('a task in the month view opens its details, and the editor from there', async ({ page }) => {
  await login(page)
  const inGrid = monthGrid(page).locator('[data-task-key]').first()
  await expect(inGrid).toBeVisible()
  const title = ((await inGrid.getByRole('checkbox').getAttribute('aria-label')) ?? '').replace(/^Completed: /, '')
  await inGrid.getByRole('button').click()

  const details = page.getByRole('dialog', { name: title })
  await expect(details.getByRole('heading', { name: title })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Edit task' })).toHaveCount(0)

  await details.getByRole('button', { name: 'Edit task' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await expect(editor.getByRole('textbox', { name: 'Title' })).toHaveValue(title)
  await expect(details).toBeHidden()
  await editor.getByRole('button', { name: 'Cancel' }).click()
  await expect(editor).toBeHidden()
})

test('a completed task leaves the calendar when completed tasks are hidden there', async ({ page }) => {
  await login(page)
  const inGrid = monthGrid(page).locator('[data-task-key]').getByRole('checkbox').first()
  await expect(inGrid).toBeVisible()
  const name = (await inGrid.getAttribute('aria-label')) ?? ''
  const task = monthGrid(page).getByRole('checkbox', { name, exact: true })

  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const hide = dialog.getByRole('switch', { name: /Hide in calendar/ })
  await hide.click()
  await expect(hide).toHaveAttribute('aria-checked', 'true')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(task).toBeVisible()

  await task.click()
  await expect(task).toHaveCount(0)
  const inList = taskList(page).getByRole('checkbox', { name, exact: true })
  await expect(inList).toHaveAttribute('aria-checked', 'true')

  // Reopened tasks come back; this also restores the seed state for other runs.
  await inList.click()
  await expect(task).toHaveAttribute('aria-checked', 'false')
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
  await expect(page.getByTestId('agenda').locator('[data-task-key]').getByRole('checkbox').first()).toBeVisible()
})

/** Open the create popover at `hour` today in the day view and switch it to a task. */
async function newTaskAt(page: Page, hour: string) {
  await login(page)
  await page.keyboard.press('d')
  await page.getByRole('button', { name: new RegExp(` ${hour}$`) }).click({ position: { x: 20, y: 4 } })
  await page.getByRole('dialog', { name: 'New event' }).getByRole('radio', { name: 'Task' }).click()
  return page.getByRole('dialog', { name: 'New task' })
}

test('create a task from a click in the day view', async ({ page }) => {
  const title = `E2E task ${Date.now()}`
  const popover = await newTaskAt(page, '3:00 PM')
  await expect(popover.getByText('Due', { exact: true })).toBeVisible()
  await popover.getByPlaceholder('Add a title').fill(title)
  await popover.getByRole('button', { name: 'Create task' }).click()
  await expect(popover).toBeHidden()

  // A point at its due time in the grid, and in the list under its day.
  const block = page.getByRole('main').locator('[data-task-key]', { hasText: title })
  await expect(block).toBeVisible()
  await expect(block).toContainText('3 PM')
  await expect(taskList(page)).toContainText(title)
})

test("more options opens the task editor with the popover's values", async ({ page }) => {
  const title = `E2E more ${Date.now()}`
  const popover = await newTaskAt(page, '4:00 PM')
  await popover.getByPlaceholder('Add a title').fill(title)
  await popover.getByRole('button', { name: 'More options' }).click()

  const editor = page.getByRole('dialog', { name: 'New task' })
  await expect(editor.getByPlaceholder('Add a title')).toHaveValue(title)
  await expect(editor.getByRole('button', { name: /^Due / })).toBeVisible()
  await editor.getByRole('button', { name: 'Create task' }).click()
  await expect(editor).toBeHidden()
  await expect(page.getByRole('main').locator('[data-task-key]', { hasText: title })).toBeVisible()
})
