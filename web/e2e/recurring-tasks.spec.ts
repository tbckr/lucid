import { expect, test, type Locator, type Page } from '@playwright/test'
import { createTestTask, deleteTestTasks, login, monthGrid } from './helpers'

/*
 * Repeating tasks in the calendar views (FR-16, FR-17). The browser's clock
 * stands on the first Monday two months ahead, so every day a spec drags to
 * or from (up to four days later) shares one week row whether weeks start on
 * Sunday or Monday, that row is one of the month grid's top ones, clear of
 * the toasts at the bottom, and the seeded one-off items, all within two
 * weeks of the real today, stay out of its cells and the next row's, which
 * a spec only looks at.
 */

const DAY = 24 * 3600 * 1000

function firstMondayAhead(): Date {
  const now = new Date()
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1))
  first.setUTCDate(1 + ((8 - first.getUTCDay()) % 7))
  return first
}

/** Today in the browser, as UTC midnight: the wire form of an all-day date. */
const today = firstMondayAhead()
const day = (n: number) => new Date(today.getTime() + n * DAY)

/** A day as the toasts and labels write it, e.g. "Tue, Nov 3" (formatPickerDate). */
function short(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getUTCFullYear() === today.getUTCFullYear() ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(d)
}

/** A day's RRULE weekday, e.g. "MO". */
const byDay = (d: Date) => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getUTCDay()]!

/** The task sidebar. */
const taskList = (page: Page) => page.getByTestId('tasks-list')

/**
 * The all-day cell of `d` in the week view, found by the button that creates an event
 * there: its weekday is unique in the week.
 */
function allDay(page: Page, d: Date): Locator {
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(d)
  return page
    .getByRole('main')
    .getByRole('button', { name: new RegExp(`^New all-day event on ${weekday}, `) })
    .locator('..')
}

/** Sign in on `today`, with `task` created through the API, in the week ("w") or month ("m") view. */
async function openWith(page: Page, task: Parameters<typeof createTestTask>[1], view: 'w' | 'm'): Promise<void> {
  // 8:30 UTC is 9:30 or 10:30 in Berlin, the time zone of the config: the same day either way.
  await page.clock.setFixedTime(new Date(today.getTime() + 8.5 * 3600 * 1000))
  await login(page)
  await createTestTask(page, task)
  // The calendar loaded before the task existed.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
  await page.keyboard.press(view)
}

// A failed test never reaches its own clean-up; this also removes the completed entries
// a completion leaves behind, which keep the title.
test.afterEach(async ({ page }) => {
  await deleteTestTasks(page)
})

