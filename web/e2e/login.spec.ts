import { expect, test } from '@playwright/test'
import { login, monthGrid, MOCKDAV_URL } from './helpers'

test('login shows the month view with seeded events', async ({ page }) => {
  await login(page)
  await expect(page).toHaveURL(/\/$/)
  const grid = monthGrid(page)
  await expect(grid).toBeVisible()
  // "Standup" repeats every weekday, so it is always in the current month.
  await expect(grid.locator('[data-event-key]', { hasText: 'Standup' }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Calendars' })).toBeVisible()
})

test('wrong password shows an error', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Server address').fill(MOCKDAV_URL)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('wrong')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('rejected this username or password')
})

test('an unauthenticated visit redirects to login and back', async ({ page }) => {
  await page.goto('/some/deep/link?x=1')
  await expect(page).toHaveURL(/\/login\?redirect=%2Fsome%2Fdeep%2Flink%3Fx%3D1$/)
  await page.getByLabel('Server address').fill(MOCKDAV_URL)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('demo')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/some\/deep\/link\?x=1$/)
})

for (const evil of ['//evil.example', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)']) {
  test(`invalid redirect ${evil} is ignored`, async ({ page, baseURL }) => {
    await login(page, evil)
    const url = new URL(page.url())
    expect(url.origin).toBe(new URL(baseURL ?? '').origin)
    expect(url.pathname).toBe('/')
  })
}

test('logout returns to the login page', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /^Account/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
})
