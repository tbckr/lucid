import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { EditorDialog } from '@/components/EditorDialog'
import { type Calendar, type Todo } from '@/lib/api/schemas'
import { type TaskRepeat } from '@/lib/calendarTasks'
import { draftOf, type Draft } from '@/lib/quickCreate'
import { useUi } from '@/stores/ui'
import { bodyOf, calendar, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'

/**
 * Open the editor for `t`, at its `repeat` where given, and wait until its list is loaded. The server answers each
 * write to `t` with `t` itself: a split with a new series beside it, the delete of the whole task with nothing.
 */
async function openTask(t: Todo, list: Calendar = calendar(), repeat?: TaskRepeat) {
  api.setCsrfToken('tok')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = urlOf(input)
    if (url.endsWith('/calendars')) return Promise.resolve(jsonResponse(200, { calendars: [list] }))
    if (init?.method === 'DELETE' && url.endsWith(`/todos/${t.id}`)) {
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    if (init?.method === 'PUT' && url.includes('/following/')) {
      return Promise.resolve(jsonResponse(200, { todo: { ...t, id: 't9', uid: 'u9' }, series: { ...t, etag: '"2"' } }))
    }
    return Promise.resolve(jsonResponse(200, { ...t, etag: '"2"' }))
  })
  act(() => {
    useUi.getState().openTaskEditor({ mode: 'edit', todo: t, repeat })
  })
  const { queryClient } = renderWithProviders(<EditorDialog />)
  await waitFor(() => {
    expect(queryClient.getQueryData(queryKeys.calendars)).toBeDefined()
  })
  return { fetch, dialog: await screen.findByRole('dialog', { name: 'Edit task' }) }
}

/** Open the editor for a new task and wait until the lists are loaded. */
async function openNew(draft: Draft, lists: Calendar[] = [calendar()]) {
  api.setCsrfToken('tok')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
    Promise.resolve(
      urlOf(input).endsWith('/calendars')
        ? jsonResponse(200, { calendars: lists })
        : jsonResponse(201, todo({ title: draft.title, calendarId: draft.calendarId })),
    ),
  )
  act(() => {
    useUi.getState().openTaskEditor({ mode: 'create', draft })
  })
  const { queryClient } = renderWithProviders(<EditorDialog />)
  await waitFor(() => {
    expect(queryClient.getQueryData(queryKeys.calendars)).toBeDefined()
  })
  return { fetch, dialog: await screen.findByRole('dialog', { name: 'New task' }) }
}

// From a click at 10:15 on Wednesday, 30 September 2026: due then.
const slides: Draft = {
  ...draftOf(
    { start: new Date(2026, 8, 30, 10, 15), end: new Date(2026, 8, 30, 11, 15), allDay: false, granularity: 'time', ranged: false },
    'Europe/Berlin',
  ),
  title: 'Slides',
  calendarId: 'c1',
}

/** Body of the PUT the editor sent. */
async function saved(fetch: Awaited<ReturnType<typeof openTask>>['fetch']) {
  await waitFor(() => {
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
  })
  const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'PUT')!
  return bodyOf(init)
}

/** The path and body of the one write (`method`) the editor sent. */
async function wrote(fetch: Awaited<ReturnType<typeof openTask>>['fetch'], method: 'PUT' | 'DELETE') {
  await waitFor(() => {
    expect(fetch.mock.calls.some(([, init]) => init?.method === method)).toBe(true)
  })
  const writes = fetch.mock.calls.filter(([, init]) => init?.method === method)
  expect(writes).toHaveLength(1)
  const [input, init] = writes[0]!
  return { path: urlOf(input), body: bodyOf(init) }
}

/**
 * Open the editor for `t`, whose list the server lists as `current` (without `t` for `null`) once it refused the
 * first write as a conflict, as when another app changed the task since it was read (FR-09). It takes any later
 * write.
 */
async function openConflicted(t: Todo, current: Todo | null) {
  api.setCsrfToken('tok')
  let refused = false
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = urlOf(input)
    if (url.endsWith('/calendars')) return Promise.resolve(jsonResponse(200, { calendars: [calendar()] }))
    if (url.endsWith('/calendars/c1/todos')) {
      return Promise.resolve(jsonResponse(200, { todos: refused ? (current ? [current] : []) : [t] }))
    }
    if (init?.method === 'PUT' && !refused) {
      refused = true
      return Promise.resolve(jsonResponse(409, { error: { code: 'conflict', message: 'x' } }))
    }
    return Promise.resolve(jsonResponse(200, { ...t, etag: '"3"' }))
  })
  act(() => {
    useUi.getState().openTaskEditor({ mode: 'edit', todo: t })
  })
  renderWithProviders(<EditorDialog />)
  return { fetch, dialog: await screen.findByRole('dialog', { name: 'Edit task' }) }
}

/** The chevron beside a date or time field: a target of the mouse only, outside the accessibility tree. */
const chevronOf = (field: HTMLElement) => field.parentElement!.querySelector('svg')!.parentElement!

/** The `If-Match` of each write, in order. */
function writtenEtags(fetch: { mock: { calls: [RequestInfo | URL, RequestInit?][] } }): string[] {
  return fetch.mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => (init?.headers as Record<string, string>)['If-Match'] ?? '')
}

