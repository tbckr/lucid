import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { endpoints } from '@/lib/api/endpoints'
import { type ApiEvent } from '@/lib/api/schemas'
import { EditorDialog } from '@/components/EditorDialog'
import { toCalEvent, type CalEvent } from '@/lib/events'
import { draftOf } from '@/lib/quickCreate'
import { useUi, type CreateEditorState, type EditorState } from '@/stores/ui'
import { apiEvent, bodyOf, calendar, jsonResponse, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'

// 11:00-12:00 in Berlin (CET, the Vitest time zone) on Wednesday, 11 March 2026.
const create: CreateEditorState = {
  mode: 'create',
  draft: draftOf(
    { start: new Date('2026-03-11T10:00:00Z'), end: new Date('2026-03-11T11:00:00Z'), allDay: false, granularity: 'time', ranged: false },
    'Europe/Berlin',
  ),
}

/** Render the editor once the calendars are loaded, as in the app. */
async function openEditor(editor: NonNullable<EditorState>) {
  api.setCsrfToken('tok')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
    Promise.resolve(
      urlOf(input).endsWith('/calendars')
        ? jsonResponse(200, { calendars: [calendar(), calendar({ id: 'c2', name: 'Work', color: '#22c55e' })] })
        : jsonResponse(200, apiEvent()),
    ),
  )
  const { queryClient } = renderWithProviders(<EditorDialog />)
  await waitFor(() => {
    expect(queryClient.getQueryData(queryKeys.calendars)).toBeDefined()
  })
  act(() => {
    useUi.getState().openEditor(editor)
  })
  return { fetch, dialog: await screen.findByRole('dialog') }
}

/**
 * Open the editor for `event` with the events of calendar `c1` loaded beside it, as the calendar behind the editor
 * has them (FR-09). The server refuses the first write as a conflict, as when another app changed the event since
 * it was read, and from then on lists `current` instead of `event` (nothing for `null`). It takes any later write.
 */
async function openConflicted(event: CalEvent, current: ApiEvent | null) {
  api.setCsrfToken('tok')
  let refused = false
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = urlOf(input)
    if (url.endsWith('/calendars')) return Promise.resolve(jsonResponse(200, { calendars: [calendar()] }))
    if (url.includes('/calendars/c1/events?')) {
      const shown = refused ? (current ? [current] : []) : [apiEvent({ id: event.id, etag: event.etag })]
      return Promise.resolve(jsonResponse(200, { events: shown }))
    }
    if (init?.method === 'PUT' && !refused) {
      refused = true
      return Promise.resolve(jsonResponse(409, { error: { code: 'conflict', message: 'x' } }))
    }
    return Promise.resolve(jsonResponse(200, apiEvent({ id: event.id, etag: '"3"' })))
  })
  const { queryClient } = renderWithProviders(<EditorDialog />)
  await queryClient.query({
    queryKey: queryKeys.events('c1', 'a', 'b'),
    queryFn: ({ signal }) => endpoints.listEvents('c1', new Date('2026-09-21'), new Date('2026-09-28'), signal),
  })
  await waitFor(() => {
    expect(queryClient.getQueryData(queryKeys.calendars)).toBeDefined()
  })
  act(() => {
    useUi.getState().openEditor({ mode: 'edit', event })
  })
  return { fetch, dialog: await screen.findByRole('dialog') }
}

/** The `If-Match` of each write, in order. */
function writtenEtags(fetch: { mock: { calls: [RequestInfo | URL, RequestInit?][] } }): string[] {
  return fetch.mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => (init?.headers as Record<string, string>)['If-Match'] ?? '')
}

describe('a time summer time skips', () => {
  afterEach(() => {
    useUi.getState().openEditor(null)
    vi.restoreAllMocks()
  })

  /** The create editor with times on 29 March 2026, when Berlin skips 02:00 to 03:00. */
  const night = (startTime: string, endTime: string): CreateEditorState => ({
    ...create,
    draft: { ...create.draft, event: { allDay: false, startDate: '2026-03-29', startTime, endDate: '2026-03-29', endTime } },
  })
  const note = (time: string, saved: string) =>
    `Clocks go forward on this day: ${time} doesn't exist and is saved as ${saved}.`

  it('says that the start is saved an hour later', async () => {
    const { dialog } = await openEditor(night('02:30', '04:00'))
    expect(within(dialog).getByText(note('2:30 AM', '3:30 AM'))).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'Start time' })).toHaveAccessibleDescription(note('2:30 AM', '3:30 AM'))
  })

  it('drops the note once the time exists', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor(night('02:30', '04:00'))
    expect(within(dialog).getByText(note('2:30 AM', '3:30 AM'))).toBeInTheDocument()
    await user.click(within(dialog).getByRole('combobox', { name: 'Start time' }))
    await user.click(screen.getByRole('option', { name: '1:30 AM' }))
    expect(within(dialog).queryByText(/Clocks go forward/)).not.toBeInTheDocument()
  })

  it('says it for start and end alike, and saves them where it says', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openEditor(night('02:15', '02:45'))
    expect(within(dialog).getByText(note('2:15 AM', '3:15 AM'))).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'End time' })).toHaveAccessibleDescription(note('2:45 AM', '3:45 AM'))
    await user.type(within(dialog).getByPlaceholderText('Add a title'), 'Night shift')
    await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    })
    const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!
    expect(bodyOf(init)).toMatchObject({ start: '2026-03-29T01:15:00.000Z', end: '2026-03-29T01:45:00.000Z' })
  })
})

