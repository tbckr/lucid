import { act, render, screen, waitFor, within } from '@testing-library/react'
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

describe('TaskEditor', () => {
  afterEach(() => {
    useUi.getState().openTaskEditor(null)
    vi.restoreAllMocks()
  })

  it.each([
    ['Start', 'Remove start date', 'start', 'due'],
    ['Due', 'Remove due date', 'due', 'start'],
  ])('%s: "%s" in the month removes the date together with its time', async (row, button, removed, kept) => {
    const t = todo({ title: 'Slides', start: '2026-09-25T07:00:00Z', due: '2026-09-25T09:00:00Z' })
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(t)

    await user.click(within(dialog).getByRole('button', { name: `${row} Fri, Sep 25` }))
    const month = screen.getByRole('dialog', { name: `${row} date` })
    await user.click(within(month).getByRole('button', { name: button }))
    expect(within(dialog).getByRole('button', { name: `${row} Add a date` })).toBeInTheDocument()
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

    await user.click(within(dialog).getByRole('button', { name: 'Start Add a date' }))
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
      ])
      await user.click(screen.getByRole('option', { name: 'Every day' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await saved(fetch)).toMatchObject({ rrule: 'FREQ=DAILY', timezone: 'Europe/Berlin' })
    })

    it('removes the repeat of a series with "Does not repeat"', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(series)
      expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Custom rule')
      expect(within(dialog).getByTitle('FREQ=WEEKLY;BYDAY=MO,TH')).toHaveTextContent('Every week on Monday and Thursday')

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

      await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' }))
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

      await user.click(within(dialog).getByRole('button', { name: 'Start Add a date' }))
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
      expect(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' })).toBeDisabled()
      expect(within(dialog).getByTitle('FREQ=SOMETIMES')).toHaveTextContent('FREQ=SOMETIMES')

      await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Does not repeat', 'Custom rule'])
      await user.click(screen.getByRole('option', { name: 'Does not repeat' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await saved(fetch)).toMatchObject({ rrule: '' })
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

      await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' }))
      const month = screen.getByRole('dialog', { name: 'Due date' })
      await user.click(within(month).getByRole('button', { name: 'Remove due date' }))
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

        await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' }))
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

      it('moves all repeats from a later one as far as it moved', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(timed, undefined, later(timed, '2026-10-08T07:00:00Z'))

        // Thursday 9:00 to Friday 10:00.
        await user.click(within(dialog).getByRole('button', { name: 'Due Thu, Oct 8' }))
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
        expect(within(dialog).getByRole('combobox', { name: 'Due time' })).toHaveTextContent('9:00 AM')

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

        await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' }))
        await user.click(screen.getByRole('button', { name: 'Tuesday, October 6th, 2026' }))
        const moves = "Moves all repeats. With attendees, a repeat can't become a task of its own."
        expect(within(dialog).getByText(moves)).toBeInTheDocument()

        await user.click(within(dialog).getByRole('button', { name: 'Save' }))
        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        const { path, body } = await wrote(fetch, 'PUT')
        expect(path).toBe('/api/v1/todos/t1')
        expect(body).toMatchObject({ due: '2026-10-06T00:00:00.000Z' })
      })

      it('saves the last repeat as a single task, without a question or a hint', async () => {
        const user = userEvent.setup()
        const { fetch, dialog } = await openTask(last)

        await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' }))
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

        await user.click(within(dialog).getByRole('button', { name: 'Due Sun, Nov 15' }))
        await user.click(screen.getByRole('button', { name: 'Monday, November 16th, 2026' }))
        expect(within(dialog).getByText(refused)).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Due Mon, Nov 16' })).toHaveAccessibleDescription(refused)
        expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
        await user.type(within(dialog).getByPlaceholderText('Add a title'), '{Enter}')
        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        expect(puts(fetch)).toHaveLength(0)

        await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Nov 16' }))
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
        await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' }))
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

      await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' }))
      const month = screen.getByRole('dialog', { name: 'Due date' })
      await user.click(within(month).getByRole('button', { name: 'Remove due date' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await within(dialog).findByText('A repeating task needs a date.')).toBeInTheDocument()
      expect(puts(fetch)).toHaveLength(0)
    })
  })
})
