import { expect, test, type Locator, type Page } from '@playwright/test'
import { createTestEvent, createTestTask, deleteTestEvents, deleteTestTasks, login, monthGrid } from './helpers'

// A failed test never reaches its own clean-up; remove what the specs created.
test.afterEach(async ({ page }) => {
  await deleteTestEvents(page)
  await deleteTestTasks(page)
})

/** The list behind a "+N more" button. */
const list = (page: Page) => page.locator('[data-radix-popper-content-wrapper] [role="dialog"]')

/** Presses on `handle`, moves over `target` and stays there: the caller drops or cancels. */
async function dragOver(page: Page, handle: Locator, target: Locator): Promise<void> {
  const from = (await handle.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 4 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + 10, { steps: 8 })
}

/** Today's cell of the month grid, and the one two days before it (after it, in the first days of the grid). */
async function cellsOf(page: Page): Promise<{ today: Locator; target: Locator }> {
  const cells = monthGrid(page).getByRole('gridcell')
  const at = await cells.evaluateAll((els) => els.findIndex((el) => el.getAttribute('aria-current') === 'date'))
  return { today: cells.nth(at), target: cells.nth(at >= 2 ? at - 2 : at + 2) }
}

/** Whether the entry is in the cell, or in its "+N more" list when the cell has no room for it. */
async function expectIn(page: Page, cell: Locator, entry: (scope: Locator) => Locator): Promise<void> {
  if ((await entry(cell).count()) === 0) {
    await cell.getByRole('button', { name: /^\d+ more, / }).click()
    await expect(entry(list(page))).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(list(page)).toHaveCount(0)
  } else {
    await expect(entry(cell)).toBeVisible()
  }
}

/** `count` events on `day`, "E2E overflow <stamp> <prefix><n>", an hour long from 10:00. */
async function addEvents(page: Page, stamp: number, day: Date, count: number, prefix = ''): Promise<void> {
  for (let i = 0; i < count; i++) {
    const start = new Date(day)
    start.setHours(10, i, 0, 0)
    const end = new Date(start.getTime() + 3600_000)
    await createTestEvent(page, { title: `E2E overflow ${stamp} ${prefix}${i}`, start: start.toISOString(), end: end.toISOString() })
  }
}

/** The month view of a reloaded page. */
async function openMonth(page: Page): Promise<void> {
  await page.reload()
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
  await page.keyboard.press('m')
}

/** Today with 8 events and a task, opened in the month view; `fixed` is the day the page takes for today. */
async function busyDay(page: Page, stamp: number, fixed?: Date): Promise<void> {
  if (fixed) await page.clock.setFixedTime(fixed)
  await login(page)
  const today = fixed ?? new Date()
  await addEvents(page, stamp, today, 8)
  const due = new Date(today)
  due.setHours(15, 0, 0, 0)
  await createTestTask(page, { title: `E2E overflowtask ${stamp}`, due: due.toISOString(), dueAllDay: false })
  await openMonth(page)
}

test('drag an event and a task out of the "+N more" list', async ({ page }) => {
  const stamp = Date.now()
  await busyDay(page, stamp)
  const { today, target } = await cellsOf(page)
  const more = today.getByRole('button', { name: /^\d+ more, / })
  const event = (scope: Locator, n = 7) => scope.locator('[data-event-key]', { hasText: `E2E overflow ${stamp} ${n}` })
  const task = (scope: Locator) => scope.locator('[data-task-key]', { hasText: `E2E overflowtask ${stamp}` })

  // An event out of the list: the list is hidden while it is dragged, and gone once it is dropped.
  await more.click()
  await expect(list(page)).toBeVisible()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await expect(event(list(page))).toBeVisible()
  await dragOver(page, event(list(page)), target)
  await expect(list(page)).toHaveCSS('visibility', 'hidden')
  await page.mouse.up()
  await expect(list(page)).toHaveCount(0)
  await expectIn(page, target, (scope) => event(scope))

  // A later click opens the list again: no click was swallowed.
  await more.click()
  await expect(list(page)).toBeVisible()

  // A task out of the list, by its title.
  const handle = task(list(page)).locator('button:not([role="checkbox"])')
  await expect(handle).toBeVisible()
  await dragOver(page, handle, target)
  await expect(list(page)).toHaveCSS('visibility', 'hidden')
  await page.mouse.up()
  await expect(list(page)).toHaveCount(0)
  await expectIn(page, target, task)

  // Escape during a drag cancels it: the entry stays, and the list is closed.
  await more.click()
  await expect(list(page)).toBeVisible()
  await dragOver(page, event(list(page), 6), target)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(list(page)).toHaveCount(0)
  await more.click()
  await expect(event(list(page), 6)).toBeVisible()
})

