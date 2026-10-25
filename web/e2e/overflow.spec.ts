import { expect, test, type Locator, type Page } from '@playwright/test'
import { createTestEvent, createTestTask, deleteTestEvents, deleteTestTasks, login, monthGrid } from './helpers'

// A failed test never reaches its own clean-up; remove what the specs created.
test.afterEach(async ({ page }) => {
  await deleteTestEvents(page)
  await deleteTestTasks(page)
})

/** The list behind a "+N more" button or a bundle. */
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

/** "+N more", which holds the events a cell has no room for. */
const MORE = /^\d+ more, /
/** The bundle, which holds the tasks a cell has no room for (FR-07). */
const BUNDLE = /^\d+ tasks, /

/** Whether the entry is in the cell, or in the list of its `holder` (an event's "+N more") when the cell has no room for it. */
async function expectIn(page: Page, cell: Locator, entry: (scope: Locator) => Locator, holder = MORE): Promise<void> {
  if ((await entry(cell).count()) === 0) {
    await cell.getByRole('button', { name: holder }).click()
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

/**
 * Today with 8 events and two tasks, "E2E overflowtask <stamp> <n>" due at 15:00 and 16:00, opened in the month
 * view; `fixed` is the day the page takes for today. The tasks share a bundle, the events beyond its room "+N more".
 */
async function busyDay(page: Page, stamp: number, fixed?: Date): Promise<void> {
  if (fixed) await page.clock.setFixedTime(fixed)
  await login(page)
  const today = fixed ?? new Date()
  await addEvents(page, stamp, today, 8)
  for (const n of [0, 1]) {
    const due = new Date(today)
    due.setHours(15 + n, 0, 0, 0)
    await createTestTask(page, { title: `E2E overflowtask ${stamp} ${n}`, due: due.toISOString(), dueAllDay: false })
  }
  await openMonth(page)
}

test('drag an event out of the "+N more" list and a task out of its bundle', async ({ page }) => {
  const stamp = Date.now()
  await busyDay(page, stamp)
  const { today, target } = await cellsOf(page)
  const more = today.getByRole('button', { name: MORE })
  const bundle = today.getByRole('button', { name: BUNDLE })
  const event = (scope: Locator, n = 7) => scope.locator('[data-event-key]', { hasText: `E2E overflow ${stamp} ${n}` })
  const task = (scope: Locator, n = 0) => scope.locator('[data-task-key]', { hasText: `E2E overflowtask ${stamp} ${n}` })

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

  // A later click opens the list again: no click was swallowed. It holds events only (FR-07).
  await more.click()
  await expect(list(page)).toBeVisible()
  await expect(event(list(page), 6)).toBeVisible()
  await expect(list(page).locator('[data-task-key]')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(list(page)).toHaveCount(0)

  // A task out of its bundle's list, by its title.
  await bundle.click()
  await expect(bundle).toHaveAttribute('aria-expanded', 'true')
  const handle = task(list(page)).locator('button:not([role="checkbox"])')
  await expect(handle).toBeVisible()
  await dragOver(page, handle, target)
  await expect(list(page)).toHaveCSS('visibility', 'hidden')
  await page.mouse.up()
  await expect(list(page)).toHaveCount(0)
  await expectIn(page, target, task, BUNDLE)

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
  const first = cells.nth(at).getByRole('button', { name: MORE })
  const second = cells.nth(at + step).getByRole('button', { name: MORE })
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

test('bundle a busy hour in the week and drag a task out of it', async ({ page }) => {
  const stamp = Date.now()
  // A morning: 8:30 UTC is 9:30 or 10:30 in Berlin, the time zone of the config, the same day either way.
  const morning = new Date()
  morning.setUTCHours(8, 30, 0, 0)
  await page.clock.setFixedTime(morning)
  await login(page)
  await page.keyboard.press('w')
  // Today at 9:00, 9:30, 10:00 and 11:00 in the browser's time zone, as the server writes times.
  const [nine, nineThirty, ten, eleven] = await page.evaluate(() =>
    [
      [9, 0],
      [9, 30],
      [10, 0],
      [11, 0],
    ].map(([h, m]) => {
      const d = new Date()
      d.setHours(h ?? 0, m, 0, 0)
      return d.toISOString()
    }),
  )
  await createTestEvent(page, { title: `E2E overflow ${stamp} sync`, start: nine!, end: ten! })
  await createTestEvent(page, { title: `E2E overflow ${stamp} panel`, start: nineThirty!, end: eleven! })
  for (const n of [0, 1, 2]) {
    await createTestTask(page, { title: `E2E overflowtask ${stamp} ${n}`, due: nine!, dueAllDay: false })
  }
  await page.reload()
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
  await page.keyboard.press('w')

  // At 1280 px with both sidebars, a week column has room for one event per time beside the bundle (FR-07).
  const bundle = page.getByRole('button', { name: /^3 tasks at 9:00 AM/ })
  await expect(bundle).toBeVisible()
  const task = (scope: Locator, n: number) => scope.locator('[data-task-key]', { hasText: `E2E overflowtask ${stamp} ${n}` })
  await expect(task(page.getByRole('main'), 0)).toHaveCount(0)

  // Ticked off in the list, a task stays there, checked.
  await bundle.click()
  await expect(list(page)).toBeVisible()
  const done = list(page).getByRole('checkbox', { name: `Completed: E2E overflowtask ${stamp} 0` })
  await done.click()
  await expect(done).toBeChecked()
  await expect(list(page)).toBeVisible()

  // Dragged out onto the next day's column (the one before on the week's last day), its tile's top at 2 PM.
  const columns = page.getByRole('button', { name: /^New event at .* 12:00 AM$/ })
  await expect(columns).toHaveCount(7)
  const at = await bundle.evaluate((el) => Array.from(el.parentElement?.parentElement?.children ?? []).indexOf(el.parentElement!) - 1)
  const other = columns.nth(at + (morning.getDay() === 6 ? -1 : 1)).locator('..')
  const row = task(list(page), 1)
  const tile = (await row.boundingBox())!
  const from = (await row.locator('button:not([role="checkbox"])').boundingBox())!
  const column = (await other.boundingBox())!
  const grab = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + 10, grab.y, { steps: 4 })
  await page.mouse.move(column.x + column.width / 2, column.y + 14 * 48 + (grab.y - tile.y), { steps: 8 })
  await expect(list(page)).toHaveCSS('visibility', 'hidden')
  await page.mouse.up()
  await expect(list(page)).toHaveCount(0)

  const moved = task(other, 1)
  await expect(moved).toBeVisible()
  await expect(moved.locator('button:not([role="checkbox"])')).toHaveAccessibleName(`E2E overflowtask ${stamp} 1, 2 PM`)
})

// The keyboard drag out of the list (FR-10, NFR-27): the list hides, as for a pointer, and the drag goes on although
// the hidden list drops the focus. The row stays where the list put it, not in its own day's cell, so the arrows
// move on from there: dnd-kit says where the entry would land, and the drop lands there. On some days the row has
// no day beyond it, so the page takes a Wednesday for today.
test('drag an event out of the "+N more" list with the keyboard', async ({ page }) => {
  const stamp = Date.now()
  await busyDay(page, stamp, new Date(2026, 9, 21, 12))
  const { today } = await cellsOf(page)
  const more = today.getByRole('button', { name: MORE })
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
