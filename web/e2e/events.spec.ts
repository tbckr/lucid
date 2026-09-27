import { expect, test } from '@playwright/test'
import { login, monthGrid } from './helpers'

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
  await page.getByRole('dialog', { name: renamed }).getByRole('button', { name: 'Delete event' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete event' }).click()
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

test('dragging an event shows the target time before the drop', async ({ page }) => {
  const title = `E2E drag ${Date.now()}`
  await login(page)
  await page.keyboard.press('d')

  // 1 PM keeps the pointer away from the edges, where dnd-kit auto-scrolls. The top
  // edge of the slot snaps to the full hour.
  await page.getByRole('button', { name: / 1:00 PM$/ }).click({ position: { x: 20, y: 1 } })
  const dialog = page.getByRole('dialog', { name: 'New event' })
  await dialog.getByPlaceholder('Add a title').fill(title)
  await dialog.getByRole('button', { name: 'Create event' }).click()
  await expect(dialog).toBeHidden()
  const block = page.locator('[data-event-key]', { hasText: title })
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

  await block.click()
  await page.getByRole('dialog', { name: title }).getByRole('button', { name: 'Delete event' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete event' }).click()
  await expect(block).toHaveCount(0)
})
