import { expect, test, type Locator, type Page } from '@playwright/test'
import { createTestTask, deleteTestTasks, login, monthGrid } from './helpers'

/*
 * Repeating tasks in the calendar views (FR-16, FR-17). The browser's clock
 * stands on the first Monday two months ahead, so every day a spec uses (up
 * to four days later) shares one week row whether weeks start on Sunday or
 * Monday, that row is one of the month grid's top ones, clear of the toasts
 * at the bottom, and the seeded one-off items, all within two weeks of the
 * real today, stay out of its cells.
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

test('dragging a repeat on fixed days stays before the next one', async ({ page }) => {
  const title = 'E2E weekly'
  const rrule = `FREQ=WEEKLY;BYDAY=${byDay(today)},${byDay(day(3))}`
  await openWith(page, { title, due: today.toISOString(), dueAllDay: true, rrule }, 'm')
  // Something else in a day the series can't reach, which dims while the series is dragged.
  await createTestTask(page, { title: 'E2E other', due: day(4).toISOString(), dueAllDay: true })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
  await page.keyboard.press('m')
  const cells = monthGrid(page).getByRole('gridcell')
  const at = await cells.evaluateAll((els) => els.findIndex((el) => el.getAttribute('aria-current') === 'date'))
  // The current repeat on day `n`: the planned ones have no checkbox.
  const current = (n: number) =>
    cells.nth(at + n).locator('[data-task-key]', { hasText: title }).filter({ has: page.getByRole('checkbox') })
  const handle = (n: number) => current(n).getByRole('button', { name: `${title}, all day` })

  // A day later is before the next repeat, on day 3.
  await dragOver(page, handle(0), cells.nth(at + 1))
  await page.mouse.up()
  await expect(page.getByText(`Moved to ${short(day(1))}. Then: ${short(day(3))}`)).toBeVisible()
  await expect(current(1)).toBeVisible()
  await expect(current(0)).toHaveCount(0)

  // Three more days would pass it: the drop keeps the task where it is, and says why.
  await dragOver(page, handle(1), cells.nth(at + 4))
  await expect(page.getByRole('status').filter({ hasText: `Only possible until ${short(day(2))}.` })).toHaveCount(1)
  // Beneath the dragged task too, not only for screen readers.
  await expect(page.locator('p[aria-hidden="true"]', { hasText: `Only possible until ${short(day(2))}.` })).toBeVisible()
  // The days past the next repeat are blocked, and dim what they show but the series' repeats.
  await expect(cells.nth(at + 4)).toHaveClass(/\bblocked\b/)
  await expect(cells.nth(at + 4).locator('[data-task-key]', { hasText: 'E2E other' })).toHaveCSS('opacity', '0.5')
  await expect(cells.nth(at + 3).locator('[data-task-key]', { hasText: title })).toHaveCSS('opacity', '1')
  await page.mouse.up()
  await expect(page.getByText('Not moved')).toBeVisible()
  await expect(page.getByText(`Until ${short(day(2))}, then the next repeat is due.`)).toBeVisible()
  await expect(current(1)).toBeVisible()
  await expect(current(4)).toHaveCount(0)
  await expect(page.getByText(`Moved to ${short(day(4))}`)).toHaveCount(0)

  // Nothing saved.
  await page.reload()
  await expect(current(1)).toBeVisible()
  await expect(current(4)).toHaveCount(0)
})

test('dragging a later repeat of an interval series moves the whole series', async ({ page }) => {
  const title = 'E2E daily'
  await openWith(page, { title, due: today.toISOString(), dueAllDay: true, rrule: 'FREQ=DAILY' }, 'm')
  const cells = monthGrid(page).getByRole('gridcell')
  const at = await cells.evaluateAll((els) => els.findIndex((el) => el.getAttribute('aria-current') === 'date'))
  const entry = (n: number) => cells.nth(at + n).locator('[data-task-key]', { hasText: title })
  // The current repeat on day `n`: the planned ones have no checkbox.
  const current = (n: number) => entry(n).filter({ has: page.getByRole('checkbox') })

  // Tomorrow's planned repeat two days later: the series follows, from today's repeat on.
  await dragOver(page, entry(1).getByRole('button', { name: `${title}, planned repeat on ${short(day(1))}` }), cells.nth(at + 3))
  await page.mouse.up()
  await expect(page.getByText(`Series moved. Next up: ${short(day(2))}`)).toBeVisible()
  await expect(current(2)).toBeVisible()
  await expect(entry(0)).toHaveCount(0)
  await expect(entry(1)).toHaveCount(0)

  await page.reload()
  await expect(current(2)).toBeVisible()
  await expect(entry(1)).toHaveCount(0)
})

test('a later repeat on fixed days stays in place', async ({ page }) => {
  const title = 'E2E weekly'
  const rrule = `FREQ=WEEKLY;BYDAY=${byDay(today)},${byDay(day(3))}`
  await openWith(page, { title, due: today.toISOString(), dueAllDay: true, rrule }, 'm')
  const cells = monthGrid(page).getByRole('gridcell')
  const at = await cells.evaluateAll((els) => els.findIndex((el) => el.getAttribute('aria-current') === 'date'))
  const planned = cells.nth(at + 3).getByRole('button', { name: `${title}, planned repeat on ${short(day(3))}` })

  await dragOver(page, planned, cells.nth(at + 1))
  // Trying says why it stays, next to it.
  await expect(page.getByRole('status').filter({ hasText: `Can be completed and moved once ${short(today)} is done.` })).toBeVisible()
  await page.mouse.up()
  await expect(planned).toBeVisible()
  await expect(cells.nth(at + 1).locator('[data-task-key]', { hasText: title })).toHaveCount(0)
  // The release opens nothing: no details, no new entry.
  await expect(page.getByRole('dialog')).toHaveCount(0)
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
