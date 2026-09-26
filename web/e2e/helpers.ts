import { expect, type Page } from '@playwright/test'

export const MOCKDAV_URL = 'http://127.0.0.1:5232/'

/** Sign in as the mockdav demo user, optionally with a ?redirect= target. */
export async function login(page: Page, redirect?: string): Promise<void> {
  await page.goto(redirect === undefined ? '/login' : `/login?redirect=${encodeURIComponent(redirect)}`)
  await page.getByLabel('Server address').fill(MOCKDAV_URL)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('demo')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
}

/** The month grid of the main view. */
export function monthGrid(page: Page) {
  return page.getByRole('grid')
}

/** Event chips/blocks rendered for a calendar, by its visible name in the sidebar. */
export async function calendarId(page: Page, name: string): Promise<string> {
  const toggle = page.locator('label', { hasText: name }).locator('input[type=checkbox]')
  const testId = await toggle.getAttribute('data-testid')
  if (!testId) throw new Error(`calendar ${name} not found`)
  return testId.replace('calendar-toggle-', '')
}
