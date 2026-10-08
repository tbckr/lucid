import { expect, test, type Page } from '@playwright/test'
import { calendarId, deleteTestTasks, login, monthGrid } from './helpers'

/** The task sidebar; tasks with a date also appear in the calendar views. */
const taskList = (page: Page) => page.getByTestId('tasks-list')

/**
 * The seeded tasks in the month grid that don't repeat, whichever fall into it: they are
 * dated relative to today. A repeating one, marked by its ⟳ image, moves on to its next
 * repeat when completed and keeps the completed one as a task of its own (FR-17). A task
 * detached from a series carries the same image, named for that, but no longer repeats, so
 * it counts as single. A chip too narrow for the mark hides it, so match the element rather
 * than the visible role.
 */
const singleTasks = (page: Page) =>
  monthGrid(page)
    .locator('[data-task-key]')
    .filter({ hasNot: page.locator('[role="img"]:not([aria-label="Detached from its series"])') })

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
  await page.getByRole('button', { name: 'Edit task: Buy milk' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit task' })
  await expect(dialog.getByRole('textbox', { name: 'Checklist item 1' })).toHaveValue('2 liters')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})

test('rename a task and move its due date in the list', async ({ page }) => {
  await login(page)
  const title = `E2E inline ${Date.now()}`
  const renamed = `${title} renamed`
  const row = (name: string) =>
    taskList(page).getByTestId('task-row').filter({ has: page.getByRole('checkbox', { name: `Completed: ${name}` }) })
  await page.getByRole('textbox', { name: 'Add task' }).fill(title)
  await page.keyboard.press('Enter')

  const field = row(title).getByRole('textbox', { name: 'Title' })
  await field.click()
  await field.press('End')
  await field.pressSequentially(' renamed')
  await field.press('Enter')
  await expect(field).toBeFocused()
  await expect(row(renamed)).toBeVisible()

  await row(renamed).getByRole('button', { name: `Change due date: ${renamed}` }).click()
  const picker = page.getByRole('dialog', { name: 'Due date' })
  await picker.getByRole('button', { name: /^Tomorrow / }).click()
  await expect(picker).toBeHidden()
  // Dated now, so the task also shows in the calendar.
  const inGrid = monthGrid(page).locator('[data-task-key]', { hasText: renamed })
  await expect(inGrid).toBeVisible()

  // Persisted on the server.
  await page.reload()
  await expect(row(renamed)).toBeVisible()
  await expect(inGrid).toBeVisible()
})

test('delete a completed task from the list', async ({ page }) => {
  await login(page)
  const title = `E2E done ${Date.now()}`
  const box = taskList(page).getByRole('checkbox', { name: `Completed: ${title}` })
  await page.getByRole('textbox', { name: 'Add task' }).fill(title)
  await page.keyboard.press('Enter')
  await box.click()
  await expect(box).toHaveAttribute('aria-checked', 'true')

  await taskList(page).getByRole('button', { name: `Delete task: ${title}` }).click()
  const ask = page.getByRole('alertdialog', { name: 'Delete this task?' })
  await ask.getByRole('button', { name: 'Delete task' }).click()
  await expect(ask).toBeHidden()
  await expect(box).toHaveCount(0)

  // Deleted on the server.
  await page.reload()
  await expect(taskList(page).getByRole('checkbox', { name: 'Completed: Buy milk' })).toBeVisible()
  await expect(box).toHaveCount(0)
})

