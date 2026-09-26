import { expect, test } from '@playwright/test'
import { login } from './helpers'

test('complete and reopen a task', async ({ page }) => {
  await login(page)
  const box = page.getByRole('checkbox', { name: 'Completed: Buy milk' })
  await expect(box).toHaveAttribute('aria-checked', 'false')

  await box.click()
  await expect(box).toHaveAttribute('aria-checked', 'true')

  // Persisted on the server.
  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Completed: Buy milk' })).toHaveAttribute('aria-checked', 'true')

  // Restore the seed state for other runs.
  await page.getByRole('checkbox', { name: 'Completed: Buy milk' }).click()
  await expect(page.getByRole('checkbox', { name: 'Completed: Buy milk' })).toHaveAttribute('aria-checked', 'false')
})

test('checklist items are shown and editable', async ({ page }) => {
  await login(page)
  await page.getByTestId('task-row').filter({ hasText: 'Buy milk' }).getByRole('button', { name: /Buy milk/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit task' })
  await expect(dialog.getByRole('textbox', { name: 'Checklist item 1' })).toHaveValue('2 liters')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})
