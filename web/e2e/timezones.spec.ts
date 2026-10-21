import { expect, test, type Page } from '@playwright/test'
import { createTestTask, deleteTestEvents, deleteTestTasks, login } from './helpers'

/*
 * Time zones (FR-18): a series takes the browser's time zone. A browser that reports UTC instead,
 * such as Firefox with privacy.resistFingerprinting, gets series without a zone of its own, as
 * Thunderbird writes them with its time zone set to UTC (README, "Time zones").
 */
test.use({ timezoneId: 'UTC' })

test.afterEach(async ({ page }) => {
  await deleteTestEvents(page)
  await deleteTestTasks(page)
})

/** The API ID of the event titled `title`, from any calendar, within a day of now. */
async function eventId(page: Page, title: string): Promise<string> {
  const calendarsRes = await page.request.get('/api/v1/calendars')
  await expect(calendarsRes).toBeOK()
  const { calendars } = (await calendarsRes.json()) as { calendars: { id: string; supportsEvents: boolean }[] }
  const day = 24 * 3600 * 1000
  const params = { start: new Date(Date.now() - day).toISOString(), end: new Date(Date.now() + day).toISOString() }
  for (const calendar of calendars.filter((c) => c.supportsEvents)) {
    const res = await page.request.get(`/api/v1/calendars/${calendar.id}/events`, { params })
    await expect(res).toBeOK()
    const { events } = (await res.json()) as { events: { id: string; title: string }[] }
    const event = events.find((e) => e.title === title)
    if (event) return event.id
  }
  throw new Error(`event ${title} not found`)
}

/** The data of a calendar object as the CalDAV server holds it. */
async function stored(page: Page, id: string): Promise<string> {
  const res = await page.request.get(`/api/v1/diagnostics/objects/${encodeURIComponent(id)}/content`)
  await expect(res).toBeOK()
  return ((await res.json()) as { content: string }).content
}

test('in a browser that reports UTC, a weekly event and task are saved without a time zone', async ({ page }) => {
  // Create picks the next full hour: in the morning, it is today.
  const morning = new Date()
  morning.setUTCHours(8, 30, 0, 0)
  await page.clock.setFixedTime(morning)
  await login(page)
  await page.keyboard.press('d')

  const title = `E2E UTC weekly ${Date.now()}`
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New event' })
  await dialog.getByPlaceholder('Add a title').fill(title)
  await dialog.getByRole('combobox', { name: 'Repeat' }).click()
  await page.getByRole('option', { name: /^Every week on / }).click()
  await dialog.getByRole('button', { name: 'Create event' }).click()
  await expect(dialog).toBeHidden()

  const event = await stored(page, await eventId(page, title))
  expect(event).toMatch(/\r\nDTSTART:\d{8}T090000Z\r\n/)
  expect(event).toMatch(/\r\nDTEND:\d{8}T100000Z\r\n/)
  expect(event).toContain('RRULE:FREQ=WEEKLY')
  expect(event).not.toContain('TZID')
  expect(event).not.toContain('VTIMEZONE')

  // A single task given a repeat in the editor becomes a series in the browser's zone.
  const task = 'E2E UTC weekly task'
  const due = new Date(morning)
  due.setUTCHours(10, 0, 0, 0)
  const { id } = await createTestTask(page, { title: task, due: due.toISOString(), dueAllDay: false })
  await page.reload()
  await page.getByRole('button', { name: `Edit task: ${task}` }).click()
  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await editor.getByRole('combobox', { name: 'Repeat' }).click()
  await page.getByRole('option', { name: /^Every week on / }).click()
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(editor).toBeHidden()

  const todo = await stored(page, id)
  expect(todo).toMatch(/\r\nDUE:\d{8}T100000Z\r\n/)
  expect(todo).toContain('RRULE:FREQ=WEEKLY')
  expect(todo).not.toContain('TZID')
  expect(todo).not.toContain('VTIMEZONE')
})