describe('typed times (FR-09)', () => {
  afterEach(() => {
    useUi.getState().openEditor(null)
    vi.restoreAllMocks()
  })

  const posts = (fetch: Awaited<ReturnType<typeof openEditor>>['fetch']) =>
    fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  /** Lets a submit that shouldn't have happened reach the server mock. */
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  const typedNote = 'Enter a time like 9:40 AM.'

  it('saves a time typed and left by clicking Save', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openEditor(create)
    await user.click(within(dialog).getByRole('combobox', { name: 'Start time' }))
    await user.keyboard('940')
    await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
    await waitFor(() => {
      expect(posts(fetch)).toHaveLength(1)
    })
    // 9:40 in Berlin, and the hour the event lasted.
    expect(bodyOf(posts(fetch)[0]![1])).toMatchObject({ start: '2026-03-11T08:40:00.000Z', end: '2026-03-11T09:40:00.000Z' })
  })

  it('Enter in a time field commits without saving', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openEditor(create)
    const start = within(dialog).getByRole('combobox', { name: 'Start time' })
    await user.click(start)
    await user.keyboard('940{Enter}')
    await settle()
    expect(posts(fetch)).toHaveLength(0)
    expect(start).toHaveValue('9:40 AM')
    expect(start).toHaveFocus()
    expect(within(dialog).getByRole('combobox', { name: 'End time' })).toHaveValue('10:40 AM')
  })

  it("says what to type for an unreadable time and doesn't save", async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openEditor(create)
    const start = within(dialog).getByRole('combobox', { name: 'Start time' })
    await user.click(start)
    await user.keyboard('9:4x')
    await user.tab()
    // At once, not only after Save.
    expect(within(dialog).getByText(typedNote)).toBeInTheDocument()
    expect(start).toHaveValue('9:4x')
    expect(start).toHaveAttribute('aria-invalid', 'true')
    expect(start).toHaveAccessibleDescription(typedNote)
    expect(within(dialog).getByRole('combobox', { name: 'End time' })).toHaveValue('12:00 PM')
    await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
    await settle()
    expect(posts(fetch)).toHaveLength(0)
    expect(dialog).toBeInTheDocument()
  })

  it('says it for an end time too, before the end error', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor(create)
    const end = within(dialog).getByRole('combobox', { name: 'End time' })
    await user.click(end)
    await user.keyboard('noon{Enter}')
    expect(within(dialog).getByText(typedNote)).toBeInTheDocument()
    expect(end).toHaveAttribute('aria-invalid', 'true')
    expect(end).toHaveAccessibleDescription(typedNote)
  })

  it("an unreadable time hidden by All day doesn't block saving", async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openEditor(create)
    await user.click(within(dialog).getByRole('combobox', { name: 'Start time' }))
    await user.keyboard('9:4x')
    await user.tab()
    await user.click(within(dialog).getByRole('switch', { name: 'All day' }))
    expect(within(dialog).queryByText(typedNote)).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
    await waitFor(() => {
      expect(posts(fetch)).toHaveLength(1)
    })
    expect(bodyOf(posts(fetch)[0]![1])).toMatchObject({ allDay: true })
  })

  it('Escape in a time field restores it and keeps the editor open', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor(create)
    const start = within(dialog).getByRole('combobox', { name: 'Start time' })
    await user.click(start)
    await user.keyboard('5')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(start).toHaveValue('11:00 AM')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(dialog).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })
})

describe('typed dates (FR-09)', () => {
  beforeEach(() => {
    // Only the date, as the example in the message is today's: fake timers would stall the requests.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 2, 11, 12))
  })

  afterEach(() => {
    vi.useRealTimers()
    useUi.getState().openEditor(null)
    vi.restoreAllMocks()
  })

  const posts = (fetch: Awaited<ReturnType<typeof openEditor>>['fetch']) =>
    fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  /** Lets a submit that shouldn't have happened reach the server mock. */
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  const dateNote = 'Enter a date like 3/11/2026.'

  it('saves a typed start date and keeps the length', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openEditor(create)
    await user.click(within(dialog).getByRole('combobox', { name: 'Start' }))
    await user.keyboard('3/12')
    await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
    await waitFor(() => {
      expect(posts(fetch)).toHaveLength(1)
    })
    // A day later, start and end: 11:00-12:00 in Berlin.
    expect(bodyOf(posts(fetch)[0]![1])).toMatchObject({ start: '2026-03-12T10:00:00.000Z', end: '2026-03-12T11:00:00.000Z' })
  })

  it("says what to type for an unreadable date and doesn't save", async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openEditor(create)
    const start = within(dialog).getByRole('combobox', { name: 'Start' })
    await user.click(start)
    await user.keyboard('13/45')
    await user.tab()
    // At once, not only after Save.
    expect(within(dialog).getByText(dateNote)).toBeInTheDocument()
    expect(start).toHaveValue('13/45')
    expect(start).toHaveAttribute('aria-invalid', 'true')
    expect(start).toHaveAccessibleDescription(dateNote)
    // The note is about the date: the time beside it isn't described by it.
    expect(within(dialog).getByRole('combobox', { name: 'Start time' })).toHaveAccessibleDescription('')
    expect(within(dialog).getByRole('combobox', { name: 'End' })).toHaveValue('Wed, Mar 11')
    await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
    await settle()
    expect(posts(fetch)).toHaveLength(0)
    expect(dialog).toBeInTheDocument()
  })

  // The forms' own shape, which en-US doesn't read, but no day the calendar has (FR-09).
  it.each(['2026-13-45', '2026-02-31'])("says what to type for %s, which isn't a day, and doesn't save", async (typed) => {
    const user = userEvent.setup()
    const errors: unknown[] = []
    const onError = (e: ErrorEvent) => {
      errors.push(e.error)
    }
    window.addEventListener('error', onError)
    try {
      const { fetch, dialog } = await openEditor(create)
      const start = within(dialog).getByRole('combobox', { name: 'Start' })
      await user.click(start)
      await user.keyboard(typed)
      await user.tab()
      expect(errors).toEqual([])
      expect(within(dialog).getByText(dateNote)).toBeInTheDocument()
      expect(start).toHaveValue(typed)
      expect(start).toHaveAttribute('aria-invalid', 'true')
      expect(start).toHaveAccessibleDescription(dateNote)
      // Nothing is read from it: the end stays.
      expect(within(dialog).getByRole('combobox', { name: 'End' })).toHaveValue('Wed, Mar 11')
      await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
      await settle()
      expect(posts(fetch)).toHaveLength(0)
      expect(errors).toEqual([])
    } finally {
      window.removeEventListener('error', onError)
    }
  })

  // Each field that can't be read is described by a note about itself, the date's first (FR-09, NFR-27).
  it.each([
    ['Start', 'Start time', '13/45', '9:4x'],
    ['End', 'End time', '3/x', '9:3x'],
  ])('says what to type for %s date and time that both cannot be read, each below the row', async (date, time, typedDate, typedTime) => {
    const user = userEvent.setup()
    const { dialog } = await openEditor(create)
    const dateField = within(dialog).getByRole('combobox', { name: date })
    const timeField = within(dialog).getByRole('combobox', { name: time })
    await user.click(dateField)
    await user.keyboard(typedDate)
    await user.tab()
    await user.click(timeField)
    await user.keyboard(typedTime)
    await user.tab()
    const timeNote = 'Enter a time like 9:40 AM.'
    expect(dateField).toHaveAttribute('aria-invalid', 'true')
    expect(dateField).toHaveAccessibleDescription(dateNote)
    expect(timeField).toHaveAttribute('aria-invalid', 'true')
    expect(timeField).toHaveAccessibleDescription(timeNote)
    const notes = within(dialog).getAllByText(/^Enter a (date|time) like/).map((n) => n.textContent)
    expect(notes).toEqual([dateNote, timeNote])
  })

  it('says it for an end date, and marks only the end date', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor(create)
    const end = within(dialog).getByRole('combobox', { name: 'End' })
    await user.click(end)
    await user.keyboard('3/x{Enter}')
    expect(within(dialog).getByText(dateNote)).toBeInTheDocument()
    expect(end).toHaveAttribute('aria-invalid', 'true')
    expect(end).toHaveAccessibleDescription(dateNote)
    const endTime = within(dialog).getByRole('combobox', { name: 'End time' })
    expect(endTime).not.toHaveAttribute('aria-invalid')
    expect(endTime).toHaveAccessibleDescription('')
  })

  it('keeps the length when an unreadable start time is corrected', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor(create)
    const start = within(dialog).getByRole('combobox', { name: 'Start time' })
    const end = within(dialog).getByRole('combobox', { name: 'End time' })
    await user.click(start)
    await user.keyboard('9:4x')
    await user.tab()
    // The end stays while the start can't be read.
    expect(end).toHaveValue('12:00 PM')
    await user.click(start)
    await user.keyboard('940')
    await user.tab()
    // The hour the event lasted before the unreadable step.
    expect(end).toHaveValue('10:40 AM')
  })

  it('keeps the length when an unreadable start date is corrected', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openEditor(create)
    const start = within(dialog).getByRole('combobox', { name: 'Start' })
    const end = within(dialog).getByRole('combobox', { name: 'End' })
    await user.click(start)
    await user.keyboard('13/45')
    await user.tab()
    expect(end).toHaveValue('Wed, Mar 11')
    await user.click(start)
    await user.keyboard('3/13')
    await user.tab()
    expect(end).toHaveValue('Fri, Mar 13')
    await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
    await waitFor(() => {
      expect(posts(fetch)).toHaveLength(1)
    })
    expect(bodyOf(posts(fetch)[0]![1])).toMatchObject({ start: '2026-03-13T10:00:00.000Z', end: '2026-03-13T11:00:00.000Z' })
  })

  it('keeps an unreadable end as typed when the start moves', async () => {
    const user = userEvent.setup()
    const errors: unknown[] = []
    const onError = (e: ErrorEvent) => {
      errors.push(e.error)
    }
    window.addEventListener('error', onError)
    try {
      const { fetch, dialog } = await openEditor(create)
      const end = within(dialog).getByRole('combobox', { name: 'End' })
      await user.click(end)
      await user.keyboard('3/x{Enter}')
      const startTime = within(dialog).getByRole('combobox', { name: 'Start time' })
      await user.click(startTime)
      await user.keyboard('2pm{Enter}')
      expect(errors).toEqual([])
      expect(startTime).toHaveValue('2:00 PM')
      // The end stays as typed, and still says what to type.
      expect(end).toHaveValue('3/x')
      expect(within(dialog).getByText(dateNote)).toBeInTheDocument()
      await user.click(within(dialog).getByRole('combobox', { name: 'Start' }))
      await user.keyboard('3/12{Enter}')
      expect(errors).toEqual([])
      expect(end).toHaveValue('3/x')
      // Still unreadable, the end keeps the event from being created.
      await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
      await settle()
      expect(posts(fetch)).toHaveLength(0)
      expect(errors).toEqual([])
    } finally {
      window.removeEventListener('error', onError)
    }
  })

  it('names the repeat presets after the last readable start date', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor(create)
    await user.click(within(dialog).getByRole('combobox', { name: 'Start' }))
    await user.keyboard('13/45')
    await user.tab()
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    expect(screen.getByRole('option', { name: 'Every week on Wednesday' })).toBeInTheDocument()
  })

  it('Escape in a date field restores it and keeps the editor open', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor(create)
    const start = within(dialog).getByRole('combobox', { name: 'Start' })
    await user.click(start)
    await user.keyboard('4/2')
    expect(screen.getByRole('dialog', { name: 'Start date' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(start).toHaveValue('3/11/2026')
    expect(screen.queryByRole('dialog', { name: 'Start date' })).toBeNull()
    expect(dialog).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })
})

