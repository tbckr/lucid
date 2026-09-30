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

/**
 * Delete, through the API, the events a spec left behind: every title a spec
 * gives an event starts with "E2E ". Does nothing without a signed-in session.
 */
export async function deleteTestEvents(page: Page): Promise<void> {
  const api = page.request
  const sessionRes = await api.get('/api/v1/session')
  await expect(sessionRes).toBeOK()
  const session = (await sessionRes.json()) as { authenticated: boolean; csrfToken: string }
  if (!session.authenticated) return

  const calendarsRes = await api.get('/api/v1/calendars')
  await expect(calendarsRes).toBeOK()
  const { calendars } = (await calendarsRes.json()) as {
    calendars: { id: string; readOnly: boolean; supportsEvents: boolean }[]
  }
  // The specs create events today; a week either way covers "the next full hour" at midnight.
  const week = 7 * 24 * 3600 * 1000
  const params = { start: new Date(Date.now() - week).toISOString(), end: new Date(Date.now() + week).toISOString() }
  for (const calendar of calendars.filter((c) => c.supportsEvents && !c.readOnly)) {
    const eventsRes = await api.get(`/api/v1/calendars/${calendar.id}/events`, { params })
    await expect(eventsRes).toBeOK()
    const { events } = (await eventsRes.json()) as { events: { id: string; etag: string; title: string }[] }
    for (const event of events.filter((e) => e.title.startsWith('E2E '))) {
      const res = await api.delete(`/api/v1/events/${event.id}`, {
        headers: { 'X-CSRF-Token': session.csrfToken, 'If-Match': event.etag },
      })
      await expect(res).toBeOK()
    }
  }
}

/**
 * Delete, through the API, the tasks a spec left behind: like the events,
 * every title a spec gives a task starts with "E2E ".
 */
export async function deleteTestTasks(page: Page): Promise<void> {
  const api = page.request
  const sessionRes = await api.get('/api/v1/session')
  await expect(sessionRes).toBeOK()
  const session = (await sessionRes.json()) as { authenticated: boolean; csrfToken: string }
  if (!session.authenticated) return

  const calendarsRes = await api.get('/api/v1/calendars')
  await expect(calendarsRes).toBeOK()
  const { calendars } = (await calendarsRes.json()) as {
    calendars: { id: string; readOnly: boolean; supportsTodos: boolean }[]
  }
  for (const calendar of calendars.filter((c) => c.supportsTodos && !c.readOnly)) {
    const todosRes = await api.get(`/api/v1/calendars/${calendar.id}/todos`)
    await expect(todosRes).toBeOK()
    const { todos } = (await todosRes.json()) as { todos: { id: string; etag: string; title: string }[] }
    for (const todo of todos.filter((t) => t.title.startsWith('E2E '))) {
      const res = await api.delete(`/api/v1/todos/${todo.id}`, {
        headers: { 'X-CSRF-Token': session.csrfToken, 'If-Match': todo.etag },
      })
      await expect(res).toBeOK()
    }
  }
}

/**
 * Create a task through the API in the "Tasks" calendar, the way the editor
 * saves one: `due` (and `start`) are wire dates, UTC midnight for all-day
 * values, and a timed repeat recurs in the browser's time zone. The title
 * must start with "E2E ", so that `deleteTestTasks` removes it again.
 */
export async function createTestTask(
  page: Page,
  body: { title: string; due: string; dueAllDay: boolean; rrule?: string; start?: string | null },
): Promise<{ id: string; etag: string }> {
  if (!body.title.startsWith('E2E ')) throw new Error(`test task "${body.title}" must start with "E2E "`)
  const api = page.request
  const sessionRes = await api.get('/api/v1/session')
  await expect(sessionRes).toBeOK()
  const session = (await sessionRes.json()) as { csrfToken: string }

  const calendarsRes = await api.get('/api/v1/calendars')
  await expect(calendarsRes).toBeOK()
  const { calendars } = (await calendarsRes.json()) as { calendars: { id: string; name: string }[] }
  const tasks = calendars.find((c) => c.name === 'Tasks')
  if (!tasks) throw new Error('calendar Tasks not found')

  const timezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const res = await api.post(`/api/v1/calendars/${tasks.id}/todos`, {
    headers: { 'X-CSRF-Token': session.csrfToken },
    data: {
      title: body.title,
      description: '',
      checklist: [],
      start: body.start ?? null,
      // Start and due are both dates or both times.
      startAllDay: body.dueAllDay,
      due: body.due,
      dueAllDay: body.dueAllDay,
      priority: 0,
      status: 'NEEDS-ACTION',
      ...(body.rrule === undefined ? {} : { rrule: body.rrule }),
      timezone,
    },
  })
  await expect(res).toBeOK()
  const { id, etag } = (await res.json()) as { id: string; etag: string }
  return { id, etag }
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
