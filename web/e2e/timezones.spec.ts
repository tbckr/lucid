import { expect, test, type Page } from '@playwright/test'
import { createTestEvent, createTestTask, deleteTestEvents, deleteTestTasks, login } from './helpers'

/*
 * Time zones (FR-18): a new series takes the browser's time zone. A browser that reports UTC instead,
 * such as Firefox with privacy.resistFingerprinting, gets series without a zone of its own, as
 * Thunderbird writes them with its time zone set to UTC (README, "Time zones").
 */
test.use({ timezoneId: 'UTC' })

test.afterEach(async ({ page }) => {
  await deleteTestEvents(page)
  await deleteTestTasks(page)
})

/** The API ID of the event titled `title`, from any calendar, from a week before now to three weeks after, as `deleteTestEvents` looks. */
async function eventId(page: Page, title: string): Promise<string> {
  const calendarsRes = await page.request.get('/api/v1/calendars')
  await expect(calendarsRes).toBeOK()
  const { calendars } = (await calendarsRes.json()) as { calendars: { id: string; supportsEvents: boolean }[] }
  const week = 7 * 24 * 3600 * 1000
  const params = { start: new Date(Date.now() - week).toISOString(), end: new Date(Date.now() + 3 * week).toISOString() }
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
  expect(event).toMatch(/\r\nDTEND:\d{8}T093000Z\r\n/)
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

/*
 * Items in other time zones (FR-17, FR-18), in a browser in Berlin. A series in New York in the evening shows a day
 * later here, and its details say its repeat on the days it shows on; the editors show and build it in New York,
 * where it stays. A flight is entered in the zones it leaves and lands in, each row in its own, and its details name
 * both.
 */
test.describe('a browser in Berlin', () => {
  test.use({ timezoneId: 'Europe/Berlin' })

  /** The next Tuesday at 23:00 UTC: 18:00 or 19:00 that Tuesday in New York, past midnight on Wednesday in Berlin. */
  function tuesdayNight(): Date {
    const d = new Date()
    d.setUTCHours(23, 0, 0, 0)
    d.setUTCDate(d.getUTCDate() + ((9 - d.getUTCDay()) % 7 || 7))
    return d
  }

  /** The date of `at` in UTC as iCalendar writes it, "yyyymmdd": for 23:00 UTC also the date in New York. */
  const icalDate = (at: Date) => at.toISOString().slice(0, 10).replaceAll('-', '')

  test('keeps a series from New York in its zone', async ({ page }) => {
    const tuesday = tuesdayNight()
    // Wednesday at noon, Berlin's day of the series.
    await page.clock.setFixedTime(new Date(tuesday.getTime() + 13 * 3600 * 1000))
    await login(page)

    const title = `E2E New York ${Date.now()}`
    await createTestEvent(page, {
      title,
      start: tuesday.toISOString(),
      end: new Date(tuesday.getTime() + 3600 * 1000).toISOString(),
      rrule: 'FREQ=WEEKLY;BYDAY=TU,TH',
      timezone: 'America/New_York',
    })
    await page.reload()
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
    await page.keyboard.press('d')
    await page.getByRole('main').locator('[data-event-key]', { hasText: title }).click()
    const details = page.getByRole('dialog', { name: title })
    await expect(details).toContainText('Every week on Wednesday and Friday')

    // The editor shows the series where it recurs: at 18:00 or 19:00 on Tuesdays and Thursdays in New York.
    await details.getByRole('button', { name: 'Edit event' }).click()
    const editor = page.getByRole('dialog', { name: 'Edit event' })
    await expect(editor.getByRole('combobox', { name: 'Start time zone' })).toHaveValue('New York')
    await expect(editor.getByRole('combobox', { name: 'Start time', exact: true })).toHaveValue(/^[67]:00 PM$/)
    const select = editor.getByRole('combobox', { name: 'Repeat' })
    await expect(select).toHaveText('Every week on Tuesday and Thursday')
    await select.click()
    await page.getByRole('option', { name: 'Custom…' }).click()
    const repeat = page.getByRole('dialog', { name: 'Custom repeat' })
    await repeat.getByRole('spinbutton', { name: 'Repeat every' }).fill('2')
    await repeat.getByRole('button', { name: 'Done' }).click()
    await expect(select).toHaveText('Every 2 weeks on Tuesday and Thursday')
    // The series' first event: the new repeat applies to all of it, without a question.
    await editor.getByRole('button', { name: 'Save' }).click()
    await expect(editor).toBeHidden()

    // The new repeat, built in New York, and the series still there.
    const event = await stored(page, await eventId(page, title))
    expect(event).toMatch(/\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH(;|\r\n)/)
    expect(event).toMatch(new RegExp(`\\r\\nDTSTART;TZID=America/New_York:${icalDate(tuesday)}T1[89]0000\\r\\n`))
    expect(event).not.toContain('Europe/Berlin')

    const task = 'E2E New York task'
    const { id } = await createTestTask(page, {
      title: task,
      due: tuesday.toISOString(),
      dueAllDay: false,
      rrule: 'FREQ=WEEKLY',
      timezone: 'America/New_York',
    })
    await page.reload()
    await page.getByRole('button', { name: `Edit task: ${task}` }).click()
    const taskEditor = page.getByRole('dialog', { name: 'Edit task' })
    await expect(taskEditor.getByRole('combobox', { name: 'Due time zone' })).toHaveValue('New York')
    const taskSelect = taskEditor.getByRole('combobox', { name: 'Repeat' })
    await expect(taskSelect).toHaveText('Every week on Tuesday')
    await taskSelect.click()
    await page.getByRole('option', { name: 'Custom…' }).click()
    await repeat.getByRole('spinbutton', { name: 'Repeat every' }).fill('2')
    await repeat.getByRole('button', { name: 'Done' }).click()
    await expect(taskSelect).toHaveText('Every 2 weeks on Tuesday')
    await taskEditor.getByRole('button', { name: 'Save' }).click()
    await expect(taskEditor).toBeHidden()

    const todo = await stored(page, id)
    expect(todo).toMatch(/\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU(;|\r\n)/)
    expect(todo).toMatch(new RegExp(`\\r\\nDUE;TZID=America/New_York:${icalDate(tuesday)}T1[89]0000\\r\\n`))
    expect(todo).not.toContain('Europe/Berlin')
  })

  test('enters a flight in two zones', async ({ page }) => {
    // Create picks the next full hour: in the morning, it is today.
    const morning = new Date()
    morning.setUTCHours(6, 30, 0, 0)
    await page.clock.setFixedTime(morning)
    await login(page)
    await page.keyboard.press('d')

    const title = `E2E flight ${Date.now()}`
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New event' })
    await dialog.getByPlaceholder('Add a title').fill(title)
    // An event in the browser's zone shows no zone field until it is asked for. The start's then has the focus, and
    // the end's follows it while it is in the start's zone.
    const startZone = dialog.getByRole('combobox', { name: 'Start time zone' })
    const endZone = dialog.getByRole('combobox', { name: 'End time zone' })
    await expect(startZone).toBeHidden()
    await dialog.getByRole('button', { name: 'Other time zone' }).click()
    await expect(startZone).toBeFocused()
    await page.keyboard.type('Berlin')
    await page.keyboard.press('Enter')
    await expect(startZone).toHaveValue('Berlin')
    await expect(endZone).toHaveValue('Berlin')
    await endZone.click()
    await page.keyboard.type('New York')
    await page.keyboard.press('Enter')
    await expect(endZone).toHaveValue('New York')
    await expect(startZone).toHaveValue('Berlin')

    const startTime = dialog.getByRole('combobox', { name: 'Start time', exact: true })
    await startTime.click()
    await page.keyboard.type('10:00')
    await page.keyboard.press('Enter')
    await expect(startTime).toHaveValue('10:00 AM')
    const endTime = dialog.getByRole('combobox', { name: 'End time', exact: true })
    await endTime.click()
    await page.keyboard.type('1:00 PM')
    await page.keyboard.press('Enter')
    await expect(endTime).toHaveValue('1:00 PM')
    // Where the flight lies here: it lands at 18:00 or 19:00 in Berlin, as the two zones are 5 or 6 hours apart.
    await expect(dialog).toContainText(/In your time zone \(Berlin\):\s.*10:00\sAM\s–\s[67]:00\sPM/)
    await dialog.getByRole('button', { name: 'Create event' }).click()
    await expect(dialog).toBeHidden()

    // Each time in its zone, on the same date, Berlin picked too, though it is the browser's.
    const event = await stored(page, await eventId(page, title))
    const day = /\r\nDTSTART;TZID=Europe\/Berlin:(\d{8})T100000\r\n/.exec(event)?.[1]
    expect(day).toBeDefined()
    expect(event).toContain(`\r\nDTEND;TZID=America/New_York:${day}T130000\r\n`)
    expect(event).toContain('\r\nTZID:Europe/Berlin\r\n')
    expect(event).toContain('\r\nTZID:America/New_York\r\n')

    await page.getByRole('main').locator('[data-event-key]', { hasText: title }).click()
    await expect(page.getByRole('dialog', { name: title })).toContainText('10:00 AM Berlin – 1:00 PM New York')
  })
})