describe('EventEditor', () => {
  afterEach(() => {
    useUi.getState().openEditor(null)
    vi.restoreAllMocks()
  })

  it('moves the whole event to the start date picked in the month', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openEditor(create)
    await user.type(within(dialog).getByPlaceholderText('Add a title'), 'Review')

    await user.click(within(dialog).getByRole('combobox', { name: 'Start' }))
    await user.click(screen.getByRole('button', { name: 'Friday, March 13th, 2026' }))
    expect(within(dialog).getByRole('combobox', { name: 'End' })).toHaveDisplayValue(/^Fri, Mar 13/)
    expect(within(dialog).getByText('1 hr')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    })
    const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!
    expect(bodyOf(init)).toMatchObject({
      title: 'Review',
      start: '2026-03-13T10:00:00.000Z',
      end: '2026-03-13T11:00:00.000Z',
    })
  })

  it('opens with the title and calendar it was given', async () => {
    const { dialog } = await openEditor({ mode: 'create', draft: { ...create.draft, title: 'Review', calendarId: 'c2' } })
    expect(within(dialog).getByPlaceholderText('Add a title')).toHaveValue('Review')
    expect(within(dialog).getByRole('combobox', { name: 'Calendar' })).toHaveTextContent('Work')
  })

  it('names the repeat presets after the start date', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor(create)
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Does not repeat',
      'Every day',
      'Every week on Wednesday',
      'Every month on day 11',
      'Every year on March 11',
      'Custom…',
    ])
  })

  it('creates an event with a custom repeat from the repeat editor', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openEditor(create)
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Custom…' }))

    const repeat = screen.getByRole('dialog', { name: 'Custom repeat' })
    const interval = within(repeat).getByRole('spinbutton', { name: 'Repeat every' })
    await user.clear(interval)
    await user.type(interval, '2')
    await user.click(within(repeat).getByRole('button', { name: 'Monday' }))
    await user.click(within(repeat).getByRole('button', { name: 'Done' }))

    expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Every 2 weeks on Monday and Wednesday')
    await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    })
    const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!
    expect(bodyOf(init)).toMatchObject({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=SU' })
  })

  // FR-17: a timed series ends with the end of its last day, as UTC, so that day's event stays.
  it('ends a custom repeat at the end of its last day', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openEditor(create)
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Custom…' }))
    const repeat = screen.getByRole('dialog', { name: 'Custom repeat' })
    // The end date defaults to three months after the start: Thursday, June 11.
    await user.click(within(repeat).getByRole('radio', { name: 'On' }))
    await user.click(within(repeat).getByRole('button', { name: 'Done' }))
    expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Every week on Wednesday, until Thu, Jun 11')

    await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    })
    const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!
    expect(bodyOf(init)).toMatchObject({ rrule: 'FREQ=WEEKLY;UNTIL=20260611T215959Z' })
  })

  it.each([
    ['FREQ=WEEKLY;BYDAY=MO,TH', 'Every week on Monday and Thursday'],
    ['FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO', 'Every month on the last Monday'],
  ])('puts a custom rule into words (%s)', async (rrule, text) => {
    const event = toCalEvent(apiEvent({ recurring: true, rrule }))
    const { dialog } = await openEditor({ mode: 'edit', event })
    expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent(text)
    expect(dialog).not.toHaveTextContent(/FREQ/)
  })

  // A series in New York at 18:00 shows at midnight in Berlin, a day later, and is edited in New York (FR-17, FR-18).
  const newYork = (rrule: string) =>
    toCalEvent(
      apiEvent({
        recurring: true,
        rrule,
        timezone: 'America/New_York',
        endTimezone: 'America/New_York',
        start: '2026-11-10T23:00:00Z',
        end: '2026-11-11T00:00:00Z',
        recurrenceId: '2026-11-10T23:00:00Z',
      }),
    )

  it('edits the repeat of a series in another zone on its own days, and keeps its zone', async () => {
    const user = userEvent.setup()
    const { dialog, fetch } = await openEditor({ mode: 'edit', event: newYork('FREQ=WEEKLY;BYDAY=TU,TH') })
    const select = within(dialog).getByRole('combobox', { name: 'Repeat' })
    expect(select).toHaveTextContent('Every week on Tuesday and Thursday')

    await user.click(select)
    await user.click(screen.getByRole('option', { name: 'Custom…' }))
    const repeat = screen.getByRole('dialog', { name: 'Custom repeat' })
    expect(within(repeat).getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(repeat).getByRole('button', { name: 'Thursday' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(repeat).getByRole('button', { name: 'Wednesday' })).toHaveAttribute('aria-pressed', 'false')
    const interval = within(repeat).getByRole('spinbutton', { name: 'Repeat every' })
    await user.clear(interval)
    await user.type(interval, '2')
    await user.click(within(repeat).getByRole('button', { name: 'Done' }))

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: 'All events' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    })
    const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'PUT')!
    const body = bodyOf(init)
    expect(body).not.toHaveProperty('timezone')
    expect(body).not.toHaveProperty('endTimezone')
    expect(body.rrule).toMatch(/^FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH(;|$)/)
  })

  // #11: a weekly series on Tuesdays at 10:00, changed from its event of 10 November to Fridays.
  it('says that a changed repeat moves an event of a series it no longer falls on', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({
        recurring: true,
        rrule: 'FREQ=WEEKLY',
        start: '2026-11-10T09:00:00Z',
        end: '2026-11-10T10:00:00Z',
        recurrenceId: '2026-11-10T09:00:00Z',
      }),
    )
    const { dialog } = await openEditor({ mode: 'edit', event })
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Custom…' }))
    const repeat = screen.getByRole('dialog', { name: 'Custom repeat' })
    await user.click(within(repeat).getByRole('button', { name: 'Friday' }))
    await user.click(within(repeat).getByRole('button', { name: 'Tuesday' }))
    expect(within(repeat).getByText("The repeat doesn't fall on Tue, Nov 10, so this event moves to Fri, Nov 13.")).toBeInTheDocument()
  })

  // #11: the exception of 10 November, moved to Monday, 9 November, stays where it is.
  it('says that an exception stays where a changed repeat no longer falls on it', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({
        recurring: true,
        modified: true,
        override: true,
        rrule: 'FREQ=WEEKLY',
        start: '2026-11-09T09:00:00Z',
        end: '2026-11-09T10:00:00Z',
        recurrenceId: '2026-11-10T09:00:00Z',
      }),
    )
    const { dialog } = await openEditor({ mode: 'edit', event })
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Custom…' }))
    const repeat = screen.getByRole('dialog', { name: 'Custom repeat' })
    await user.click(within(repeat).getByRole('button', { name: 'Friday' }))
    await user.click(within(repeat).getByRole('button', { name: 'Tuesday' }))
    expect(within(repeat).getByText("This event stays where it is, though the repeat doesn't fall on it.")).toBeInTheDocument()
  })

  // A weekly series on Tuesdays at 10:00 whose event of 10 November is moved to Monday, 9 November (FR-17).
  it("names the repeat of an exception moved off the series' days after the series", async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({
        recurring: true,
        modified: true,
        rrule: 'FREQ=WEEKLY',
        start: '2026-11-09T09:00:00Z',
        end: '2026-11-09T10:00:00Z',
        recurrenceId: '2026-11-10T09:00:00Z',
      }),
    )
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })
    const select = within(dialog).getByRole('combobox', { name: 'Repeat' })
    expect(select).toHaveTextContent('Every week on Tuesday')

    await user.click(select)
    expect(screen.getByRole('option', { name: 'Every month on day 10' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'Custom…' }))
    const repeat = screen.getByRole('dialog', { name: 'Custom repeat' })
    expect(within(repeat).getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(repeat).getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'false')
    const interval = within(repeat).getByRole('spinbutton', { name: 'Repeat every' })
    await user.clear(interval)
    await user.type(interval, '2')
    await user.click(within(repeat).getByRole('button', { name: 'Done' }))
    expect(select).toHaveTextContent('Every 2 weeks on Tuesday')

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: 'All events' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    })
    const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'PUT')!
    expect(bodyOf(init).rrule).toMatch(/^FREQ=WEEKLY;INTERVAL=2;BYDAY=TU(;|$)/)
  })

  it("moves the series' days with the exception's new date", async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({
        recurring: true,
        modified: true,
        rrule: 'FREQ=WEEKLY',
        start: '2026-11-09T09:00:00Z',
        end: '2026-11-09T10:00:00Z',
        recurrenceId: '2026-11-10T09:00:00Z',
      }),
    )
    const { dialog } = await openEditor({ mode: 'edit', event })
    await user.click(within(dialog).getByRole('combobox', { name: 'Start' }))
    await user.click(screen.getByRole('button', { name: 'Tuesday, November 10th, 2026' }))
    expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Every week on Wednesday')
  })

  it('offers the custom repeat for a rule of a series in another zone, read in its zone', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor({ mode: 'edit', event: newYork('FREQ=MONTHLY;BYMONTHDAY=10') })
    const select = within(dialog).getByRole('combobox', { name: 'Repeat' })
    expect(select).toHaveTextContent('Every month on day 10')
    expect(select).not.toHaveTextContent('America/New_York')

    await user.click(select)
    expect(screen.queryByRole('option', { name: 'Every month on day 11' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Custom…' })).toBeInTheDocument()
  })

  // FR-17: the hours of a rule from another app repeat at the start's minute, 10:30 in Berlin here.
  it('names the times of a rule after the start time', async () => {
    const event = toCalEvent(
      apiEvent({ recurring: true, rrule: 'FREQ=DAILY;BYHOUR=9,17', start: '2026-09-25T08:30:00Z', end: '2026-09-25T09:00:00Z' }),
    )
    const { dialog } = await openEditor({ mode: 'edit', event })
    expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Every day at 9:30 AM and 5:30 PM')
  })

  it('shows the calendar as fixed when editing a series', async () => {
    const event = toCalEvent(apiEvent({ title: 'Gym', recurring: true, rrule: 'FREQ=WEEKLY' }))
    const { dialog } = await openEditor({ mode: 'edit', event })
    expect(within(dialog).queryByRole('combobox', { name: 'Calendar' })).toBeNull()
    expect(within(dialog).getByText('Personal')).toBeInTheDocument()
  })

  // FR-18: the zone shows only where it says something; an event in the browser's zone offers another.
  it.each([
    ['America/New_York', true],
    ['Europe/Berlin', false],
  ])('shows the zone fields only when the event has another zone (%s)', async (timezone, shown) => {
    const { dialog } = await openEditor({ mode: 'edit', event: toCalEvent(apiEvent({ timezone, endTimezone: timezone })) })
    expect(within(dialog).queryByRole('combobox', { name: 'Start time zone' }) !== null).toBe(shown)
    expect(within(dialog).queryByRole('button', { name: 'Other time zone' }) === null).toBe(shown)
  })

  // FR-17, FR-18: a series keeps its zone when its rule changes, and nothing says otherwise.
  it("keeps a series' zone when its rule changes", async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({
        id: 'e1',
        recurring: true,
        rrule: 'FREQ=WEEKLY',
        recurrenceId: '2026-09-25T08:00:00Z',
        timezone: 'America/New_York',
        endTimezone: 'America/New_York',
      }),
    )
    const { dialog } = await openEditor({ mode: 'edit', event })
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Every day' }))
    expect(within(dialog).getByRole('combobox', { name: 'Start time zone' })).toHaveValue('New York')
    expect(within(dialog).queryByText('A new time zone applies to all events or the following ones.')).toBeNull()
  })

  it('asks on save which events of a series change, and saves only this one', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog', { name: 'This event repeats. Which events should change?' })

    await user.click(within(question).getByRole('button', { name: 'Only this event' }))
    await waitFor(() => {
      expect(
        fetch.mock.calls.some(
          ([input, init]) =>
            init?.method === 'PUT' && urlOf(input).endsWith('/events/e1/occurrences/2026-09-25T08%3A00%3A00Z'),
        ),
      ).toBe(true)
    })
    const [, init] = fetch.mock.calls.find(
      ([input, i]) => i?.method === 'PUT' && urlOf(input).includes('/occurrences/'),
    )!
    expect(bodyOf(init)).not.toHaveProperty('rrule')
    expect(bodyOf(init)).not.toHaveProperty('instanceStart')
  })

  it('saves all events of a series', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog')
    await user.click(within(question).getByRole('button', { name: 'All events' }))

    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))).toBe(
        true,
      )
    })
    const [, init] = fetch.mock.calls.find(([input, i]) => i?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))!
    expect(bodyOf(init)).toHaveProperty('instanceStart', '2026-09-25T08:00:00Z')
  })

  it('saves a change between all-day and timed for the whole series without asking', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, first: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('switch', { name: 'All day' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))).toBe(
        true,
      )
    })
  })

  it("saves only this event without asking when the series can't follow the new day", async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=MONTHLY;BYMONTHDAY=25', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('combobox', { name: 'Start' }))
    await user.click(screen.getByRole('button', { name: 'Saturday, September 26th, 2026' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    })
    const puts = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(puts).toHaveLength(1)
    const [url, init] = puts[0]!
    expect(urlOf(url)).toBe(`/api/v1/events/e1/occurrences/${encodeURIComponent('2026-09-25T08:00:00Z')}`)
    expect(bodyOf(init)).toMatchObject({ start: '2026-09-26T08:00:00.000Z', end: '2026-09-26T09:00:00.000Z' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  // FR-17: with one option, the footer says before Save what it reaches; red only where it deletes.
  it('warns in the footer before a new rule replaces the series', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, first: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog } = await openEditor({ mode: 'edit', event })
    // Unchanged, a save can still reach either, and the question will ask.
    expect(within(dialog).queryByText('Applies to every event in the series.')).toBeNull()

    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Every day' }))
    const all = within(dialog).getByText('Applies to every event in the series.')
    // Muted, in the size and weight of the drag pill (spec §2).
    expect(all).toHaveClass('text-xs', 'font-medium', 'text-muted-foreground')
    expect(Array.from(all.querySelectorAll('circle'), (c) => c.getAttribute('fill'))).toEqual(Array(5).fill('#3b82f6'))

    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Does not repeat' }))
    expect(within(dialog).queryByText('Applies to every event in the series.')).toBeNull()
    const removed = within(dialog).getByText('The series becomes this one event. All others are deleted.')
    expect(removed).toHaveClass('text-xs', 'font-medium', 'text-muted-foreground')
    expect(Array.from(removed.querySelectorAll('circle'), (c) => c.getAttribute('fill'))).toEqual(
      Array(5).fill('var(--destructive)'),
    )
    // Screen readers hear it with Save (NFR-27).
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveAccessibleDescription(
      'The series becomes this one event. All others are deleted.',
    )
  })

  // FR-17: the hint follows the form; it is about what Save would do now, not when it opened.
  it('shows the hint only while the date keeps the series from following', async () => {
    const user = userEvent.setup()
    const hint = 'Only this event. The series stays on its days.'
    const event = toCalEvent(
      apiEvent({
        id: 'e1',
        start: '2026-10-15T08:00:00Z',
        end: '2026-10-15T09:00:00Z',
        recurring: true,
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
        recurrenceId: '2026-10-15T08:00:00Z',
      }),
    )
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })
    expect(within(dialog).queryByText(hint)).toBeNull()

    await user.click(within(dialog).getByRole('combobox', { name: 'Start' }))
    await user.click(screen.getByRole('button', { name: 'Friday, October 16th, 2026' }))
    expect(within(dialog).getByText(hint)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('combobox', { name: 'Start' }))
    await user.click(screen.getByRole('button', { name: 'Thursday, October 15th, 2026' }))
    expect(within(dialog).queryByText(hint)).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByRole('alertdialog', { name: 'This event repeats. Which events should change?' })).toBeInTheDocument()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  // At the first event, a new rule can only be the whole series' (FR-17), whatever day the event
  // moves to with it: there is nothing before it to keep.
  it('saves a new rule at the first event without asking', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({ id: 'e1', recurring: true, first: true, rrule: 'FREQ=MONTHLY;BYMONTHDAY=25', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('combobox', { name: 'Start' }))
    await user.click(screen.getByRole('button', { name: 'Saturday, September 26th, 2026' }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Every day' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    })
    const puts = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(puts).toHaveLength(1)
    const [url, init] = puts[0]!
    expect(urlOf(url)).toBe('/api/v1/events/e1')
    expect(bodyOf(init)).toMatchObject({ rrule: 'FREQ=DAILY', start: '2026-09-26T08:00:00.000Z' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  // FR-17: at a later event, a new rule reaches this and the following events, or all of them.
  it('asks this and following or all for a new rule at a later event', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })
    // The split's answer: the event in the new series, and the old series' new ETag.
    const answer = fetch.getMockImplementation()!
    fetch.mockImplementation((input, init) =>
      urlOf(input).includes('/following/')
        ? Promise.resolve(jsonResponse(200, { event: apiEvent({ id: 'e2' }), etag: '"2"' }))
        : answer(input, init),
    )

    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Every day' }))
    // Two options: a question, no hint.
    expect(within(dialog).queryByText('Applies to every event in the series.')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog', { name: 'This event repeats. Which events should change?' })
    const [following, all, cancel] = within(question).getAllByRole('button')
    expect(following).toHaveAccessibleName('This and following events')
    expect(following).toHaveAccessibleDescription(
      /^From Fri, Sep 25(, 2026)? on, as a series of its own\. Earlier ones stay as they are\.$/,
    )
    expect(all).toHaveAccessibleName('All events')
    expect(all).toHaveAccessibleDescription('Past ones too.')
    expect(cancel).toHaveAccessibleName('Cancel')
    // A new rule deletes nothing: the dots stay in the calendar's color, and the smallest change has the focus.
    expect(Array.from(following!.querySelectorAll('circle'), (c) => c.getAttribute('fill'))).toEqual([
      'none',
      'none',
      '#3b82f6',
      '#3b82f6',
      '#3b82f6',
    ])
    await waitFor(() => {
      expect(following).toHaveFocus()
    })

    await user.click(following!)
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    })
    const puts = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(puts).toHaveLength(1)
    const [url, init] = puts[0]!
    expect(urlOf(url)).toBe(`/api/v1/events/e1/following/${encodeURIComponent('2026-09-25T08:00:00Z')}`)
    expect(bodyOf(init)).toHaveProperty('rrule', 'FREQ=DAILY')
    expect(bodyOf(init)).not.toHaveProperty('instanceStart')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  // FR-17: removing the rule deletes events, this and the following ones' or all others; the
  // question says so in red and starts on Cancel, as a delete does.
  it('asks in red when the rule is removed from a later event', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Does not repeat' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog', { name: 'This event repeats. Which events should change?' })
    const [following, all, cancel] = within(question).getAllByRole('button')
    expect(following).toHaveAccessibleName('This and following events')
    expect(following).toHaveAccessibleDescription(
      /^From Fri, Sep 25(, 2026)? on, only this event stays\. Earlier ones stay as they are\.$/,
    )
    expect(all).toHaveAccessibleName('All events')
    expect(all).toHaveAccessibleDescription('Only this event stays. All others are deleted.')
    const red = 'var(--destructive)'
    expect(Array.from(following!.querySelectorAll('circle'), (c) => c.getAttribute('fill'))).toEqual(['none', 'none', red, red, red])
    expect(Array.from(all!.querySelectorAll('circle'), (c) => c.getAttribute('fill'))).toEqual(Array(5).fill(red))
    await waitFor(() => {
      expect(cancel).toHaveFocus()
    })
  })

  it('says in the question that attendees keep the series from being split', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({ id: 'e1', recurring: true, hasAttendees: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    const { dialog } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog', { name: 'This event repeats. Which events should change?' })
    expect(within(question).queryByRole('button', { name: 'This and following events' })).toBeNull()
    expect(question).toHaveAccessibleDescription("With attendees, the series can't be split.")
  })

  // FR-17: Apple writes an explicit "INTERVAL=1" the presets would otherwise
  // rewrite without it; the unchanged rule must still round-trip verbatim.
  it('asks and keeps an unrecognized rule verbatim when saving all events unchanged', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY;INTERVAL=1', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog', { name: 'This event repeats. Which events should change?' })
    await user.click(within(question).getByRole('button', { name: 'All events' }))

    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))).toBe(
        true,
      )
    })
    const [, init] = fetch.mock.calls.find(([input, i]) => i?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))!
    expect(bodyOf(init)).toHaveProperty('rrule', 'FREQ=WEEKLY;INTERVAL=1')
  })

  // FR-17: Done on an untouched rule hands it back as it came, so saving is no rule change.
  it('keeps a rule verbatim through the repeat editor when Done changes nothing', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY;INTERVAL=1', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Custom…' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Custom repeat' })).getByRole('button', { name: 'Done' }))

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog', { name: 'This event repeats. Which events should change?' })
    // An unchanged rule leaves "Only this event" among the choices; a new one would reach the series only.
    expect(within(question).getByRole('button', { name: /^Only this event/ })).toBeInTheDocument()
    await user.click(within(question).getByRole('button', { name: 'All events' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))).toBe(
        true,
      )
    })
    const [, init] = fetch.mock.calls.find(([input, i]) => i?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))!
    expect(bodyOf(init)).toHaveProperty('rrule', 'FREQ=WEEKLY;INTERVAL=1')
  })

  // FR-17: "All events" applies a changed rule from the series' start; the days chosen at a later event go along.
  it('writes the days chosen at a later event of a series into the rule', async () => {
    const user = userEvent.setup()
    // Friday, September 25 is the last Friday of its month.
    const event = toCalEvent(
      apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=MONTHLY;BYDAY=-1FR', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Custom…' }))
    const repeat = screen.getByRole('dialog', { name: 'Custom repeat' })
    await user.click(within(repeat).getByRole('radio', { name: 'On day' }))
    await user.click(within(repeat).getByRole('button', { name: 'Done' }))
    expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Every month on day 25')

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog', { name: 'This event repeats. Which events should change?' })
    await user.click(within(question).getByRole('button', { name: /^All events/ }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))).toBe(
        true,
      )
    })
    const [, init] = fetch.mock.calls.find(([input, i]) => i?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))!
    expect(bodyOf(init)).toHaveProperty('rrule', 'FREQ=MONTHLY;BYMONTHDAY=25')
  })

  // NFR-27: the focus goes back where it came from, on Done and on Escape.
  it.each([
    ['Done', (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Done' }))],
    ['Escape', (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
  ])('gives the focus back to the repeat select when the repeat editor closes (%s)', async (_, close) => {
    const user = userEvent.setup()
    const { dialog } = await openEditor(create)
    const select = within(dialog).getByRole('combobox', { name: 'Repeat' })
    await user.click(select)
    await user.click(screen.getByRole('option', { name: 'Custom…' }))
    await close(user)
    expect(screen.queryByRole('dialog', { name: 'Custom repeat' })).toBeNull()
    expect(select).toHaveFocus()
  })

  // FR-17: a series of dates from another app repeats; the repeat editor warns before it replaces them.
  it('names a series of dates without a rule, and warns before replacing it', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: '', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog } = await openEditor({ mode: 'edit', event })
    expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Repeats on set dates')
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Custom…' }))
    expect(
      within(screen.getByRole('dialog', { name: 'Custom repeat' })).getByText(
        "This repeat comes from another app and Lucid can't show all of it here. Done replaces it with the repeat above.",
      ),
    ).toBeInTheDocument()
  })

  it('cancels only the scope question on Escape, leaving the editor open (NFR-27)', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    within(dialog).getByRole('alertdialog')

    await user.keyboard('{Escape}')

    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveFocus()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  // FR-17: the question is about the values Save was pressed with; the form stays editable
  // meanwhile, and a change asks again on the next Save, about the new values.
  it('drops the scope question once the form changes, and saves the new values on the next Save', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    within(dialog).getByRole('alertdialog')
    const title = within(dialog).getByPlaceholderText('Add a title')
    await user.type(title, ' moved')

    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    // The edit keeps the focus where it is typed.
    expect(title).toHaveFocus()
    expect(title).toHaveValue('Event moved')
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: 'Only this event' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    })
    const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'PUT')!
    expect(bodyOf(init)).toHaveProperty('title', 'Event moved')
  })

  it('saves without asking after the question when the change makes the series all-day', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, first: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    within(dialog).getByRole('alertdialog')
    await user.click(within(dialog).getByRole('switch', { name: 'All day' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))).toBe(
        true,
      )
    })
    const [, init] = fetch.mock.calls.find(([input, i]) => i?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))!
    expect(bodyOf(init)).toHaveProperty('allDay', true)
  })

  // The scope question's buttons sit inside the editor's <form>; without type="button" they
  // default to "submit" and would also submit it, re-asking after Cancel or sending a second
  // PUT after a choice.
  it("does not resubmit the editor's form when the scope question is cancelled or answered", async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveFocus()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog')
    await user.click(within(question).getByRole('button', { name: 'Only this event' }))

    await waitFor(() => {
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
    })
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
  })

  describe('after a conflict (FR-09)', () => {
    it('says the event changed elsewhere, and saves over it with the ETag it has now', async () => {
      toast.dismiss()
      const user = userEvent.setup()
      const { fetch, dialog } = await openConflicted(toCalEvent(apiEvent()), apiEvent({ etag: '"2"', title: 'Theirs' }))

      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      const save = await within(dialog).findByRole('button', { name: 'Save anyway' })
      expect(save).toHaveAccessibleDescription(
        'Changed elsewhere since you opened it. Saving replaces those changes with yours.',
      )
      // Said once, by the editor, as a status; no toast besides.
      expect(within(dialog).getAllByRole('status').map((s) => s.textContent)).toContain(
        'Changed elsewhere since you opened it. Saving replaces those changes with yours.',
      )
      expect(toast.getToasts()).toEqual([])
      expect(within(dialog).getByPlaceholderText('Add a title')).toHaveValue('Event')

      await user.click(save)
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull()
      })
      expect(writtenEtags(fetch)).toEqual(['"1"', '"2"'])
    })

    it('says to close the editor when the reloaded calendar no longer holds the event', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openConflicted(toCalEvent(apiEvent()), null)

      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      const reopen = 'Changed elsewhere since you opened it. Close the editor to see the current version.'
      await waitFor(() => {
        expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveAccessibleDescription(reopen)
      })
      expect(within(dialog).getAllByRole('status').map((s) => s.textContent)).toContain(reopen)
      expect(writtenEtags(fetch)).toEqual(['"1"'])
    })

    it('saves only this event of a series over the change, after asking again', async () => {
      const user = userEvent.setup()
      const series = { id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }
      const { fetch, dialog } = await openConflicted(toCalEvent(apiEvent(series)), apiEvent({ ...series, etag: '"2"' }))

      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: 'Only this event' }))
      await user.click(await within(dialog).findByRole('button', { name: 'Save anyway' }))
      await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: 'Only this event' }))
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull()
      })
      expect(writtenEtags(fetch)).toEqual(['"1"', '"2"'])
    })
  })
})

