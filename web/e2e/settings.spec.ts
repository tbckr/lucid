import { expect, test } from '@playwright/test'
import { login } from './helpers'

test('switching the language to German translates the UI and persists', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('radio', { name: 'Deutsch', exact: true }).click()
  await page.getByRole('dialog', { name: 'Einstellungen' }).getByRole('button', { name: 'Schließen' }).click()

  await expect(page.getByRole('button', { name: 'Heute', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Monat' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'de')

  await page.reload()
  await expect(page.getByRole('button', { name: 'Heute', exact: true })).toBeVisible()

  // Back to English for other specs sharing the browser profile.
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  await page.getByRole('dialog', { name: 'Einstellungen' }).getByRole('radio', { name: 'English', exact: true }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
})

test('the login page and the settings show the version and link to the source code', async ({ page }) => {
  // "dev" under `go run`, a release or pseudo-version for built binaries.
  const version = /^Lucid \S+$/
  await page.goto('/login')
  await expect(page.getByText(version)).toBeVisible()

  await login(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByText(version)).toBeVisible()
  await expect(dialog.getByRole('link', { name: /^GitHub/ })).toHaveAttribute('href', 'https://github.com/tbckr/lucid')
})