test('a repeating task shows its current repeat and the planned ones', async ({ page }) => {
  await openWith(page, { title: 'E2E daily', due: today.toISOString(), dueAllDay: true, rrule: 'FREQ=DAILY' }, 'w')

  await expect(allDay(page, today).getByRole('checkbox', { name: 'Completed: E2E daily' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  const tomorrow = allDay(page, day(1))
  await expect(tomorrow.getByRole('button', { name: `E2E daily, planned repeat on ${short(day(1))}` })).toBeVisible()
  // Only the current repeat can be completed.
  await expect(tomorrow.getByRole('checkbox')).toHaveCount(0)
})

test('completing the current repeat leaves it done and moves on, and undo takes it back', async ({ page }) => {
  await openWith(page, { title: 'E2E daily', due: today.toISOString(), dueAllDay: true, rrule: 'FREQ=DAILY' }, 'w')
  const todayBox = allDay(page, today).getByRole('checkbox', { name: 'Completed: E2E daily' })
  const tomorrowBox = allDay(page, day(1)).getByRole('checkbox', { name: 'Completed: E2E daily' })
  const inList = taskList(page).getByRole('checkbox', { name: 'Completed: E2E daily' })
  await expect(tomorrowBox).toHaveCount(0)

  await todayBox.click()
  const toast = page.getByText(`Done. Next up: ${short(day(1))}`)
  await expect(toast).toBeVisible()
  // Hovering pauses the toast's 8 s timer, so a slow run keeps its Undo through the checks below.
  await toast.hover()
  // Tomorrow's repeat is the current one now, and today's stays, done.
  await expect(tomorrowBox).toHaveAttribute('aria-checked', 'false')
  await expect(todayBox).toHaveCount(1)
  await expect(todayBox).toHaveAttribute('aria-checked', 'true')
  await expect(inList).toHaveCount(2)

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText('Undone.')).toBeVisible()
  await expect(tomorrowBox).toHaveCount(0)
  await expect(todayBox).toHaveCount(1)
  await expect(todayBox).toHaveAttribute('aria-checked', 'false')
  await expect(inList).toHaveCount(1)
})

/** Pick `handle` up with the mouse and hold it over `target`; the caller drops it. */
async function dragOver(page: Page, handle: Locator, target: Locator): Promise<void> {
  const from = (await handle.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 4 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
}

/** Drag `handle` onto `target` and drop it there. */
async function drag(page: Page, handle: Locator, target: Locator): Promise<void> {
  await dragOver(page, handle, target)
  await page.mouse.up()
}

/** The month grid's cell of the day `n` days after today. */
async function monthDays(page: Page): Promise<(n: number) => Locator> {
  const cells = monthGrid(page).getByRole('gridcell')
  const at = await cells.evaluateAll((els) => els.findIndex((el) => el.getAttribute('aria-current') === 'date'))
  return (n) => cells.nth(at + n)
}

/**
 * The entries of `title` in the month grid's `cell` of day `n`, all of them or its current one, which alone has a
 * checkbox, and its planned repeat there.
 */
function entriesOf(page: Page, cell: (n: number) => Locator, title: string) {
  const entry = (n: number) => cell(n).locator('[data-task-key]', { hasText: title })
  return {
    entry,
    current: (n: number) => entry(n).filter({ has: page.getByRole('checkbox') }),
    planned: (n: number) => cell(n).getByRole('button', { name: `${title}, planned repeat on ${short(day(n))}` }),
    /** The title of the current repeat on day `n`, which opens its details and drags it. */
    handle: (n: number) =>
      entry(n)
        .filter({ has: page.getByRole('checkbox') })
        .getByRole('button', { name: `${title}, all day` }),
  }
}

/** The question which repeats of a series a drop moves (FR-17). */
const moveQuestion = (page: Page) =>
  page.getByRole('alertdialog', { name: 'This task repeats. Which repeats should move?' })

/**
 * The mark of a task detached from its series (FR-17). A chip too narrow for the mark hides it, so match the element
 * rather than the visible role.
 */
const DETACHED_MARK = '[role="img"][aria-label="Detached from its series"]'

/** The toast with `message`, after hovering it: that pauses sonner's 8 s timer, so a slow run keeps its Undo. */
async function hoverToast(page: Page, message: string): Promise<Locator> {
  const toast = page.locator('[data-sonner-toast]', { hasText: message })
  await expect(toast).toBeVisible()
  await toast.hover()
  return toast
}

/** Reload, and wait for the calendar: the view stays the one shown. */
async function reload(page: Page): Promise<void> {
  await page.reload()
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
}

test('dragging the current repeat of a fixed-day series asks, and Only this repeat detaches it', async ({ page }) => {
  const title = 'E2E weekly'
  const rrule = `FREQ=WEEKLY;BYDAY=${byDay(today)},${byDay(day(3))}`
  await openWith(page, { title, due: today.toISOString(), dueAllDay: true, rrule }, 'm')
  const cell = await monthDays(page)
  const { entry, current, planned, handle } = entriesOf(page, cell, title)

  // A day later: the repeat could go on its own, or the series along with it, on its days a day later each.
  await drag(page, handle(0), cell(1))
  const question = moveQuestion(page)
  await expect(question.getByRole('button', { name: 'All repeats' })).toBeVisible()
  await expect(question.getByRole('button', { name: 'This and following repeats' })).toHaveCount(0)

  // The repeat stays where it was dropped while the server, held back here, detaches it.
  const detach = /\/api\/v1\/todos\/[^/]+\/occurrences\//
  let answer!: () => void
  const answered = new Promise<void>((resolve) => {
    answer = resolve
  })
  await page.route(detach, async (route) => {
    await answered
    await route.continue()
  })
  const detaching = page.waitForRequest((r) => r.method() === 'PUT' && detach.test(r.url()))
  await question.getByRole('button', { name: 'Only this repeat' }).click()
  await detaching
  await expect(question).toBeHidden()
  await expect(entry(1)).toHaveCount(1)
  await expect(entry(0)).toHaveCount(0)
  answer()

  const toast = await hoverToast(
    page,
    `Moved to ${short(day(1))} as a task of its own. The series goes on ${short(day(3))}.`,
  )
  // A task of its own now, marked as detached, and the series goes on with Thursday's repeat.
  await expect(current(1).locator(DETACHED_MARK)).toHaveCount(1)
  await expect(current(3)).toBeVisible()
  await expect(entry(0)).toHaveCount(0)

  // Undo takes the detached task back, and the series is at today's repeat again.
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText('Undone.')).toBeVisible()
  await expect(current(0)).toBeVisible()
  await expect(entry(1)).toHaveCount(0)
  await expect(planned(3)).toBeVisible()

  await reload(page)
  await expect(current(0)).toBeVisible()
  await expect(current(0).locator(DETACHED_MARK)).toHaveCount(0)
  await expect(entry(1)).toHaveCount(0)
  await expect(planned(3)).toBeVisible()
})

test('dragging a later repeat of an interval series asks, and This and following splits it', async ({ page }) => {
  const title = 'E2E daily'
  await openWith(page, { title, due: today.toISOString(), dueAllDay: true, rrule: 'FREQ=DAILY' }, 'm')
  const cell = await monthDays(page)
  const { entry, current, planned } = entriesOf(page, cell, title)

  // Tomorrow's planned repeat two days later: only the current repeat could go on its own.
  await drag(page, planned(1), cell(3))
  const question = moveQuestion(page)
  await expect(question).toHaveAccessibleDescription('Only the current repeat can be changed on its own.')
  await expect(question.getByRole('button', { name: 'Only this repeat' })).toHaveCount(0)
  await expect(question.getByRole('button', { name: 'All repeats' })).toBeVisible()
  await question.getByRole('button', { name: 'This and following repeats' }).click()
  await expect(question).toBeHidden()
  await expect(page.getByText(`Moved from ${short(day(1))} on, as a series of its own.`)).toBeVisible()

  // Today's repeat stays as the last of the old series; the new one starts where the repeat was dropped.
  const split = async () => {
    await expect(current(0)).toBeVisible()
    await expect(entry(1)).toHaveCount(0)
    await expect(entry(2)).toHaveCount(0)
    await expect(current(3)).toBeVisible()
    await expect(planned(4)).toBeVisible()
  }
  await split()

  await reload(page)
  await split()
  // Two series, each in the list with its current repeat.
  await expect(taskList(page).getByRole('checkbox', { name: `Completed: ${title}` })).toHaveCount(2)
})

test('a later repeat on fixed days moves as This and following', async ({ page }) => {
  const title = 'E2E weekly'
  const rrule = `FREQ=WEEKLY;BYDAY=${byDay(today)},${byDay(day(3))}`
  await openWith(page, { title, due: today.toISOString(), dueAllDay: true, rrule }, 'm')
  const cell = await monthDays(page)
  const { entry, current, planned } = entriesOf(page, cell, title)

  // Thursday's repeat a day later.
  await drag(page, planned(3), cell(4))
  const question = moveQuestion(page)
  await question.getByRole('button', { name: 'This and following repeats' }).click()
  await expect(question).toBeHidden()
  await expect(page.getByText(`Moved from ${short(day(3))} on, as a series of its own.`)).toBeVisible()

  const split = async () => {
    // The old series keeps its days and ends before Thursday: today's repeat is its last.
    await expect(current(0)).toBeVisible()
    await expect(entry(1)).toHaveCount(0)
    await expect(entry(3)).toHaveCount(0)
    await expect(entry(7)).toHaveCount(0)
    // The new one goes on a day later each, on Fridays and Tuesdays.
    await expect(current(4)).toBeVisible()
    await expect(planned(8)).toBeVisible()
    await expect(entry(10)).toHaveCount(0)
    await expect(planned(11)).toBeVisible()
  }
  await split()

  await reload(page)
  await split()
})

test('deleting the current repeat in the details skips it', async ({ page }) => {
  const title = 'E2E weekly'
  const rrule = `FREQ=WEEKLY;BYDAY=${byDay(today)},${byDay(day(3))}`
  await openWith(page, { title, due: today.toISOString(), dueAllDay: true, rrule }, 'm')
  const cell = await monthDays(page)
  const { entry, current, handle } = entriesOf(page, cell, title)

  await handle(0).click()
  const details = page.getByRole('dialog', { name: title })
  await details.getByRole('button', { name: 'Delete task' }).click()
  await details
    .getByRole('alertdialog', { name: 'This task repeats. Which repeats should be deleted?' })
    .getByRole('button', { name: 'Only this repeat' })
    .click()
  await expect(details).toBeHidden()
  // The toast comes with the server's answer: the series goes on with Thursday's repeat.
  await expect(page.getByText(`Skipped. Next up: ${short(day(3))}`)).toBeVisible()
  await expect(entry(0)).toHaveCount(0)
  await expect(current(3)).toBeVisible()

  await reload(page)
  await expect(entry(0)).toHaveCount(0)
  await expect(current(3)).toBeVisible()
})

test('the last repeat moves without a question', async ({ page }) => {
  const title = 'E2E weekly'
  // On fixed days, until the day after tomorrow: today's repeat is the last.
  const until = day(2).toISOString().slice(0, 10).replaceAll('-', '')
  const rrule = `FREQ=WEEKLY;BYDAY=${byDay(today)},${byDay(day(3))};UNTIL=${until}`
  await openWith(page, { title, due: today.toISOString(), dueAllDay: true, rrule }, 'm')
  const cell = await monthDays(page)
  const { entry, current, handle } = entriesOf(page, cell, title)

  // The day after tomorrow, not one of the series' days: the last repeat is a task like any other.
  await dragOver(page, handle(0), cell(2))
  const said = page.getByRole('status').filter({ hasText: 'New time:' })
  await expect(said).toHaveCount(1)
  // With nothing to choose, nothing is said about the series, to screen readers or beneath the task.
  await expect(said).not.toContainText(/repeat|move/i)
  await expect(page.locator('p[aria-hidden="true"]', { hasText: /repeat|move/i })).toHaveCount(0)
  await page.mouse.up()
  await expect(page.getByText(`Moved to ${short(day(2))}.`, { exact: true })).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(current(2)).toBeVisible()
  await expect(entry(0)).toHaveCount(0)

  await reload(page)
  await expect(current(2)).toBeVisible()
  await expect(entry(0)).toHaveCount(0)
})

test('set and remove the repeat of a task in the editor', async ({ page }) => {
  const title = 'E2E single'
  await openWith(page, { title, due: today.toISOString(), dueAllDay: true }, 'w')
  const planned = allDay(page, day(1)).getByRole('button', { name: `${title}, planned repeat on ${short(day(1))}` })
  const editor = page.getByRole('dialog', { name: 'Edit task' })
  const repeat = async (option: string) => {
    await page.getByRole('button', { name: `Edit task: ${title}` }).click()
    await editor.getByRole('combobox', { name: 'Repeat' }).click()
    await page.getByRole('option', { name: option, exact: true }).click()
    await editor.getByRole('button', { name: 'Save' }).click()
    await expect(editor).toBeHidden()
  }
  await expect(allDay(page, today).getByRole('checkbox', { name: `Completed: ${title}` })).toBeVisible()
  await expect(planned).toHaveCount(0)

  await repeat('Every day')
  await expect(planned).toBeVisible()

  await repeat('Does not repeat')
  await expect(planned).toHaveCount(0)
  await expect(allDay(page, today).getByRole('checkbox', { name: `Completed: ${title}` })).toBeVisible()
})