describe('time zones (FR-18)', () => {
  afterEach(() => {
    useUi.getState().openEditor(null)
    vi.restoreAllMocks()
  })

  /** An event in New York, by default the one of 10 November at 18:00 of a series on Tuesdays and Thursdays. */
  const newYork = (p: Partial<ApiEvent> = {}) =>
    toCalEvent(
      apiEvent({
        recurring: true,
        rrule: 'FREQ=WEEKLY;BYDAY=TU,TH',
        timezone: 'America/New_York',
        endTimezone: 'America/New_York',
        start: '2026-11-10T23:00:00Z',
        end: '2026-11-11T00:00:00Z',
        recurrenceId: '2026-11-10T23:00:00Z',
        ...p,
      }),
    )
  /** A single event, without the series' fields. */
  const single: Partial<ApiEvent> = { recurring: false, rrule: '', recurrenceId: null }
  const zoneField = (dialog: HTMLElement, name: 'Start time zone' | 'End time zone') =>
    within(dialog).getByRole<HTMLInputElement>('combobox', { name })
  const put = async (fetch: Awaited<ReturnType<typeof openEditor>>['fetch']) => {
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    })
    const [url, init] = fetch.mock.calls.find(([, i]) => i?.method === 'PUT')!
    return { url: urlOf(url), body: bodyOf(init) }
  }

  it('shows a foreign series in its zone', async () => {
    const { dialog } = await openEditor({ mode: 'edit', event: newYork() })
    expect(within(dialog).getByRole('combobox', { name: 'Start time' })).toHaveValue('6:00 PM')
    expect(zoneField(dialog, 'Start time zone')).toHaveValue('New York')
    expect(zoneField(dialog, 'End time zone')).toHaveValue('New York')
    expect(within(dialog).getByText(/In your time zone \(Berlin\): Wed, Nov 11/)).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Every week on Tuesday and Thursday')
    expect(within(dialog).queryByRole('button', { name: 'Other time zone' })).toBeNull()
  })

  it('offers Other time zone for an event in your zone', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ timezone: '', endTimezone: '' }))
    const { dialog } = await openEditor({ mode: 'edit', event })
    expect(within(dialog).queryByRole('combobox', { name: 'Start time zone' })).toBeNull()
    expect(within(dialog).queryByRole('combobox', { name: 'End time zone' })).toBeNull()
    expect(within(dialog).queryByText(/In your time zone/)).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Other time zone' }))
    const start = zoneField(dialog, 'Start time zone')
    const end = zoneField(dialog, 'End time zone')
    for (const field of [start, end]) {
      expect(field).toHaveValue('')
      expect(field).toHaveAttribute('placeholder', 'Your time zone')
    }
    expect(start).toHaveFocus()
    expect(start).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox', { name: 'Start time zone' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Other time zone' })).toBeNull()
    expect(within(dialog).queryByText(/In your time zone/)).toBeNull()
  })

  it('changes the zone and keeps the clock', async () => {
    const user = userEvent.setup()
    const { dialog, fetch } = await openEditor({ mode: 'edit', event: newYork({ first: true }) })
    await user.click(zoneField(dialog, 'Start time zone'))
    await user.keyboard('Tokyo{Enter}')
    expect(zoneField(dialog, 'Start time zone')).toHaveValue('Tokyo')
    expect(zoneField(dialog, 'End time zone')).toHaveValue('Tokyo')
    expect(within(dialog).getByRole('combobox', { name: 'Start time' })).toHaveValue('6:00 PM')

    // The series' first event: a new zone applies to all of it, without a question.
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    const { url, body } = await put(fetch)
    expect(url).toBe('/api/v1/events/e1')
    expect(body).toMatchObject({
      timezone: 'Asia/Tokyo',
      endTimezone: 'Asia/Tokyo',
      start: '2026-11-10T09:00:00.000Z',
      end: '2026-11-10T10:00:00.000Z',
    })
  })

  it('asks no Only this event for a new zone', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor({ mode: 'edit', event: newYork() })
    const note = 'A new time zone applies to all events or the following ones.'
    expect(within(dialog).queryByText(note)).toBeNull()

    await user.click(zoneField(dialog, 'Start time zone'))
    await user.keyboard('Tokyo{Enter}')
    expect(within(dialog).getByText(note)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog', { name: 'This event repeats. Which events should change?' })
    expect(within(question).getAllByRole('button').map((b) => b.textContent)).toEqual([
      expect.stringContaining('This and following events'),
      expect.stringContaining('All events'),
      'Cancel',
    ])
    expect(within(question).queryByRole('button', { name: 'Only this event' })).toBeNull()
  })

  it('asks about only this event while the zone of a series stays', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor({ mode: 'edit', event: newYork() })
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog')
    expect(within(question).getByRole('button', { name: 'Only this event' })).toBeInTheDocument()
  })

  // 14 March 2027: New York skips 02:00 to 03:00, Berlin two weeks later.
  it.each([
    ['America/New_York', '2027-03-14T05:00:00Z', true],
    ['Europe/Berlin', '2027-03-13T23:00:00Z', false],
  ])("says a skipped time in the row's zone (%s)", async (timezone, start, shown) => {
    const user = userEvent.setup()
    const end = new Date(Date.parse(start) + 3600 * 1000).toISOString()
    const { dialog } = await openEditor({ mode: 'edit', event: newYork({ ...single, timezone, endTimezone: timezone, start, end }) })
    await user.click(within(dialog).getByRole('combobox', { name: 'Start time' }))
    await user.click(screen.getByRole('option', { name: '2:30 AM' }))
    const note = "Clocks go forward on this day: 2:30 AM doesn't exist and is saved as 3:30 AM."
    expect(within(dialog).queryByText(note) !== null).toBe(shown)
    expect(within(dialog).getByRole('combobox', { name: 'Start time' })).toHaveAccessibleDescription(shown ? note : '')
  })

  it('hides the zones while All day', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor({ mode: 'edit', event: newYork() })
    const allDay = within(dialog).getByRole('switch', { name: 'All day' })
    await user.click(allDay)
    expect(within(dialog).queryByRole('combobox', { name: 'Start time zone' })).toBeNull()
    expect(within(dialog).queryByRole('combobox', { name: 'End time zone' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Other time zone' })).toBeNull()
    expect(within(dialog).queryByText(/In your time zone/)).toBeNull()

    await user.click(allDay)
    expect(zoneField(dialog, 'Start time zone')).toHaveValue('New York')
    expect(zoneField(dialog, 'End time zone')).toHaveValue('New York')
    expect(zoneField(dialog, 'Start time zone')).not.toHaveFocus()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  // Another app made an event of the series all-day: given a time, it is in the series' zone, which a save keeps.
  it("shows an all-day event of a series with zones in the series' zone once it has a time", async () => {
    const user = userEvent.setup()
    const event = newYork({ first: true, allDay: true, start: '2026-11-10T00:00:00Z', end: '2026-11-11T00:00:00Z' })
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })
    expect(within(dialog).queryByRole('combobox', { name: 'Start time zone' })).toBeNull()
    await user.click(within(dialog).getByRole('switch', { name: 'All day' }))
    expect(zoneField(dialog, 'Start time zone')).toHaveValue('New York')
    expect(zoneField(dialog, 'End time zone')).toHaveValue('New York')
    expect(within(dialog).queryByRole('button', { name: 'Other time zone' })).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const { body } = await put(fetch)
    // 9:00 AM in New York, with no zone sent: the series stays in its own.
    expect(body).toMatchObject({ allDay: false, start: '2026-11-10T14:00:00.000Z' })
    expect(body).not.toHaveProperty('timezone')
    expect(body).not.toHaveProperty('endTimezone')
  })

  it('hides Other time zone while All day, and takes the focus only when it is clicked', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor({ mode: 'edit', event: toCalEvent(apiEvent({ timezone: '', endTimezone: '' })) })
    const allDay = within(dialog).getByRole('switch', { name: 'All day' })
    await user.click(within(dialog).getByRole('button', { name: 'Other time zone' }))
    await user.keyboard('{Escape}')
    await user.click(allDay)
    expect(within(dialog).queryByRole('button', { name: 'Other time zone' })).toBeNull()
    expect(within(dialog).queryByRole('combobox', { name: 'Start time zone' })).toBeNull()

    // Back from All day, the fields shown stay, but don't take the focus again.
    await user.click(allDay)
    expect(zoneField(dialog, 'Start time zone')).not.toHaveFocus()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Other time zone' })).toBeNull()
  })

  it.each([
    ["a single event's row to none", single, '', 'Your time zone'],
    ["a series' row to your zone", {}, 'Europe/Berlin', 'Berlin'],
  ])('the ✕ sets %s, and the fields stay', async (_, p, zone, text) => {
    const user = userEvent.setup()
    const { dialog } = await openEditor({ mode: 'edit', event: newYork(p) })
    const [clear] = within(dialog).getAllByRole('button', { name: 'Use your time zone' })
    await user.click(clear!)
    for (const name of ['Start time zone', 'End time zone'] as const) {
      const field = zoneField(dialog, name)
      if (zone === '') {
        expect(field).toHaveValue('')
        expect(field).toHaveAttribute('placeholder', text)
      } else {
        expect(field).toHaveValue(text)
      }
    }
    expect(within(dialog).queryByRole('button', { name: 'Use your time zone' })).toBeNull()
    expect(within(dialog).queryByText(/In your time zone/)).toBeNull()
    expect(within(dialog).getByRole('combobox', { name: 'Start time' })).toHaveValue('6:00 PM')
  })

  // The ✕ shows only where it changes the zone: a save gives a new series' rows without one the browser's anyway.
  it('has no ✕ on a row without a zone of an event made a series', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor({ mode: 'edit', event: toCalEvent(apiEvent({ timezone: '', endTimezone: '' })) })
    await user.click(within(dialog).getByRole('button', { name: 'Other time zone' }))
    await user.keyboard('{Escape}')
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Every day' }))
    expect(zoneField(dialog, 'Start time zone')).toHaveAttribute('placeholder', 'Your time zone')
    expect(within(dialog).queryByRole('button', { name: 'Use your time zone' })).toBeNull()

    // A zone picked has one, which sets the browser's.
    await user.click(zoneField(dialog, 'Start time zone'))
    await user.keyboard('Tokyo{Enter}')
    const [clear] = within(dialog).getAllByRole('button', { name: 'Use your time zone' })
    await user.click(clear!)
    expect(zoneField(dialog, 'Start time zone')).toHaveValue('Berlin')
    expect(zoneField(dialog, 'End time zone')).toHaveValue('Berlin')
  })

  it("keeps a single event's clock in the zone it is moved out of with the ✕", async () => {
    const user = userEvent.setup()
    const { dialog, fetch } = await openEditor({ mode: 'edit', event: newYork(single) })
    const [clear] = within(dialog).getAllByRole('button', { name: 'Use your time zone' })
    await user.click(clear!)
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    // 18:00 in Berlin, where an event without a zone is shown, and saved without one.
    expect((await put(fetch)).body).toMatchObject({
      timezone: '',
      endTimezone: '',
      start: '2026-11-10T17:00:00.000Z',
      end: '2026-11-10T18:00:00.000Z',
    })
  })
})