test('switch the "+N more" list to a neighbouring day, and close it with a second click', async ({ page }) => {
  const stamp = Date.now()
  await login(page)
  const today = new Date()
  // The next day, on a Saturday the one before: the grid's rows end there.
  const step = today.getDay() === 6 ? -1 : 1
  const other = new Date(today)
  other.setDate(today.getDate() + step)
  await addEvents(page, stamp, today, 8, 'a')
  await addEvents(page, stamp, other, 8, 'b')
  await openMonth(page)
  const cells = monthGrid(page).getByRole('gridcell')
  const at = await cells.evaluateAll((els) => els.findIndex((el) => el.getAttribute('aria-current') === 'date'))
  const first = cells.nth(at).getByRole('button', { name: /^\d+ more, / })
  const second = cells.nth(at + step).getByRole('button', { name: /^\d+ more, / })
  const entry = (n: string) => list(page).locator('[data-event-key]', { hasText: `E2E overflow ${stamp} ${n}` })

  await first.click()
  await expect(entry('a7')).toBeVisible()
  await expect(first).toHaveAttribute('aria-expanded', 'true')

  // Another day's button takes over the list instead of closing it.
  await second.click()
  await expect(entry('b7')).toBeVisible()
  await expect(entry('a7')).toHaveCount(0)
  await expect(first).toHaveAttribute('aria-expanded', 'false')
  await expect(second).toHaveAttribute('aria-expanded', 'true')

  await second.click()
  await expect(list(page)).toHaveCount(0)
  await expect(second).toHaveAttribute('aria-expanded', 'false')
})

// The keyboard drag out of the list (FR-10, NFR-27): the list hides, as for a pointer, and the drag goes on although
// the hidden list drops the focus. The row stays where the list put it, not in its own day's cell, so the arrows
// move on from there: dnd-kit says where the entry would land, and the drop lands there. On some days the row has
// no day beyond it, so the page takes a Wednesday for today.
test('drag an event out of the "+N more" list with the keyboard', async ({ page }) => {
  const stamp = Date.now()
  await busyDay(page, stamp, new Date(2026, 9, 21, 12))
  const { today } = await cellsOf(page)
  const more = today.getByRole('button', { name: /^\d+ more, / })
  const event = (scope: Locator) => scope.locator('[data-event-key]', { hasText: `E2E overflow ${stamp} 7` })
  const said = page.locator('[role="status"][aria-live="assertive"]')

  await more.click()
  await event(list(page)).focus()
  await page.keyboard.press('Space')
  await expect(list(page)).toHaveCSS('visibility', 'hidden')
  await expect(said).toContainText('New time:')
  const before = await said.textContent()
  await page.keyboard.press('ArrowRight')
  await expect(said).not.toHaveText(before ?? '')
  const date = /New time: (\w+ \d+\w+, \d{4})/.exec((await said.textContent()) ?? '')?.[1]
  expect(date).toBeDefined()
  await page.keyboard.press('Space')

  await expect(list(page)).toHaveCount(0)
  await expect(more).toBeFocused()
  await expectIn(page, monthGrid(page).getByRole('gridcell', { name: new RegExp(date ?? '') }), event)
})