test('complete a task in the month view', async ({ page }) => {
  await login(page)
  const inGrid = singleTasks(page).getByRole('checkbox').first()
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
  const first = monthGrid(page).locator('[data-task-key]').first()
  await expect(first).toBeVisible()
  const title = ((await first.getByRole('checkbox').getAttribute('aria-label')) ?? '').replace(/^Completed: /, '')
  // That task, by its title: the repeats of a series can come in after the other tasks, ahead of it.
  const inGrid = monthGrid(page)
    .locator('[data-task-key]')
    .filter({ has: page.getByRole('checkbox', { name: `Completed: ${title}`, exact: true }) })
    .first()
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
  const inGrid = singleTasks(page).getByRole('checkbox').first()
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

test('dragging a task in the day view moves its due time', async ({ page }) => {
  const title = `E2E drag task ${Date.now()}`
  // 1 PM keeps the pointer away from the edges, where dnd-kit auto-scrolls.
  const popover = await newTaskAt(page, '1:00 PM')
  await popover.getByPlaceholder('Add a title').fill(title)
  await popover.getByRole('button', { name: 'Create task' }).click()
  await expect(popover).toBeHidden()
  const block = page.getByRole('main').locator('[data-task-key]', { hasText: title })
  await expect(block).toContainText('1 PM')

  // Down one hour (48 px) by the title, clear of the checkbox: the dragged copy shows the
  // new time, and so does the saved task.
  const box = (await block.getByRole('button', { name: new RegExp(title) }).boundingBox())!
  const x = box.x + box.width * 0.75
  await page.mouse.move(x, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, box.y + box.height / 2 + 10, { steps: 4 })
  await page.mouse.move(x, box.y + box.height / 2 + 48, { steps: 4 })
  await expect(block.filter({ hasText: '2 PM' })).toHaveCount(1)
  await page.mouse.up()
  await expect(block).toHaveCount(1)
  await expect(block).toContainText('2 PM')

  // Persisted on the server.
  await page.reload()
  await expect(block).toContainText('2 PM')
})

test('dragging a task in the month view moves its due date', async ({ page }) => {
  await login(page)
  const title = `E2E drag day ${Date.now()}`
  await page.getByRole('textbox', { name: 'Add task' }).fill(title)
  await page.keyboard.press('Enter')
  const row = taskList(page).getByTestId('task-row').filter({ has: page.getByRole('checkbox', { name: `Completed: ${title}` }) })
  await row.getByRole('button', { name: `Change due date: ${title}` }).click()
  const picker = page.getByRole('dialog', { name: 'Due date' })
  await picker.getByRole('button', { name: /^Today / }).click()
  await expect(picker).toBeHidden()

  // To the next day, or the one before when today ends the grid.
  const cells = monthGrid(page).getByRole('gridcell')
  const today = await cells.evaluateAll((els) => els.findIndex((el) => el.getAttribute('aria-current') === 'date'))
  const target = cells.nth(today + 1 < (await cells.count()) ? today + 1 : today - 1)
  const inTarget = target.locator('[data-task-key]', { hasText: title })
  const handle = cells.nth(today).locator('[data-task-key]', { hasText: title }).getByRole('button', { name: new RegExp(title) })
  const from = (await handle.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 4 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(inTarget).toBeVisible()
  await expect(cells.nth(today).locator('[data-task-key]', { hasText: title })).toHaveCount(0)

  // Persisted on the server.
  await page.reload()
  await expect(inTarget).toBeVisible()
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

test('"c" creates a task through the switch in the editor', async ({ page }) => {
  const title = `E2E from c ${Date.now()}`
  await login(page)
  await page.keyboard.press('c')
  const editor = page.getByRole('dialog', { name: 'New event' })
  await expect(editor.getByPlaceholder('Add a title')).toBeFocused()
  await editor.getByPlaceholder('Add a title').fill(title)
  // Measure once the dialog has finished zooming in.
  await editor.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  const before = await editor.getByRole('radio', { name: 'Task' }).boundingBox()

  await editor.getByRole('radio', { name: 'Task' }).click()
  const task = page.getByRole('dialog', { name: 'New task' })
  await expect(task.getByPlaceholder('Add a title')).toHaveValue(title)
  await expect(task.getByRole('radio', { name: 'Task' })).toBeFocused()
  // The dialog keeps its top: the switch stays under the pointer.
  expect(await task.getByRole('radio', { name: 'Task' }).boundingBox()).toEqual(before)

  await task.getByRole('button', { name: 'Create task' }).click()
  await expect(task).toBeHidden()
  await expect(taskList(page)).toContainText(title)
})
