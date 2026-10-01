import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { EditorDialog } from '@/components/EditorDialog'
import { type Calendar, type Todo } from '@/lib/api/schemas'
import { draftOf, type Draft } from '@/lib/quickCreate'
import { useUi } from '@/stores/ui'
import { bodyOf, calendar, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'

/** Open the editor for `t` and wait until its list is loaded. */
async function openTask(t: Todo, list: Calendar = calendar()) {
  api.setCsrfToken('tok')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (urlOf(input).endsWith('/calendars')) return Promise.resolve(jsonResponse(200, { calendars: [list] }))
    if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
    return Promise.resolve(jsonResponse(200, { ...t, etag: '"2"' }))
  })
  act(() => {
    useUi.getState().openTaskEditor({ mode: 'edit', todo: t })
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
    // A task due Monday, Oct 5 that repeats on Mondays and Thursdays: it can move until Wednesday.
    const series = todo({
      title: 'Water the flowers',
      due: '2026-10-05T00:00:00Z',
      dueAllDay: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
      recurring: true,
      fixedDays: true,
      next: { start: null, due: '2026-10-08T00:00:00Z' },
      moveWindow: { from: '2026-10-05T00:00:00Z', until: '2026-10-08T00:00:00Z' },
    })
    const single = todo({ title: 'Slides', due: '2026-10-05T00:00:00Z', dueAllDay: true })
    // The same series with a time: due at 9:00 on Monday, the next repeat at 9:00 on Thursday.
    const timed = {
      ...series,
      due: '2026-10-05T07:00:00Z',
      dueAllDay: false,
      next: { start: null, due: '2026-10-08T07:00:00Z' },
      moveWindow: { from: '2026-10-04T22:00:00Z', until: '2026-10-07T22:00:00Z' },
    }
    // The last repeat: its window only has a start.
    const last = { ...series, next: null, moveWindow: { from: '2026-10-05T00:00:00Z', until: null } }
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
      const t = { ...series, rrule: 'FREQ=WEEKLY;INTERVAL=1', fixedDays: false, moveWindow: null }
      const { fetch, dialog } = await openTask(t)
      expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Every week on Monday')

      await user.type(within(dialog).getByPlaceholderText('Add a title'), ' and the herbs')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      const body = await saved(fetch)
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
      expect(info).toHaveTextContent('Repeats can only be completed in order.')
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
      expect(within(dialog).queryByText('This task repeats. Changes apply to all upcoming repeats.')).toBeNull()
    })

    it('says up front that a series repeats', async () => {
      const { dialog } = await openTask(series)
      expect(within(dialog).getByText('This task repeats. Changes apply to all upcoming repeats.')).toBeInTheDocument()
    })

    it('limits the due date to the days before the next repeat, and says until when', async () => {
      const user = userEvent.setup()
      const { dialog } = await openTask(series)

      await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' }))
      const month = screen.getByRole('dialog', { name: 'Due date' })
      expect(within(month).getByRole('button', { name: 'Friday, October 9th, 2026' })).toHaveAttribute('aria-disabled', 'true')
      expect(within(month).getByRole('button', { name: 'Wednesday, October 7th, 2026' })).not.toHaveAttribute('aria-disabled')
      expect(within(month).getByText('Until Wed, Oct 7, then the next repeat is due.')).toBeInTheDocument()
    })

    it('limits only the start of a series anchored on it, and says until when only there', async () => {
      const user = userEvent.setup()
      // Starts Monday, due Wednesday; the next repeat starts Thursday.
      const started = {
        ...series,
        start: '2026-10-05T00:00:00Z',
        startAllDay: true,
        due: '2026-10-07T00:00:00Z',
        next: { start: '2026-10-08T00:00:00Z', due: '2026-10-10T00:00:00Z' },
      }
      const { dialog } = await openTask(started)

      await user.click(within(dialog).getByRole('button', { name: 'Start Mon, Oct 5' }))
      const start = screen.getByRole('dialog', { name: 'Start date' })
      expect(within(start).getByRole('button', { name: 'Thursday, October 8th, 2026' })).toHaveAttribute('aria-disabled', 'true')
      expect(within(start).getByText('Until Wed, Oct 7, then the next repeat is due.')).toBeInTheDocument()
      await user.keyboard('{Escape}')

      await user.click(within(dialog).getByRole('button', { name: 'Due Wed, Oct 7' }))
      const due = screen.getByRole('dialog', { name: 'Due date' })
      expect(within(due).getByRole('button', { name: 'Friday, October 9th, 2026' })).not.toHaveAttribute('aria-disabled')
      expect(within(due).queryByText(/^Until /)).toBeNull()
    })

    it('limits a timed series to the days before the next repeat, at any time', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(timed)

      // Wednesday is the last day, whatever the time; Thursday is out, even before 9:00.
      await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' }))
      const month = screen.getByRole('dialog', { name: 'Due date' })
      expect(within(month).getByRole('button', { name: 'Thursday, October 8th, 2026' })).toHaveAttribute('aria-disabled', 'true')
      expect(within(month).getByText('Until Wed, Oct 7, then the next repeat is due.')).toBeInTheDocument()
      await user.click(within(month).getByRole('button', { name: 'Wednesday, October 7th, 2026' }))
      await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
      await user.click(screen.getByRole('option', { name: '10:00 AM' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await saved(fetch)).toMatchObject({ due: '2026-10-07T08:00:00.000Z', dueAllDay: false })
    })

    it('does not save a start date past the next repeat', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(timed)

      // A start binds the window instead of the due date, and its picker was free while there was none.
      await user.click(within(dialog).getByRole('button', { name: 'Start Add a date' }))
      await user.click(screen.getByRole('button', { name: 'Thursday, October 8th, 2026' }))
      await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' }))
      await user.click(screen.getByRole('button', { name: 'Friday, October 9th, 2026' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await within(dialog).findByText('Until Wed, Oct 7, then the next repeat is due.')).toBeInTheDocument()
      expect(puts(fetch)).toHaveLength(0)
    })

    it('asks before it deletes every repeat of a series', async () => {
      const user = userEvent.setup()
      const { dialog } = await openTask(series)

      await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'This task repeats. Delete all repeats? Completed ones stay.',
      )
    })

    it('can only remove a repeat Lucid cannot read, and leaves its dates and completion alone', async () => {
      const user = userEvent.setup()
      const unreadable = { ...series, rrule: 'FREQ=SOMETIMES', ruleUnsupported: true, next: null, moveWindow: null }
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
        next: null,
        moveWindow: null,
      }
      const { fetch, dialog } = await openTask(dateless)

      await user.type(within(dialog).getByPlaceholderText('Add a title'), ' (extra)')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      const body = await saved(fetch)
      expect(body).toMatchObject({ title: 'Water the flowers (extra)' })
      expect(body).not.toHaveProperty('rrule')
    })

    it('limits only earlier days for the last repeat, and shows no limit text', async () => {
      const user = userEvent.setup()
      const { dialog } = await openTask(last)

      await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' }))
      const month = screen.getByRole('dialog', { name: 'Due date' })
      expect(within(month).getByRole('button', { name: 'Sunday, October 4th, 2026' })).toHaveAttribute('aria-disabled', 'true')
      expect(within(month).getByRole('button', { name: 'Friday, October 9th, 2026' })).not.toHaveAttribute('aria-disabled')
      expect(within(month).queryByText(/^Until /)).toBeNull()
    })

    it('does not save a start date before the window of the last repeat, and names from', async () => {
      const user = userEvent.setup()
      // Its picker isn't gated while due is still the anchor (FR-17); the submit guard is the backstop.
      const { fetch, dialog } = await openTask(last)

      await user.click(within(dialog).getByRole('button', { name: 'Start Add a date' }))
      await user.click(screen.getByRole('button', { name: 'Thursday, October 1st, 2026' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await within(dialog).findByText('Only possible from Mon, Oct 5 on.')).toBeInTheDocument()
      expect(puts(fetch)).toHaveLength(0)
    })

    it('does not save a start date before the window of an ordinary series, and names from', async () => {
      const user = userEvent.setup()
      const { fetch, dialog } = await openTask(series)

      await user.click(within(dialog).getByRole('button', { name: 'Start Add a date' }))
      await user.click(screen.getByRole('button', { name: 'Thursday, October 1st, 2026' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await within(dialog).findByText('Only possible from Mon, Oct 5 on.')).toBeInTheDocument()
      expect(puts(fetch)).toHaveLength(0)
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

    it('asks for a date when the due date of an ordinary interval series is cleared, and sends no PUT', async () => {
      const user = userEvent.setup()
      // No window at all (an interval rule, not fixed days), unlike the bounded series above.
      const interval = { ...series, rrule: 'FREQ=WEEKLY;INTERVAL=1', fixedDays: false, moveWindow: null }
      const { fetch, dialog } = await openTask(interval)

      await user.click(within(dialog).getByRole('button', { name: 'Due Mon, Oct 5' }))
      const month = screen.getByRole('dialog', { name: 'Due date' })
      await user.click(within(month).getByRole('button', { name: 'Remove due date' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await within(dialog).findByText('A repeating task needs a date.')).toBeInTheDocument()
      expect(puts(fetch)).toHaveLength(0)
    })

    it('saves a note on an occurrence already moved past the next repeat', async () => {
      const user = userEvent.setup()
      // Due Thu, Oct 9, but the series' own next repeat is already Wed, Oct 8: another
      // app moved this occurrence past it. A notes-only save must still go through.
      const moved = {
        ...series,
        due: '2026-10-09T00:00:00Z',
        next: { start: null, due: '2026-10-08T00:00:00Z' },
        moveWindow: { from: '2026-10-09T00:00:00Z', until: '2026-10-08T00:00:00Z' },
      }
      const { fetch, dialog } = await openTask(moved)

      await user.type(within(dialog).getByRole('textbox', { name: 'Notes' }), 'watered extra')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await saved(fetch)).toMatchObject({ description: 'watered extra' })
    })
  })
})
