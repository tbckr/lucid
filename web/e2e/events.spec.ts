import { expect, test, type Locator, type Page } from '@playwright/test'
import { deleteTestEvents, login, monthGrid } from './helpers'

// A failed test never reaches its own clean-up. Its event would stay on the server and
// cover the slot that the retry clicks.
test.afterEach(async ({ page }) => {
  await deleteTestEvents(page)
})

test('create, edit and delete an event', async ({ page }) => {
  const title = `E2E review ${Date.now()}`
  const renamed = `${title} (moved)`
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
  const preview = page.getByText('1 PM – 2:30 PM', { exact: true })
  await expect(preview).toBeVisible()
  await page.mouse.up()
  await expect(preview).toBeHidden()

  const dialog = page.getByRole('dialog', { name: 'New event' })
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
