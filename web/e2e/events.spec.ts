import { expect, test, type Locator, type Page } from '@playwright/test'
import { createTestEvent, deleteTestEvents, login, monthGrid } from './helpers'

// A failed test never reaches its own clean-up. Its event would stay on the server and
// cover the slot that the retry clicks.
test.afterEach(async ({ page }) => {
  await deleteTestEvents(page)
})

test('create, edit and delete an event', async ({ page }) => {
  const title = `E2E review ${Date.now()}`
  const renamed = `${title} (moved)`
  // Create picks the next full hour, so the morning it is: later in the day the details open low, under
  // the toasts, which pause while the pointer is on them, and after 23:00 the event lands tomorrow.
  // 8:30 UTC is 9:30 or 10:30 in Berlin, the time zone of the config.
  const morning = new Date()
  morning.setUTCHours(8, 30, 0, 0)
  await page.clock.setFixedTime(morning)
  await login(page)
  // Day view: busy month cells may hide new events behind "+N more".
  await page.keyboard.press('d')

  // Create via the sidebar button; defaults to the next full hour today.
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New event' })
  await dialog.getByPlaceholder('Add a title').fill(title)
  await dialog.getByLabel('Location').fill('Room 42')
  await dialog.getByRole('button', { name: 'Create event' }).click()
  await expect(dialog).toBeHidden()
  const main = page.getByRole('main')
  const chip = main.locator('[data-event-key]', { hasText: title })
  await expect(chip).toBeVisible()

  // Details + edit.
  await chip.click()
  const details = page.getByRole('dialog', { name: title })
  await expect(details).toContainText('Room 42')
  await details.getByRole('button', { name: 'Edit event' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit event' })
  await editor.getByPlaceholder('Add a title').fill(renamed)
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(editor).toBeHidden()
  const renamedChip = main.locator('[data-event-key]', { hasText: renamed })
  await expect(renamedChip).toBeVisible()

  // Delete.
  await renamedChip.click()
  const renamedDetails = page.getByRole('dialog', { name: renamed })
  await renamedDetails.getByRole('button', { name: 'Delete event' }).click()
  await renamedDetails.getByRole('alert').getByRole('button', { name: 'Delete event' }).click()
  await expect(main.locator('[data-event-key]', { hasText: renamed })).toHaveCount(0)

  // Still gone after a reload (server state, not just the cache).
  await page.reload()
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
  await page.keyboard.press('a')
  await expect(page.getByTestId('agenda')).toBeVisible()
  await expect(page.locator('[data-event-key]', { hasText: renamed })).toHaveCount(0)
})

test('keyboard shortcuts switch views', async ({ page }) => {
  await login(page)
  await page.keyboard.press('w')
  await expect(page.getByRole('radio', { name: 'Week' })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('a')
  await expect(page.getByTestId('agenda')).toBeVisible()
  await page.keyboard.press('m')
  await expect(monthGrid(page)).toBeVisible()
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
})

/** Create a one-hour event today in the day view, starting at `hour` (e.g. "1:00 PM"), and return its block. */
async function createAt(page: Page, hour: string, title: string): Promise<Locator> {
  await login(page)
  await page.keyboard.press('d')
  // A click starts the event in the 15-minute block under the pointer: the top one is the full hour.
  await page.getByRole('button', { name: new RegExp(` ${hour}$`) }).click({ position: { x: 20, y: 4 } })
  const dialog = page.getByRole('dialog', { name: 'New event' })
  await dialog.getByPlaceholder('Add a title').fill(title)
  await dialog.getByRole('button', { name: 'Create event' }).click()
  await expect(dialog).toBeHidden()
  const block = page.locator('[data-event-key]', { hasText: title })
  await expect(block).toBeVisible()
  return block
}

async function deleteEvent(page: Page, block: Locator, title: string): Promise<void> {
  await block.click()
  const details = page.getByRole('dialog', { name: title })
  await details.getByRole('button', { name: 'Delete event' }).click()
  await details.getByRole('alert').getByRole('button', { name: 'Delete event' }).click()
  await expect(block).toHaveCount(0)
}

test('dragging in the empty grid creates an event over the covered slots', async ({ page }) => {
  const title = `E2E drag create ${Date.now()}`
  await login(page)
  await page.keyboard.press('d')

  // Press at 1:05 PM and drag into the 2:15 PM slot (0.8 px per minute): the preview shows the span.
  const slot = page.getByRole('button', { name: / 1:00 PM$/ })
  const box = (await slot.boundingBox())!
  const x = box.x + box.width / 2
  await page.mouse.move(x, box.y + 4)
  await page.mouse.down()
  await page.mouse.move(x, box.y + 30, { steps: 4 })
  await page.mouse.move(x, box.y + 66, { steps: 4 })
  await expect(page.getByText('1 PM – 2:30 PM', { exact: true })).toBeVisible()
  await page.mouse.up()

  // The create popover opens over the dragged span.
  const dialog = page.getByRole('dialog', { name: 'New event' })
  await expect(dialog.getByRole('combobox', { name: 'Start time' })).toHaveText('1:00 PM')
  await expect(dialog.getByRole('combobox', { name: 'End time' })).toHaveText('2:30 PM')
  await dialog.getByPlaceholder('Add a title').fill(title)
  await dialog.getByRole('button', { name: 'Create event' }).click()
  await expect(dialog).toBeHidden()
  const block = page.locator('[data-event-key]', { hasText: title })
  await expect(block).toContainText('1 PM – 2:30 PM')

  await deleteEvent(page, block, title)
})

test('dragging an event shows the target time before the drop', async ({ page }) => {
  const title = `E2E drag ${Date.now()}`
  // 1 PM keeps the pointer away from the edges, where dnd-kit auto-scrolls.
  const block = await createAt(page, '1:00 PM', title)
  await expect(block).toContainText('1 PM – 2 PM')

  // Move down one hour (48 px): the dragged copy shows the new time, and so does the saved event.
  let box = (await block.boundingBox())!
  const x = box.x + box.width / 2
  await page.mouse.move(x, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(x, box.y + 20, { steps: 4 })
  await page.mouse.move(x, box.y + 58, { steps: 4 })
  await expect(block.filter({ hasText: '2 PM – 3 PM' })).toHaveCount(1)
  await page.mouse.up()
  await expect(block).toHaveCount(1)
  await expect(block).toContainText('2 PM – 3 PM')

  // Drag the bottom edge down 30 minutes (24 px): the block shows the new end time.
  box = (await block.boundingBox())!
  await page.mouse.move(x, box.y + box.height - 3)
  await page.mouse.down()
  await page.mouse.move(x, box.y + box.height + 7, { steps: 4 })
  await page.mouse.move(x, box.y + box.height + 21, { steps: 4 })
  await expect(block).toContainText('2 PM – 3:30 PM')
  await page.mouse.up()
  await expect(block).toContainText('2 PM – 3:30 PM')

  await deleteEvent(page, block, title)
})

test('moving an event with the keyboard shows and announces the target time', async ({ page }) => {
  const title = `E2E keyboard drag ${Date.now()}`
  // From 1 PM, the moves cross the middle of the grid, where dnd-kit scrolls instead of
  // moving. Fast key presses must not get lost while it scrolls.
  const block = await createAt(page, '1:00 PM', title)
  await expect(block).toContainText('1 PM – 2 PM')

  // Space picks the event up; each arrow key moves it by 15 minutes (NFR-27).
  await block.focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('status').filter({ hasText: `Picked up ${title}.` })).toHaveCount(1)
  // dnd-kit's sensor listens for keys only from a timer queued at the pick-up; until then,
  // arrow keys scroll the grid, which moves the event by 40 px each. The announcement does
  // not wait for that timer, and a busy browser runs input before timers. Timers run in
  // order, so once one queued now has fired, the sensor listens.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)))
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
  await expect(block.filter({ hasText: '2 PM – 3 PM' })).toHaveCount(1)
  await expect(page.getByRole('status').filter({ hasText: /^New time: .*, 2:00 PM – 3:00 PM\.$/ })).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(block).toHaveCount(1)
  await expect(block).toContainText('2 PM – 3 PM')

  await deleteEvent(page, block, title)
})

test('a click beside the create popover only closes it', async ({ page }) => {
  await login(page)
  await page.keyboard.press('d')
  await page.getByRole('button', { name: / 1:00 PM$/ }).click({ position: { x: 20, y: 4 } })
  const dialog = page.getByRole('dialog', { name: 'New event' })
  await expect(dialog).toBeVisible()

  // Beside the popover, on the 4 PM slot: the page outside is inert while it is open.
  const slot = (await page.locator('button[aria-label$=" 4:00 PM"]').boundingBox())!
  await page.mouse.click(slot.x + slot.width - 20, slot.y + 4)
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('dragging the draft of the create popover changes the times it creates', async ({ page }) => {
  const title = `E2E draft drag ${Date.now()}`
  await login(page)
  await page.keyboard.press('w')
  // On the first day of the week, so the next one is beside it. The page outside the popover
  // is inert for Playwright's actions, so the drags use the mouse.
  await page.locator('button[aria-label$=" 1:00 PM"]').first().click({ position: { x: 20, y: 4 } })
  const dialog = page.getByRole('dialog', { name: 'New event' })
  const startDate = dialog.getByRole('button', { name: /^Start / })
  const startTime = dialog.getByRole('combobox', { name: 'Start time' })
  const endTime = dialog.getByRole('combobox', { name: 'End time' })
  await expect(endTime).toHaveText('2:00 PM')
  const firstDay = (await startDate.textContent())!
  const draft = page.locator('[data-draft]')

  // Down one hour (48 px), as an event moves.
  let box = (await draft.boundingBox())!
  let x = box.x + box.width / 2
  await page.mouse.move(x, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(x, box.y + 20, { steps: 4 })
  await page.mouse.move(x, box.y + 58, { steps: 4 })
  await page.mouse.up()
  await expect(startTime).toHaveText('2:00 PM')
  await expect(endTime).toHaveText('3:00 PM')

  // Into the next day's column; the popover goes along.
  box = (await draft.boundingBox())!
  const popover = (await dialog.boundingBox())!
  await page.mouse.move(x, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(x + 10, box.y + 10, { steps: 4 })
  x += box.width + 8
  await page.mouse.move(x, box.y + 10, { steps: 4 })
  await page.mouse.up()
  await expect(startDate).not.toHaveText(firstDay)
  await expect(startTime).toHaveText('2:00 PM')
  await expect.poll(async () => (await draft.boundingBox())!.x).toBeGreaterThan(box.x + box.width / 2)
  await expect.poll(async () => (await dialog.boundingBox())!.x).toBeGreaterThan(popover.x + box.width / 2)

  // The bottom edge down 30 minutes (24 px): the draft grows while it is dragged.
  box = (await draft.boundingBox())!
  await page.mouse.move(x, box.y + box.height - 3)
  await page.mouse.down()
  await page.mouse.move(x, box.y + box.height + 7, { steps: 4 })
  await page.mouse.move(x, box.y + box.height + 21, { steps: 4 })
  await expect(draft).toContainText('2 PM – 3:30 PM')
  await page.mouse.up()
  await expect(endTime).toHaveText('3:30 PM')

  // The title kept the focus through the drags.
  await expect(dialog.getByPlaceholder('Add a title')).toBeFocused()
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  const block = page.locator('[data-event-key]', { hasText: title })
  await expect(block).toContainText('2 PM – 3:30 PM')
  expect((await block.boundingBox())!.x).toBeGreaterThan(box.x - box.width / 2)

  await deleteEvent(page, block, title)
})

test('a click on another event while details are open shows its details', async ({ page }) => {
  await login(page)
  // Standup (weekdays) and Gym (Mondays, Thursdays) are in every week of the demo data.
  await page.keyboard.press('w')
  const main = page.getByRole('main')
  await main.locator('[data-event-key]', { hasText: 'Standup' }).first().click()
  await expect(page.getByRole('dialog', { name: 'Standup' })).toBeVisible()

  await main.locator('[data-event-key]', { hasText: 'Gym' }).first().click()
  const gym = page.getByRole('dialog', { name: 'Gym' })
  await expect(gym).toBeVisible()
  // The Standup details return the focus from a timer queued as they close; once one
  // queued now has fired, that focus has come and gone.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)))
  await expect(gym).toBeVisible()
  await expect(gym.getByRole('button', { name: 'Edit event' })).toBeFocused()
  await expect(page.getByRole('dialog')).toHaveCount(1)
})

const SERIES = 'E2E Series'

/**
 * Sign in and create "E2E Series" through the API: today 9:00–9:30, repeating every week on
 * today's weekday (FR-17). Returns its block in the week view, today's event of the series.
 */
async function createSeries(page: Page): Promise<Locator> {
  await login(page)
  // Today in the browser's time zone, the one of the config.
  const today = await page.evaluate(() => {
    const at = (h: number, m: number) => {
      const d = new Date()
      d.setHours(h, m, 0, 0)
      return d.toISOString()
    }
    return { start: at(9, 0), end: at(9, 30), weekday: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date().getDay()] }
  })
  await createTestEvent(page, { title: SERIES, start: today.start, end: today.end, rrule: `FREQ=WEEKLY;BYDAY=${today.weekday}` })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
  await page.keyboard.press('w')
  // One event of a weekly series a week. Half an hour is too short a block to show its end;
  // its name has it.
  const block = page.getByRole('main').locator('[data-event-key]', { hasText: SERIES })
  await expect(block).toHaveCount(1)
  await expect(block).toHaveAccessibleName(`${SERIES}, 9 AM – 9:30 AM`)
  return block
}

/** Drag `block` down one hour (48 px) and return the question which events of its series move. */
async function dragAnHourLater(page: Page, block: Locator): Promise<Locator> {
  // 9 AM sits near the top of the grid, where dnd-kit auto-scrolls: drag it from the middle.
  await block.evaluate((el) => {
    el.scrollIntoView({ block: 'center' })
  })
  const box = (await block.boundingBox())!
  const x = box.x + box.width / 2
  await page.mouse.move(x, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(x, box.y + 20, { steps: 4 })
  await page.mouse.move(x, box.y + 58, { steps: 4 })
  await page.mouse.up()
  const question = page.getByRole('alertdialog', { name: 'This event repeats. Which events should move?' })
  await expect(question).toBeVisible()
  return question
}

test('moves only one event of a series', async ({ page }) => {
  const block = await createSeries(page)

  const question = await dragAnHourLater(page, block)
  await question.getByRole('button', { name: 'Only this event' }).click()
  await expect(question).toBeHidden()
  await expect(block).toHaveCount(1)
  await expect(block).toHaveAccessibleName(`${SERIES}, 10 AM – 10:30 AM`)
  // Marked as changed once the server reports the override.
  await expect(block.getByRole('img', { name: 'Repeating event, changed individually' })).toBeVisible()

  // Next week's event stays where it was, unmarked.
  await page.getByRole('button', { name: 'Next period' }).click()
  await expect(block).toHaveCount(1)
  await expect(block).toHaveAccessibleName(`${SERIES}, 9 AM – 9:30 AM`)
  await expect(block.getByRole('img', { name: 'Recurring event' })).toBeVisible()
})

test('deletes only one event of a series', async ({ page }) => {
  const block = await createSeries(page)

  await block.click()
  const details = page.getByRole('dialog', { name: SERIES })
  await details.getByRole('button', { name: 'Delete event' }).click()
  await details
    .getByRole('alertdialog', { name: 'This event repeats. Which events should be deleted?' })
    .getByRole('button', { name: 'Only this event' })
    .click()
  await expect(details).toBeHidden()
  // The toast comes with the server's answer, so the event is gone there too, not only optimistically.
  await expect(page.getByText('Event deleted')).toBeVisible()
  await expect(block).toHaveCount(0)

  // Next week's event stays.
  await page.getByRole('button', { name: 'Next period' }).click()
  await expect(block).toHaveCount(1)
  await expect(block).toHaveAccessibleName(`${SERIES}, 9 AM – 9:30 AM`)
})

test('moves all events of a series within the day', async ({ page }) => {
  const block = await createSeries(page)

  const question = await dragAnHourLater(page, block)
  await question.getByRole('button', { name: 'All events' }).click()
  await expect(question).toBeHidden()
  await expect(block).toHaveCount(1)
  await expect(block).toHaveAccessibleName(`${SERIES}, 10 AM – 10:30 AM`)

  // Next week's event moved along, and none of them was changed on its own.
  await page.getByRole('button', { name: 'Next period' }).click()
  await expect(block).toHaveCount(1)
  await expect(block).toHaveAccessibleName(`${SERIES}, 10 AM – 10:30 AM`)
  await expect(block.getByRole('img', { name: 'Recurring event' })).toBeVisible()
})