describe('TaskEditor', () => {
  afterEach(() => {
    useUi.getState().openTaskEditor(null)
    vi.restoreAllMocks()
  })

  it.each([
    ['Start', 'Remove start date', 'start', 'due'],
    ['Due', 'Remove due date', 'due', 'start'],
  ])('%s: its ✕ "%s" removes the date together with its time', async (row, button, removed, kept) => {
    const t = todo({ title: 'Slides', start: '2026-09-25T07:00:00Z', due: '2026-09-25T09:00:00Z' })
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(t)

    await user.click(within(dialog).getByRole('button', { name: button }))
    expect(within(dialog).getByRole('combobox', { name: row })).toHaveValue('')
    expect(within(dialog).getByRole('combobox', { name: row })).toHaveAttribute('placeholder', 'Add a date')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    const keptValue = new Date(t[kept as 'start' | 'due']!).toISOString()
    expect(await saved(fetch)).toMatchObject({ [removed]: null, [`${removed}AllDay`]: false, [kept]: keptValue })
  })

  it('completes the task from the check in front of its title', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ title: 'Slides' }))

    await user.click(within(dialog).getByRole('checkbox', { name: 'Completed' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await saved(fetch)).toMatchObject({ status: 'COMPLETED' })
  })

  it('says a task is overdue until it is checked off', async () => {
    const user = userEvent.setup()
    const { dialog } = await openTask(todo({ due: '2020-03-10T00:00:00Z', dueAllDay: true }))
    expect(within(dialog).getByText('Overdue')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('checkbox', { name: 'Completed' }))
    expect(within(dialog).queryByText('Overdue')).toBeNull()
  })

  it.each([
    [3, 'Medium', 5],
    [0, 'Low', 9],
    [5, 'None', 0],
    // The level stays High, so the exact RFC 5545 value is kept.
    [3, 'High', 3],
  ])('priority %i, then %s, saves %i', async (priority, level, want) => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ priority }))

    await user.click(within(dialog).getByRole('radio', { name: level }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await saved(fetch)).toMatchObject({ priority: want })
  })

  it('picks a start date in the month of the due date and gives it the due time', async () => {
    const user = userEvent.setup()
    // Due Friday, 13 March 2026, 14:00 in Berlin.
    const { fetch, dialog } = await openTask(todo({ due: '2026-03-13T13:00:00Z' }))

    await user.click(within(dialog).getByRole('combobox', { name: 'Start' }))
    await user.click(screen.getByRole('button', { name: 'Wednesday, March 11th, 2026' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await saved(fetch)).toMatchObject({ start: '2026-03-11T13:00:00.000Z', startAllDay: false })
  })

  it('makes a due date all-day with "No time"', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ due: '2026-03-13T13:00:00Z' }))

    await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
    await user.click(screen.getByRole('option', { name: 'No time' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await saved(fetch)).toMatchObject({ due: '2026-03-13T00:00:00.000Z', dueAllDay: true })
  })

  // Save leaves the field, which reads what was typed there: no Enter and no Tab first (FR-09).
  it('saves a due time typed right before Save is clicked', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ due: '2026-03-13T13:00:00Z' }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
    await user.keyboard('1440')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await saved(fetch)).toMatchObject({ due: '2026-03-13T13:40:00.000Z', dueAllDay: false })
  })

  it('says what to type for an unreadable due time', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ due: '2026-03-13T13:00:00Z' }))
    const due = within(dialog).getByRole('combobox', { name: 'Due time' })
    expect(due).toHaveValue('2:00 PM')

    await user.click(due)
    await user.keyboard('2:6')
    await user.tab()
    // At once, below the row, and the field says it is the one.
    const note = 'Enter a time like 9:40 AM.'
    expect(within(dialog).getByText(note)).toBeInTheDocument()
    expect(due).toHaveValue('2:6')
    expect(due).toHaveAttribute('aria-invalid', 'true')
    expect(due).toHaveAccessibleDescription(note)

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)

    // A readable time takes the note away and saves.
    await user.click(due)
    await user.keyboard('1440')
    await user.tab()
    expect(within(dialog).queryByText(note)).toBeNull()
    expect(due).not.toHaveAttribute('aria-invalid')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await saved(fetch)).toMatchObject({ due: '2026-03-13T13:40:00.000Z', dueAllDay: false })
  })

  describe('typed dates (FR-09)', () => {
    beforeEach(() => {
      // Only the date, as the example in the message is today's: fake timers would stall the requests.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 2, 11, 12))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    const dateNote = 'Enter a date like 3/11/2026.'

    it('saves a typed due date with its time', async () => {
      const user = userEvent.setup()
      // Due Friday, 13 March 2026, 14:00 in Berlin.
      const { fetch, dialog } = await openTask(todo({ due: '2026-03-13T13:00:00Z' }))
      const due = within(dialog).getByRole('combobox', { name: 'Due' })
      expect(due).toHaveValue('Fri, Mar 13')
      await user.click(due)
      await user.keyboard('3/20')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      expect(await saved(fetch)).toMatchObject({ due: '2026-03-20T13:00:00.000Z', dueAllDay: false })
    })

    it("says what to type for an unreadable due date, and doesn't save", async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(todo({ due: '2026-03-13T13:00:00Z' }))
      const due = within(dialog).getByRole('combobox', { name: 'Due' })
      await user.click(due)
      await user.keyboard('3/45')
      await user.tab()
      expect(within(dialog).getByText(dateNote)).toBeInTheDocument()
      expect(due).toHaveAttribute('aria-invalid', 'true')
      expect(due).toHaveAccessibleDescription(dateNote)
      // About the date: the time beside it isn't described by it, nor marked.
      const time = within(dialog).getByRole('combobox', { name: 'Due time' })
      expect(time).toHaveAccessibleDescription('')
      expect(time).not.toHaveAttribute('aria-invalid')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
      expect(dialog).toBeInTheDocument()
    })

    // Each field that can't be read is described by a note about itself, the date's first (FR-09, NFR-27).
    it('says what to type for a due date and time that both cannot be read, each below the row', async () => {
      const user = userEvent.setup()
      const { dialog } = await openTask(todo({ due: '2026-03-13T13:00:00Z' }))
      const due = within(dialog).getByRole('combobox', { name: 'Due' })
      const time = within(dialog).getByRole('combobox', { name: 'Due time' })
      await user.click(due)
      await user.keyboard('3/45')
      await user.tab()
      await user.click(time)
      await user.keyboard('2:6')
      await user.tab()
      const timeNote = 'Enter a time like 9:40 AM.'
      expect(due).toHaveAttribute('aria-invalid', 'true')
      expect(due).toHaveAccessibleDescription(dateNote)
      expect(time).toHaveAttribute('aria-invalid', 'true')
      expect(time).toHaveAccessibleDescription(timeNote)
      const notes = within(dialog).getAllByText(/^Enter a (date|time) like/).map((n) => n.textContent)
      expect(notes).toEqual([dateNote, timeNote])
    })

    // The forms' own shape, which en-US doesn't read, but no day the calendar has (FR-09).
    it("says what to type for a due date in the forms' shape that doesn't exist, and doesn't save", async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(todo({ due: '2026-03-13T13:00:00Z' }))
      const due = within(dialog).getByRole('combobox', { name: 'Due' })
      await user.click(due)
      await user.keyboard('2026-02-31')
      await user.tab()
      expect(within(dialog).getByText(dateNote)).toBeInTheDocument()
      expect(due).toHaveValue('2026-02-31')
      expect(due).toHaveAttribute('aria-invalid', 'true')
      expect(due).toHaveAccessibleDescription(dateNote)
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    })

    it('says only what to type for an unreadable due time, not that the start comes after it', async () => {
      const user = userEvent.setup()
      // Start 9:00, due 10:00 on Friday, 13 March 2026, in Berlin.
      const { fetch, dialog } = await openTask(todo({ start: '2026-03-13T08:00:00Z', due: '2026-03-13T09:00:00Z' }))
      const time = within(dialog).getByRole('combobox', { name: 'Due time' })
      await user.click(time)
      await user.keyboard('8:4x')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
      expect(time).toHaveAccessibleDescription('Enter a time like 9:40 AM.')
      expect(within(dialog).queryByText("The start can't be after the due date.")).toBeNull()
      expect(within(dialog).getByRole('combobox', { name: 'Start' })).not.toHaveAttribute('aria-invalid')
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    })

    it('keeps an order error on the fields it marks while a note below says what to type', async () => {
      const user = userEvent.setup()
      // Start 14:00, due 13:00 on Friday, 13 March 2026, in Berlin.
      const { dialog } = await openTask(todo({ start: '2026-03-13T13:00:00Z', due: '2026-03-13T12:00:00Z' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      const order = "The start can't be after the due date."
      expect(await within(dialog).findByText(order)).toBeInTheDocument()
      const date = within(dialog).getByRole('combobox', { name: 'Start' })
      const time = within(dialog).getByRole('combobox', { name: 'Start time' })
      await user.click(time)
      await user.keyboard('2:6')
      await user.tab()
      const timeNote = 'Enter a time like 9:40 AM.'
      expect(within(dialog).getByText(timeNote)).toBeInTheDocument()
      expect(within(dialog).getByText(order)).toBeInTheDocument()
      // The date is marked by the order, and described by it; the time note is not about it.
      expect(date).toHaveAttribute('aria-invalid', 'true')
      expect(date).toHaveAccessibleDescription(order)
      expect(time).toHaveAccessibleDescription(`${timeNote} ${order}`)
    })
  })

  it('saves a checklist item that was typed but not yet added', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ checklist: [{ text: '2 liters', done: false }] }))

    await user.click(within(dialog).getByRole('checkbox', { name: '2 liters done' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Add checklist item' }), 'check fridge')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await saved(fetch)).toMatchObject({
      checklist: [
        { text: '2 liters', done: true },
        { text: 'check fridge', done: false },
      ],
    })
  })

  it('removes a checklist item', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ checklist: [{ text: '2 liters', done: false }] }))

    await user.click(within(dialog).getByRole('button', { name: 'Remove 2 liters' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await saved(fetch)).toMatchObject({ checklist: [] })
  })

  it('asks in the footer before it deletes the task', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo())

    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Delete this task?')
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)

    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    })
  })

  it('keeps the focus in the footer while it asks before deleting', async () => {
    const user = userEvent.setup()
    const { dialog } = await openTask(todo())

    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(within(dialog).getByRole('button', { name: 'Delete task' })).toHaveFocus()
  })

  it('says a read-only list cannot be changed and offers no changes', async () => {
    const { dialog } = await openTask(todo(), calendar({ readOnly: true }))

    expect(within(dialog).getByText('This list is read-only.')).toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: 'Completed' })).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Delete task' })).toBeNull()
  })
  it('creates a task in the chosen list with the given dates', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openNew(slides)
    expect(within(dialog).getByPlaceholderText('Add a title')).toHaveValue('Slides')
    expect(within(dialog).queryByRole('button', { name: 'Delete task' })).toBeNull()
    expect(within(dialog).queryByRole('checkbox', { name: 'Completed' })).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Create task' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    })
    const [input, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!
    expect(urlOf(input)).toMatch(/\/calendars\/c1\/todos$/)
    expect(bodyOf(init)).toMatchObject({
      title: 'Slides',
      start: null,
      due: '2026-09-30T08:15:00.000Z',
      dueAllDay: false,
      status: 'NEEDS-ACTION',
    })
    await waitFor(() => {
      expect(useUi.getState().taskEditor).toBeNull()
    })
  })

  it('offers only lists that take new tasks', async () => {
    const user = userEvent.setup()
    const { dialog } = await openNew(slides, [
      calendar(),
      calendar({ id: 'c2', name: 'Shared', readOnly: true }),
      calendar({ id: 'c3', name: 'Work', supportsTodos: false }),
    ])
    await user.click(within(dialog).getByRole('combobox', { name: 'Task list' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Personal'])
  })

  it('keeps the due time of a task in the hour summer time repeats when only its title changes', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ due: '2026-10-25T01:30:00Z' }))
    await user.type(within(dialog).getByPlaceholderText('Add a title'), ' renamed')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect((await saved(fetch)).due).toBe('2026-10-25T01:30:00.000Z')
  })

  it('says that a due time summer time skips is saved an hour later', async () => {
    const { dialog } = await openNew({ ...slides, task: { startDate: '', startTime: '', dueDate: '2026-03-29', dueTime: '02:30' } })
    const note = "Clocks go forward on this day: 2:30 AM doesn't exist and is saved as 3:30 AM."
    expect(within(dialog).getByText(note)).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'Due time' })).toHaveAccessibleDescription(note)
  })

  describe('repeat', () => {
    // A task due Monday, Oct 5 that repeats on Mondays and Thursdays; Monday's is its current repeat.
    const series = todo({
      title: 'Water the flowers',
      due: '2026-10-05T00:00:00Z',
      dueAllDay: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
      recurring: true,
      fixedDays: true,
      recurrenceId: '2026-10-05T00:00:00Z',
      next: { start: null, due: '2026-10-08T00:00:00Z' },
    })
    const single = todo({ title: 'Slides', due: '2026-10-05T00:00:00Z', dueAllDay: true })
    // The same series with a time: due at 9:00 on Monday, the next repeat at 9:00 on Thursday.
    const timed = {
      ...series,
      due: '2026-10-05T07:00:00Z',
      dueAllDay: false,
      recurrenceId: '2026-10-05T07:00:00Z',
      next: { start: null, due: '2026-10-08T07:00:00Z' },
    }
    const last = { ...series, next: null }
    /** The repeat of `t` after its current one, on `due`, under its own `title` where another app gave it one. */
    const later = (t: Todo, due: string, title = t.title): TaskRepeat => ({
      todo: t,
      recurrenceId: due,
      at: 'upcoming',
      last: false,
      offRule: false,
      title,
      shown: { start: null, startAllDay: false, due, dueAllDay: t.dueAllDay },
    })
    /** The buttons of `question`, each by its text: an option's label, then its note. */
    const buttons = (question: HTMLElement) => within(question).getAllByRole('button').map((b) => b.textContent)
    const occurrencePath = (rid: string) => `/api/v1/todos/t1/occurrences/${encodeURIComponent(rid)}`
    const followingPath = (rid: string) => `/api/v1/todos/t1/following/${encodeURIComponent(rid)}`
    const puts = (fetch: Awaited<ReturnType<typeof openTask>>['fetch']) =>
      fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')

    beforeEach(() => {
      // Only the date: fake timers would stall the requests.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 9, 5, 12))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('names the presets after the task\'s date and saves "Every day" as its rule', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(single)
      expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Does not repeat')

      await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
        'Does not repeat',
        'Every day',
        'Every week on Monday',
        'Every month on day 5',
        'Every year on October 5',
        'Custom…',
      ])
      await user.click(screen.getByRole('option', { name: 'Every day' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await saved(fetch)).toMatchObject({ rrule: 'FREQ=DAILY', timezone: 'Europe/Berlin' })
    })

    it('removes the repeat of a series with "Does not repeat"', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(series)
      expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Every week on Monday and Thursday')
      expect(dialog).not.toHaveTextContent(/FREQ/)

      await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
      await user.click(screen.getByRole('option', { name: 'Does not repeat' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await saved(fetch)).toMatchObject({ rrule: '' })
    })

    it('keeps the rule of a series while the repeat is untouched', async () => {
      const user = userEvent.setup()
      const t = { ...series, rrule: 'FREQ=WEEKLY;INTERVAL=1', fixedDays: false }
      const { fetch, dialog } = await openTask(t)
      expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Every week on Monday')

      await user.type(within(dialog).getByPlaceholderText('Add a title'), ' and the herbs')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: /^All repeats/ }))

      const { path, body } = await wrote(fetch, 'PUT')
      expect(path).toBe('/api/v1/todos/t1')
      expect(body).toMatchObject({ title: 'Water the flowers and the herbs' })
      expect(body).not.toHaveProperty('rrule')
    })

    // FR-17: the server starts a series over on any new rule text, so Done on an untouched rule keeps it as stored.
    it('keeps an untidy rule as stored through the repeat editor when Done changes nothing', async () => {
      const user = userEvent.setup()
      const t = { ...series, rrule: 'FREQ=WEEKLY;BYDAY=MO,TH;' }
      const { fetch, dialog } = await openTask(t)
      await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
      await user.click(screen.getByRole('option', { name: 'Custom…' }))
      await user.click(within(screen.getByRole('dialog', { name: 'Custom repeat' })).getByRole('button', { name: 'Done' }))

      await user.type(within(dialog).getByPlaceholderText('Add a title'), ' and the herbs')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: /^All repeats/ }))
      const { body } = await wrote(fetch, 'PUT')
      expect(body).not.toHaveProperty('rrule')
    })

    it('warns before the repeat editor replaces a series of dates without a rule', async () => {
      const user = userEvent.setup()
      const { dialog } = await openTask({ ...series, rrule: '' })
      expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Repeats on set dates')
      await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
      await user.click(screen.getByRole('option', { name: 'Custom…' }))
      expect(
        within(screen.getByRole('dialog', { name: 'Custom repeat' })).getByText(
          "This repeat comes from another app and Lucid can't show all of it here. Done replaces it with the repeat above.",
        ),
      ).toBeInTheDocument()
    })

    // FR-17: the hours of a rule from another app repeat at the minute of the task's time, 9:30 here.
    it('names the times of a rule after the task\'s time', async () => {
      const t = todo({ due: '2026-10-05T07:30:00Z', dueAllDay: false, rrule: 'FREQ=DAILY;BYHOUR=9,17', recurring: true })
      const { dialog } = await openTask(t)
      expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Every day at 9:30 AM and 5:30 PM')
    })

    // A task in New York at 18:00 shows at midnight in Berlin, a day later (FR-17, FR-18).
    const newYork = (rrule: string) =>
      todo({
        title: 'Report',
        due: '2026-11-10T23:00:00Z',
        timezone: 'America/New_York',
        rrule,
        recurring: true,
        recurrenceId: '2026-11-10T23:00:00Z',
      })

    it('edits the repeat of a series in another zone on the days it shows on, and saves it in its zone', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(newYork('FREQ=WEEKLY'))
      const select = within(dialog).getByRole('combobox', { name: 'Repeat' })
      expect(select).toHaveTextContent('Every week on Wednesday')

      await user.click(select)
      await user.click(screen.getByRole('option', { name: 'Custom…' }))
      const repeat = screen.getByRole('dialog', { name: 'Custom repeat' })
      expect(within(repeat).getByRole('button', { name: 'Wednesday' })).toHaveAttribute('aria-pressed', 'true')
      const interval = within(repeat).getByRole('spinbutton', { name: 'Repeat every' })
      await user.clear(interval)
      await user.type(interval, '2')
      await user.click(within(repeat).getByRole('button', { name: 'Done' }))
      expect(select).toHaveTextContent('Every 2 weeks on Wednesday')

      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      // Tuesday at 18:00 in New York, which the task keeps.
      expect(await saved(fetch)).toMatchObject({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU' })
    })

    // A weekly series on Tuesdays at 10:00 whose current repeat of 10 November is moved to Monday, 9 November.
    const movedRepeat = todo({
      due: '2026-11-09T09:00:00Z',
      timezone: 'Europe/Berlin',
      rrule: 'FREQ=WEEKLY',
      recurring: true,
      recurrenceId: '2026-11-10T09:00:00Z',
    })

    // A changed rule starts the series over at the repeat's dates, which another preset is named after (FR-17).
    it("names the series' rule after its days, and another after the repeat's dates", async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(movedRepeat)
      const select = within(dialog).getByRole('combobox', { name: 'Repeat' })
      expect(select).toHaveTextContent('Every week on Tuesday')

      await user.click(select)
      expect(screen.getByRole('option', { name: 'Every month on day 9' })).toBeInTheDocument()
      await user.click(screen.getByRole('option', { name: 'Custom…' }))
      const repeat = screen.getByRole('dialog', { name: 'Custom repeat' })
      expect(within(repeat).getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'true')
      expect(within(repeat).getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'false')
      const interval = within(repeat).getByRole('spinbutton', { name: 'Repeat every' })
      await user.clear(interval)
      await user.type(interval, '2')
      // The series starts over at the repeat, Monday, which counts as its first date, then goes on on Tuesdays.
      const next = within(within(repeat).getByRole('region', { name: 'Next dates' })).getAllByRole('listitem')
      expect(next.slice(0, 3).map((li) => li.textContent)).toEqual(['Mon, Nov 9', 'Tue, Nov 10', 'Tue, Nov 24'])
      expect(repeat).toHaveTextContent(/counts as the first date/)
      await user.click(within(repeat).getByRole('button', { name: 'Done' }))
      expect(select).toHaveTextContent('Every 2 weeks on Tuesday')

      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      expect(await saved(fetch)).toMatchObject({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU' })
    })

    it("moves the series' rule with the repeat's new date, and another starts there", async () => {
      const user = userEvent.setup()
      const { dialog } = await openTask(movedRepeat)
      await user.click(within(dialog).getByRole('combobox', { name: 'Due' }))
      const month = screen.getByRole('dialog', { name: 'Due date' })
      await user.click(within(month).getByRole('button', { name: 'Tuesday, November 10th, 2026' }))
      const select = within(dialog).getByRole('combobox', { name: 'Repeat' })
      expect(select).toHaveTextContent('Every week on Wednesday')

      await user.click(select)
      expect(screen.getByRole('option', { name: 'Every month on day 10' })).toBeInTheDocument()
    })

    it("keeps the series' rule when the repeat editor opened on it is left untouched", async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(movedRepeat)
      const select = within(dialog).getByRole('combobox', { name: 'Repeat' })
      await user.click(select)
      await user.click(screen.getByRole('option', { name: 'Custom…' }))
      await user.click(within(screen.getByRole('dialog', { name: 'Custom repeat' })).getByRole('button', { name: 'Done' }))
      expect(select).toHaveTextContent('Every week on Tuesday')

      await user.type(within(dialog).getByPlaceholderText('Add a title'), ' now')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      const { body } = await wrote(fetch, 'PUT')
      expect(body).toMatchObject({ title: 'Task now' })
      expect(body).not.toHaveProperty('rrule')
    })

    // A series of dates has no rule of its own to keep: a new one starts at the repeat's dates (FR-17).
    it('opens the repeat editor of a series of dates on the date its repeat is on', async () => {
      const user = userEvent.setup()
      const { dialog } = await openTask({ ...movedRepeat, rrule: '' })
      await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
      await user.click(screen.getByRole('option', { name: 'Custom…' }))
      const repeat = screen.getByRole('dialog', { name: 'Custom repeat' })
      expect(within(repeat).getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true')
      expect(within(repeat).getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'false')
    })

    it("refuses a repeat that doesn't read the same in the series' zone, and saves nothing", async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(newYork('FREQ=WEEKLY'))
      await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
      await user.click(screen.getByRole('option', { name: 'Custom…' }))
      const repeat = screen.getByRole('dialog', { name: 'Custom repeat' })
      await user.click(within(repeat).getByRole('combobox', { name: 'Days, weeks, months or years' }))
      await user.click(screen.getByRole('option', { name: 'month' }))
      await user.click(within(repeat).getByRole('button', { name: 'Done' }))

      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      expect(
        await within(dialog).findByText('The task keeps its own time zone, where these days fall on other dates. Choose another repeat.'),
      ).toBeInTheDocument()
      expect(puts(fetch)).toHaveLength(0)
    })

    it("offers no custom repeat for a rule that doesn't read the same here", async () => {
      const user = userEvent.setup()
      const { dialog } = await openTask(newYork('FREQ=MONTHLY;BYMONTHDAY=10'))
      const select = within(dialog).getByRole('combobox', { name: 'Repeat' })
      expect(select).toHaveTextContent('Every month on day 10 (America/New_York)')

      await user.click(select)
      expect(screen.getByRole('option', { name: 'Every month on day 11' })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: 'Custom…' })).toBeNull()
    })

    // FR-09: a time the field couldn't read is said by its note alone; nothing is read from it, not even for the rule
    // the new repeat writes, and the form stays as usable as before.
    it('says only what to type for an unreadable time of a series given a new repeat, and saves once it reads', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(timed)
      const repeat = within(dialog).getByRole('combobox', { name: 'Repeat' })
      const time = within(dialog).getByRole('combobox', { name: 'Due time' })
      await user.click(repeat)
      await user.click(screen.getByRole('option', { name: 'Every day' }))
      await user.click(time)
      await user.keyboard('9:4x')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)))

      const note = 'Enter a time like 9:40 AM.'
      expect(time).toHaveAccessibleDescription(note)
      expect(repeat).toHaveAccessibleDescription('')
      expect(within(dialog).getByRole('combobox', { name: 'Due' })).not.toHaveAttribute('aria-invalid')
      expect(within(dialog).queryByRole('alertdialog')).toBeNull()
      expect(puts(fetch)).toHaveLength(0)

      await user.click(time)
      await user.keyboard('940')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      const { body } = await wrote(fetch, 'PUT')
      expect(body).toMatchObject({ due: '2026-10-05T07:40:00.000Z', dueAllDay: false, rrule: 'FREQ=DAILY' })
    })

    it('asks for a date before a task repeats', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(todo({ title: 'Slides' }))

      await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
      await user.click(screen.getByRole('option', { name: 'Every day' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await within(dialog).findByText('A repeating task needs a date.')).toBeInTheDocument()
      expect(puts(fetch)).toHaveLength(0)
    })

    it('creates a task that repeats', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openNew(slides)

      await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
      await user.click(screen.getByRole('option', { name: 'Every week on Wednesday' }))
      await user.click(within(dialog).getByRole('button', { name: 'Create task' }))

      await waitFor(() => {
        expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
      })
      const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!
      expect(bodyOf(init)).toMatchObject({ rrule: 'FREQ=WEEKLY', timezone: 'Europe/Berlin' })
    })

    // The repeat editor itself is RecurrenceDialog's to test; this is its wiring into the task form.
    it('creates a task with a custom repeat from the repeat editor', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openNew(slides)

      await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
      await user.click(screen.getByRole('option', { name: 'Custom…' }))
      const repeat = screen.getByRole('dialog', { name: 'Custom repeat' })
      const interval = within(repeat).getByRole('spinbutton', { name: 'Repeat every' })
      await user.clear(interval)
      await user.type(interval, '2')
      await user.click(within(repeat).getByRole('button', { name: 'Done' }))

      expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Every 2 weeks on Wednesday')
      await user.click(within(dialog).getByRole('button', { name: 'Create task' }))
      await waitFor(() => {
        expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
      })
      const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!
      expect(bodyOf(init)).toMatchObject({ rrule: 'FREQ=WEEKLY;INTERVAL=2' })
    })

    it('explains repeating tasks behind the info button', async () => {
      const user = userEvent.setup()
      const { dialog } = await openTask(series)

      await user.click(within(dialog).getByRole('button', { name: 'How repeating tasks work' }))
      const info = screen.getByRole('dialog', { name: 'How repeating tasks work' })
      expect(info).toHaveTextContent('When you complete a repeating task, the completed one stays as its own entry')
      expect(info).toHaveTextContent(
        'Repeats are completed in order. Changing only one repeat makes it a task of its own, and the series goes on.',
      )
    })

    it('opens the explanation in a read-only list, where the repeat itself cannot change', async () => {
      const user = userEvent.setup()
      const { dialog } = await openTask(series, calendar({ readOnly: true }))

      expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toBeDisabled()
      await user.click(within(dialog).getByRole('button', { name: 'How repeating tasks work' }))
      expect(screen.getByRole('dialog', { name: 'How repeating tasks work' })).toBeInTheDocument()
    })

    it('offers the explanation only for a task that repeats', async () => {
      const { dialog } = await openTask(single)
      expect(within(dialog).queryByRole('button', { name: 'How repeating tasks work' })).toBeNull()
    })

    it('offers every day for the due date of a series on fixed days, past its next repeat too', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(timed)

      await user.click(within(dialog).getByRole('combobox', { name: 'Due' }))
      const month = screen.getByRole('dialog', { name: 'Due date' })
      expect(within(month).getByRole('button', { name: 'Thursday, October 8th, 2026' })).not.toHaveAttribute('aria-disabled')
      expect(within(month).queryByText(/^Until /)).toBeNull()
      await user.click(within(month).getByRole('button', { name: 'Friday, October 9th, 2026' }))
      await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
      await user.click(screen.getByRole('option', { name: '10:00 AM' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: /^All repeats/ }))

      expect(await saved(fetch)).toMatchObject({ due: '2026-10-09T08:00:00.000Z', dueAllDay: false })
    })

    it('saves a start date before the series\' own day', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(series)

      await user.click(within(dialog).getByRole('combobox', { name: 'Start' }))
      await user.click(screen.getByRole('button', { name: 'Thursday, October 1st, 2026' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: /^All repeats/ }))

      expect(await saved(fetch)).toMatchObject({ start: '2026-10-01T00:00:00.000Z', startAllDay: true })
    })

    // FR-17: where deleting can only reach all repeats, a plain confirmation says so.
    it('asks before it deletes every repeat of a series that offers nothing else', async () => {
      const user = userEvent.setup()
      const shared = { ...series, hasAttendees: true }
      const { fetch, dialog } = await openTask(shared, undefined, later(shared, '2026-10-08T00:00:00Z'))

      await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
      expect(within(dialog).queryByRole('alertdialog')).toBeNull()
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'This task repeats. Delete all repeats? Completed ones stay.',
      )
      await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
      expect((await wrote(fetch, 'DELETE')).path).toBe('/api/v1/todos/t1')
    })

    it('can only remove a repeat Lucid cannot read, and leaves its dates and completion alone', async () => {
      const user = userEvent.setup()
      const unreadable = { ...series, rrule: 'FREQ=SOMETIMES', ruleUnsupported: true, recurrenceId: null, next: null }
      const { fetch, dialog } = await openTask(unreadable)

      expect(
        within(dialog).getByText("Lucid can't read this repeat. Complete and move it in the app that created it."),
      ).toBeInTheDocument()
      expect(within(dialog).getByRole('checkbox', { name: 'Completed' })).toBeDisabled()
      expect(within(dialog).getByRole('combobox', { name: 'Due' })).toBeDisabled()
      expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Repeats by a rule from another app')
      expect(dialog).not.toHaveTextContent(/FREQ/)

      await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
      // Lucid can't replace a rule it can't read: no "Custom…".
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
        'Does not repeat',
        'Repeats by a rule from another app',
      ])
      await user.click(screen.getByRole('option', { name: 'Does not repeat' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await saved(fetch)).toMatchObject({ rrule: '' })
    })

    // FR-17: a series whose rule Lucid can't read can only be kept or removed, not moved; a read-only list changes
    // nothing. The fieldset that disables the dates disables the targets beside their texts too.
    it.each([
      ['a rule Lucid cannot read', { rrule: 'FREQ=SOMETIMES', ruleUnsupported: true, recurrenceId: null, next: null }, calendar()],
      ['a read-only list', {}, calendar({ readOnly: true })],
    ])('opens neither the month nor the time list from the chevrons of %s', async (_, own, list) => {
      const { dialog } = await openTask({ ...timed, ...own }, list)
      const date = within(dialog).getByRole('combobox', { name: 'Due' })
      const time = within(dialog).getByRole('combobox', { name: 'Due time' })
      expect(time).toBeDisabled()

      // A browser disables only the form controls in the fieldset; user-event takes the chevrons for disabled too.
      fireEvent.click(chevronOf(time))
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(time).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(chevronOf(date))
      expect(screen.queryByRole('dialog', { name: 'Due date' })).toBeNull()
      expect(date).toHaveAttribute('aria-expanded', 'false')
      expect(time).toHaveValue('9:00 AM')
      expect(date).toHaveValue('Mon, Oct 5')
    })

    it('saves an unrelated edit on a dateless series without touching its rule', async () => {
      const user = userEvent.setup()
      // A rule Lucid can't read may leave a series with no date at all; only a repeat
      // that actually changes needs one, so a title edit that leaves it alone must save.
      const dateless = {
        ...series,
        due: null,
        dueAllDay: false,
        rrule: 'FREQ=SOMETIMES',
        ruleUnsupported: true,
        recurrenceId: null,
        next: null,
      }
      const { fetch, dialog } = await openTask(dateless)

      await user.type(within(dialog).getByPlaceholderText('Add a title'), ' (extra)')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      const body = await saved(fetch)
      expect(body).toMatchObject({ title: 'Water the flowers (extra)' })
      expect(body).not.toHaveProperty('rrule')
    })

    it('asks for a date when the due date of the last repeat is cleared, and sends no PUT', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(last)

      await user.click(within(dialog).getByRole('button', { name: 'Remove due date' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await within(dialog).findByText('A repeating task needs a date.')).toBeInTheDocument()
      expect(puts(fetch)).toHaveLength(0)
    })

    // FR-17: the editor asks which repeats a save reaches, in its footer, where there is a choice.
    describe('at a repeat', () => {
      const moveQuestion = 'This task repeats. Which repeats should move?'
      const changeQuestion = 'This task repeats. Which repeats should change?'

      it('asks at the current repeat whether only it moves, and detaches it', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(series)

        await user.click(within(dialog).getByRole('combobox', { name: 'Due' }))
        await user.click(screen.getByRole('button', { name: 'Tuesday, October 6th, 2026' }))
        await user.click(within(dialog).getByRole('button', { name: 'Save' }))

        const question = within(dialog).getByRole('alertdialog', { name: moveQuestion })
        expect(buttons(question)).toEqual([
          'Only this repeatBecomes a task of its own. The series goes on Thu, Oct 8.',
          'All repeatsDone ones stay.',
          'Cancel',
        ])
        expect(question).not.toHaveAccessibleDescription()
        expect(within(question).getByRole('button', { name: 'Only this repeat' })).toHaveFocus()
        expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)

        await user.click(within(question).getByRole('button', { name: 'Only this repeat' }))
        const { path, body } = await wrote(fetch, 'PUT')
        expect(path).toBe(occurrencePath('2026-10-05T00:00:00Z'))
        expect(body).toMatchObject({ title: 'Water the flowers', due: '2026-10-06T00:00:00.000Z', dueAllDay: true })
        expect(body).not.toHaveProperty('rrule')
        await waitFor(() => {
          expect(screen.queryByRole('dialog')).toBeNull()
        })
      })

      it('detaches the current repeat over a change made elsewhere, after asking again (FR-09)', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openConflicted(series, { ...series, etag: '"2"' })

        await user.click(within(dialog).getByRole('radio', { name: 'High' }))
        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        const only = () =>
          within(within(dialog).getByRole('alertdialog', { name: changeQuestion })).getByRole('button', {
            name: 'Only this repeat',
          })
        await user.click(only())
        await user.click(await within(dialog).findByRole('button', { name: 'Save anyway' }))
        await user.click(only())
        await waitFor(() => {
          expect(screen.queryByRole('dialog')).toBeNull()
        })
        expect(writtenEtags(fetch)).toEqual(['"1"', '"2"'])
      })

      it('asks the same of a change of the current repeat\'s other fields', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(series)

        await user.click(within(dialog).getByRole('radio', { name: 'High' }))
        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        const question = within(dialog).getByRole('alertdialog', { name: changeQuestion })
        await user.click(within(question).getByRole('button', { name: 'All repeats' }))

        const { path, body } = await wrote(fetch, 'PUT')
        expect(path).toBe('/api/v1/todos/t1')
        expect(body).toMatchObject({ priority: 1, due: '2026-10-05T00:00:00.000Z' })
      })

      it("opens at a later repeat with its own title, and splits the series there with the series' title", async () => {
        const user = userEvent.setup()
        // Thursday's repeat, renamed in another app.
        const thursday = later(timed, '2026-10-08T07:00:00Z', 'Water the herbs')
        const { fetch, dialog } = await openTask(timed, undefined, thursday)
        expect(within(dialog).getByPlaceholderText('Add a title')).toHaveValue('Water the herbs')
        // Repeats are completed in order.
        expect(within(dialog).getByRole('checkbox', { name: 'Completed' })).toBeDisabled()

        await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
        await user.click(screen.getByRole('option', { name: '10:00 AM' }))
        await user.click(within(dialog).getByRole('button', { name: 'Save' }))

        const question = within(dialog).getByRole('alertdialog', { name: moveQuestion })
        expect(buttons(question)).toEqual([
          'This and following repeatsFrom Thu, Oct 8 on, as a series of its own. Earlier ones stay as they are.',
          'All repeatsDone ones stay.',
          'Cancel',
        ])
        expect(question).toHaveAccessibleDescription('Only the current repeat can be changed on its own.')

        await user.click(within(question).getByRole('button', { name: 'This and following repeats' }))
        const { path, body } = await wrote(fetch, 'PUT')
        expect(path).toBe(followingPath('2026-10-08T07:00:00Z'))
        // Thursday's new time; the title it shows is its own, which the series' leaves as it is (Review Focus 4).
        expect(body).toMatchObject({ title: 'Water the flowers', due: '2026-10-08T08:00:00.000Z', dueAllDay: false })
        expect(body).not.toHaveProperty('rrule')
      })

      it('sends the title the user typed at a later repeat', async () => {
        const user = userEvent.setup()
        const thursday = later(timed, '2026-10-08T07:00:00Z', 'Water the herbs')
        const { fetch, dialog } = await openTask(timed, undefined, thursday)

        const title = within(dialog).getByPlaceholderText('Add a title')
        await user.clear(title)
        await user.type(title, 'Water the roses')
        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        const question = within(dialog).getByRole('alertdialog', { name: changeQuestion })
        await user.click(within(question).getByRole('button', { name: 'This and following repeats' }))

        const { body } = await wrote(fetch, 'PUT')
        expect(body).toMatchObject({ title: 'Water the roses', due: '2026-10-08T07:00:00.000Z' })
      })

      // FR-17: the server writes a time given to an all-day series in the zone of the write, and reads the move there:
      // 8:00 on the 15th in Tokyo stays on the 15th, though it is 23:00 on the 14th in UTC.
      it('gives an all-day series on fixed days a time on its day east of UTC, with all repeats offered', async () => {
        const originalTz = process.env.TZ
        process.env.TZ = 'Asia/Tokyo'
        try {
          const user = userEvent.setup()
          const monthly = {
            ...series,
            title: 'Pay rent',
            due: '2026-10-15T00:00:00Z',
            rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
            recurrenceId: '2026-10-15T00:00:00Z',
            next: { start: null, due: '2026-11-15T00:00:00Z' },
          }
          const { fetch, dialog } = await openTask(monthly)

          await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
          await user.click(screen.getByRole('option', { name: '8:00 AM' }))
          await user.click(within(dialog).getByRole('button', { name: 'Save' }))
          const question = within(dialog).getByRole('alertdialog', { name: moveQuestion })
          await user.click(within(question).getByRole('button', { name: 'All repeats' }))

          const { path, body } = await wrote(fetch, 'PUT')
          expect(path).toBe('/api/v1/todos/t1')
          expect(body).toMatchObject({ due: '2026-10-14T23:00:00.000Z', dueAllDay: false, timezone: 'Asia/Tokyo' })
        } finally {
          process.env.TZ = originalTz
        }
      })

      it('moves all repeats from a later one as far as it moved', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(timed, undefined, later(timed, '2026-10-08T07:00:00Z'))

        // Thursday 9:00 to Friday 10:00.
        await user.click(within(dialog).getByRole('combobox', { name: 'Due' }))
        await user.click(screen.getByRole('button', { name: 'Friday, October 9th, 2026' }))
        await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
        await user.click(screen.getByRole('option', { name: '10:00 AM' }))
        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: 'All repeats' }))

        // The series, from Monday 9:00, a day and an hour later.
        const { path, body } = await wrote(fetch, 'PUT')
        expect(path).toBe('/api/v1/todos/t1')
        expect(body).toMatchObject({ due: '2026-10-06T08:00:00.000Z', dueAllDay: false, title: 'Water the flowers' })
      })

      // A later repeat another app moved to a time, in an all-day series: its time is not the user's change.
      it("keeps the series' dates when all repeats change only fields at a repeat of another shape", async () => {
        const user = userEvent.setup()
        const thursday = {
          ...later(series, '2026-10-08T00:00:00Z'),
          shown: { start: null, startAllDay: false, due: '2026-10-08T07:00:00Z', dueAllDay: false },
        }
        const { fetch, dialog } = await openTask(series, undefined, thursday)
        expect(within(dialog).getByRole('combobox', { name: 'Due time' })).toHaveValue('9:00 AM')

        await user.click(within(dialog).getByRole('radio', { name: 'High' }))
        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: 'All repeats' }))

        const { path, body } = await wrote(fetch, 'PUT')
        expect(path).toBe('/api/v1/todos/t1')
        expect(body).toMatchObject({ priority: 1, start: null, due: '2026-10-05T00:00:00Z', dueAllDay: true })
      })

      // FR-17: "only this repeat" would make a task of its own and roll the series; an untouched repeat stays as it is.
      it.each([
        ['the current repeat', undefined],
        ['a later repeat', later(series, '2026-10-08T00:00:00Z')],
      ])('closes without asking or saving when nothing changed at %s', async (_, repeat) => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(series, undefined, repeat)

        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        await waitFor(() => {
          expect(screen.queryByRole('dialog')).toBeNull()
        })
        expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT' || init?.method === 'DELETE')).toBe(false)
      })

      it('warns in red, without asking, that removing the rule at the current repeat removes later ones', async () => {
        const user = userEvent.setup()
        const success = vi.spyOn(toast, 'success')
        const { fetch, dialog } = await openTask(series)
        expect(within(dialog).queryByText(/^The task stops repeating/)).toBeNull()

        await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
        await user.click(screen.getByRole('option', { name: 'Does not repeat' }))
        const hint = within(dialog).getByText('The task stops repeating. Upcoming repeats are removed.')
        expect(hint).toHaveClass('text-xs', 'font-medium', 'text-muted-foreground')
        // Done repeats stay (checks); this one and the later ones are reached, in red.
        expect(Array.from(hint.querySelectorAll('circle'), (c) => c.getAttribute('fill'))).toEqual(
          Array(3).fill('var(--destructive)'),
        )
        expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveAccessibleDescription(
          'The task stops repeating. Upcoming repeats are removed.',
        )

        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        const { path, body } = await wrote(fetch, 'PUT')
        expect(path).toBe('/api/v1/todos/t1')
        expect(body).toMatchObject({ rrule: '' })
        // Spec §1, rule 1: the one option is said after it is saved too, in red as before.
        await waitFor(() => {
          expect(success).toHaveBeenCalledWith('All repeats changed.', expect.objectContaining({ id: 'series:t1' }))
        })
        // The last: a toast of an earlier write still shown is merged into first (`startSeriesWrite`).
        const [, options] = success.mock.calls.filter(([m]) => m === 'All repeats changed.').at(-1)!
        const { container } = render(<>{options?.icon}</>)
        expect(Array.from(container.querySelectorAll('circle'), (c) => c.getAttribute('fill'))).toEqual(
          Array(3).fill('var(--destructive)'),
        )
      })

      it('says in the footer that with attendees a change reaches all repeats, and saves them', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask({ ...series, hasAttendees: true })

        const text =
          "Applies from this repeat on. Done ones stay. With attendees, a repeat can't become a task of its own."
        expect(within(dialog).getByText(text)).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveAccessibleDescription(text)

        await user.click(within(dialog).getByRole('combobox', { name: 'Due' }))
        await user.click(screen.getByRole('button', { name: 'Tuesday, October 6th, 2026' }))
        const moves = "Moves all repeats. With attendees, a repeat can't become a task of its own."
        expect(within(dialog).getByText(moves)).toBeInTheDocument()

        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        const { path, body } = await wrote(fetch, 'PUT')
        expect(path).toBe('/api/v1/todos/t1')
        expect(body).toMatchObject({ due: '2026-10-06T00:00:00.000Z' })
      })

      // FR-17: from a later repeat, "all repeats" reaches the current repeat before it too, which the footer says.
      it('says in the footer at a later repeat with attendees that a change reaches the current repeat too', async () => {
        const user = userEvent.setup()
        const shared = { ...series, hasAttendees: true }
        const { fetch, dialog } = await openTask(shared, undefined, later(shared, '2026-10-08T00:00:00Z'))

        await user.click(within(dialog).getByRole('radio', { name: 'High' }))
        const text =
          "Applies to all repeats, the current one too. Done ones stay. With attendees, the series can't be split."
        const hint = within(dialog).getByText(text)
        expect(Array.from(hint.querySelectorAll('svg > *'), (m) => (m.tagName === 'path' ? '✓' : 'dot'))).toEqual([
          '✓',
          'dot',
          'dot',
          'dot',
          'dot',
        ])
        expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveAccessibleDescription(text)

        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        const { path, body } = await wrote(fetch, 'PUT')
        expect(path).toBe('/api/v1/todos/t1')
        expect(body).toMatchObject({ priority: 1 })
      })

      it('saves the last repeat as a single task, without a question or a hint', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(last)

        await user.click(within(dialog).getByRole('combobox', { name: 'Due' }))
        await user.click(screen.getByRole('button', { name: 'Friday, October 16th, 2026' }))
        expect(within(dialog).getByRole('button', { name: 'Save' })).not.toHaveAccessibleDescription()
        await user.click(within(dialog).getByRole('button', { name: 'Save' }))

        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        const { path, body } = await wrote(fetch, 'PUT')
        expect(path).toBe('/api/v1/todos/t1')
        expect(body).toMatchObject({ due: '2026-10-16T00:00:00.000Z' })
      })

      it('completes the current repeat with an edit without asking', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(series)

        await user.click(within(dialog).getByRole('checkbox', { name: 'Completed' }))
        await user.click(within(dialog).getByRole('radio', { name: 'High' }))
        expect(within(dialog).getByRole('button', { name: 'Save' })).not.toHaveAccessibleDescription()
        await user.click(within(dialog).getByRole('button', { name: 'Save' }))

        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        const { path, body } = await wrote(fetch, 'PUT')
        expect(path).toBe('/api/v1/todos/t1')
        expect(body).toMatchObject({ status: 'COMPLETED', priority: 1 })
      })

      it("says under the date why a later repeat can't move there, and saves nothing until it can", async () => {
        const user = userEvent.setup()
        // On the 15th of each month; the current repeat is October's, the later one November's.
        const monthly = {
          ...series,
          title: 'Pay rent',
          due: '2026-10-15T00:00:00Z',
          rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
          recurrenceId: '2026-10-15T00:00:00Z',
          next: { start: null, due: '2026-11-15T00:00:00Z' },
        }
        const { fetch, dialog } = await openTask(monthly, undefined, later(monthly, '2026-11-15T00:00:00Z'))
        const refused = "Can't move. The series stays on its days."

        await user.click(within(dialog).getByRole('combobox', { name: 'Due' }))
        await user.click(screen.getByRole('button', { name: 'Monday, November 16th, 2026' }))
        // A limit is no error (spec §2): said in the muted foreground, the field not marked.
        const said = within(dialog).getByText(refused)
        expect(said).toHaveClass('text-muted-foreground')
        expect(said).not.toHaveClass('text-destructive')
        const field = within(dialog).getByRole('combobox', { name: 'Due' })
        expect(field).toHaveAccessibleDescription(refused)
        expect(field).not.toHaveAttribute('aria-invalid')
        expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
        await user.type(within(dialog).getByPlaceholderText('Add a title'), '{Enter}')
        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        expect(puts(fetch)).toHaveLength(0)

        await user.click(within(dialog).getByRole('combobox', { name: 'Due' }))
        await user.click(screen.getByRole('button', { name: 'Sunday, November 15th, 2026' }))
        expect(within(dialog).queryByText(refused)).toBeNull()
        expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
      })

      it('asks before deleting at the current repeat whether to skip it, and skips it', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(series)

        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
        const question = within(dialog).getByRole('alertdialog', {
          name: 'This task repeats. Which repeats should be deleted?',
        })
        expect(buttons(question)).toEqual([
          'Only this repeatSkipped. The series goes on Thu, Oct 8.',
          'All repeatsDone and detached ones stay.',
          'Cancel',
        ])
        // Deleting focuses Cancel, and its dots are red.
        expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus()
        const [only] = within(question).getAllByRole('button')
        const fills = Array.from(only!.querySelectorAll('circle'), (c) => c.getAttribute('fill'))
        expect(fills).toContain('var(--destructive)')

        await user.click(within(question).getByRole('button', { name: 'Only this repeat' }))
        expect((await wrote(fetch, 'DELETE')).path).toBe(occurrencePath('2026-10-05T00:00:00Z'))
      })

      it('ends the series before a later repeat, or deletes it all', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(series, undefined, later(series, '2026-10-08T00:00:00Z'))

        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
        const question = within(dialog).getByRole('alertdialog', {
          name: 'This task repeats. Which repeats should be deleted?',
        })
        expect(buttons(question)).toEqual([
          'This and following repeatsThe series ends before Thu, Oct 8.',
          'All repeatsDone and detached ones stay.',
          'Cancel',
        ])
        await user.click(within(question).getByRole('button', { name: 'This and following repeats' }))
        expect((await wrote(fetch, 'DELETE')).path).toBe(followingPath('2026-10-08T00:00:00Z'))
      })

      // FR-17: "All repeats" of the footer's question says so as the series' toast, its reach in red.
      it('deletes all repeats from a later repeat, drawing the reach in red', async () => {
        const user = userEvent.setup()
        const success = vi.spyOn(toast, 'success')
        const { fetch, dialog } = await openTask(series, undefined, later(series, '2026-10-08T00:00:00Z'))

        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
        const question = within(dialog).getByRole('alertdialog', {
          name: 'This task repeats. Which repeats should be deleted?',
        })
        await user.click(within(question).getByRole('button', { name: 'All repeats' }))
        expect((await wrote(fetch, 'DELETE')).path).toBe('/api/v1/todos/t1')

        await waitFor(() => {
          expect(success).toHaveBeenCalledWith('Task deleted', expect.objectContaining({ id: 'series:t1' }))
        })
        const [, options] = success.mock.calls.filter(([m]) => m === 'Task deleted').at(-1)!
        const { container } = render(<>{options?.icon}</>)
        const red = 'var(--destructive)'
        expect(Array.from(container.querySelectorAll('svg > *'), (m) => (m.tagName === 'path' ? '✓' : m.getAttribute('fill')))).toEqual(
          ['✓', red, red, red, red],
        )
      })

      it('deletes the last repeat after the plain question', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(last)

        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
        expect(within(dialog).getByRole('alert')).toHaveTextContent('Delete this task?')
        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
        expect((await wrote(fetch, 'DELETE')).path).toBe('/api/v1/todos/t1')
      })

      // NFR-27, Review Focus 5: Escape leaves the question, not the editor, and the focus goes back.
      it('cancels only the footer question on Escape, leaving the editor open', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(series)

        await user.click(within(dialog).getByRole('radio', { name: 'High' }))
        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        within(dialog).getByRole('alertdialog')
        await user.keyboard('{Escape}')
        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        expect(screen.getByRole('dialog', { name: 'Edit task' })).toBe(dialog)
        expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveFocus()

        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
        within(dialog).getByRole('alertdialog')
        await user.keyboard('{Escape}')
        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        expect(screen.getByRole('dialog', { name: 'Edit task' })).toBe(dialog)
        expect(within(dialog).getByRole('button', { name: 'Delete task' })).toHaveFocus()

        expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT' || init?.method === 'DELETE')).toBe(false)
        await user.keyboard('{Escape}')
        expect(screen.queryByRole('dialog')).toBeNull()
      })

      it('drops the question once the form changes, and asks about the new values on the next Save', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(series)

        await user.click(within(dialog).getByRole('radio', { name: 'High' }))
        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        within(dialog).getByRole('alertdialog', { name: changeQuestion })
        await user.click(within(dialog).getByRole('combobox', { name: 'Due' }))
        await user.click(screen.getByRole('button', { name: 'Tuesday, October 6th, 2026' }))
        expect(within(dialog).queryByRole('alertdialog')).toBeNull()

        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        const question = within(dialog).getByRole('alertdialog', { name: moveQuestion })
        await user.click(within(question).getByRole('button', { name: 'All repeats' }))
        expect((await wrote(fetch, 'PUT')).body).toMatchObject({ due: '2026-10-06T00:00:00.000Z', priority: 1 })
      })
    })

    it('asks for a date when the due date of an ordinary interval series is cleared, and sends no PUT', async () => {
      const user = userEvent.setup()
      const interval = { ...series, rrule: 'FREQ=WEEKLY;INTERVAL=1', fixedDays: false }
      const { fetch, dialog } = await openTask(interval)

      await user.click(within(dialog).getByRole('button', { name: 'Remove due date' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await within(dialog).findByText('A repeating task needs a date.')).toBeInTheDocument()
      expect(puts(fetch)).toHaveLength(0)
    })
  })

  describe('after a conflict (FR-09)', () => {
    it('says the task changed elsewhere, and saves over it with the ETag it has now', async () => {
      toast.dismiss()
      const user = userEvent.setup()
      const { fetch, dialog } = await openConflicted(todo(), todo({ etag: '"2"', title: 'Theirs' }))

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
      expect(within(dialog).getByDisplayValue('Task')).toBeInTheDocument()

      await user.click(save)
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull()
      })
      expect(writtenEtags(fetch)).toEqual(['"1"', '"2"'])
    })

    it('says to close the editor when the reloaded list no longer holds the task', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openConflicted(todo(), null)

      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      const reopen = 'Changed elsewhere since you opened it. Close the editor to see the current version.'
      await waitFor(() => {
        expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveAccessibleDescription(reopen)
      })
      expect(within(dialog).getAllByRole('status').map((s) => s.textContent)).toContain(reopen)
      expect(writtenEtags(fetch)).toEqual(['"1"'])
    })
  })
})
