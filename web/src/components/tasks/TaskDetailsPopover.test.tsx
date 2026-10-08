import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { type Todo, type TodoOccurrence } from '@/lib/api/schemas'
import { occurrenceTask, repeatOf, toCalTask, type CalTask } from '@/lib/calendarTasks'
import { useUi } from '@/stores/ui'
import { bodyOf, calendar, jsonResponse, occurrence, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { TaskDetailsPopover } from './TaskDetailsPopover'

const calendars = [calendar(), calendar({ id: 'c2', name: 'Shared', color: '#22c55e', readOnly: true })]

// Vitest runs in Europe/Berlin (CEST until 25 Oct 2026, UTC+2).
const allDay = (iso: string) => `${iso}T00:00:00Z`

/** Open the details of `task` as a click on it in the calendar does: the calendars are loaded by then. */
async function open(task: CalTask, name: string) {
  api.setCsrfToken('tok')
  // A skip answers with the rolled series, an end with the series as written; every other write with nothing.
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const written = init?.method === 'DELETE' && /\/(occurrences|following)\//.test(urlOf(input))
    return Promise.resolve(written ? jsonResponse(200, { ...task.todo, etag: '"2"' }) : jsonResponse(204))
  })
  const { queryClient } = renderWithProviders(
    <>
      <button type="button">Chip</button>
      <TaskDetailsPopover />
    </>,
  )
  queryClient.setQueryData(queryKeys.calendars, calendars)
  const anchor = screen.getByRole('button', { name: 'Chip' })
  act(() => {
    useUi.getState().openDetail({ item: task, anchor })
  })
  return { fetch, queryClient, task, dialog: await screen.findByRole('dialog', { name }) }
}

/** Open the details of a plain (non-recurring) task, as `open` for a `Todo` built from `p`. */
async function openDetails(p: Partial<Todo>) {
  const t = todo({ title: 'Pay rent', due: '2026-09-25T08:00:00Z', ...p })
  return open(toCalTask(t)!, p.title ?? 'Pay rent')
}

describe('TaskDetailsPopover', () => {
  afterEach(() => {
    useUi.getState().openDetail(null)
    useUi.getState().openTaskEditor(null)
    vi.restoreAllMocks()
  })

  it('shows the task as in its list: check, title, when it is due, list', async () => {
    const { dialog } = await openDetails({})
    expect(within(dialog).getByRole('checkbox', { name: 'Completed: Pay rent' })).toHaveAttribute('aria-checked', 'false')
    expect(within(dialog).getByRole('heading', { name: 'Pay rent' })).toBeInTheDocument()
    expect(within(dialog).getByText(/^Due Fri, Sep 25(, 2026)?, 10:00 AM$/)).toBeInTheDocument()
    expect(within(dialog).getByText('Personal')).toBeInTheDocument()
    // No priority, checklist or notes: no rows for them.
    expect(within(dialog).queryByText('None')).toBeNull()
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Edit task' })).toHaveFocus()
    })
  })

  it.each([
    ['a due date', { due: allDay('2026-09-25'), dueAllDay: true }, /^Due Fri, Sep 25(, 2026)?$/],
    ['a start time alone', { due: null, start: '2026-09-25T08:00:00Z' }, /^Starts Fri, Sep 25(, 2026)?, 10:00 AM$/],
    ['a start date alone', { due: null, start: allDay('2026-09-25'), startAllDay: true }, /^Starts Fri, Sep 25(, 2026)?$/],
    ['start and due times', { start: '2026-09-25T07:00:00Z', due: '2026-09-25T09:00:00Z' }, /^Fri, Sep 25(, 2026)?, 9:00 – 11:00 AM$/],
    [
      'start and due dates',
      { start: allDay('2026-09-24'), startAllDay: true, due: allDay('2026-09-25'), dueAllDay: true },
      /^Thu, Sep 24 – Fri, Sep 25(, 2026)?$/,
    ],
  ])('says when the task is in the calendar: %s', async (_name, dates, when) => {
    const { dialog } = await openDetails(dates)
    expect(within(dialog).getByText(when)).toBeInTheDocument()
  })

  it('marks an open task past its due date as overdue', async () => {
    const { dialog } = await openDetails({ due: '2020-03-13T09:00:00Z' })
    expect(within(dialog).getByText('Overdue')).toBeInTheDocument()
  })

  it('does not mark a completed task as overdue', async () => {
    const { dialog } = await openDetails({ due: '2020-03-13T09:00:00Z', status: 'COMPLETED' })
    expect(within(dialog).getByRole('checkbox', { name: 'Completed: Pay rent' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog).queryByText('Overdue')).toBeNull()
  })

  it('shows the priority, the checklist and the notes with their links', async () => {
    const { dialog } = await openDetails({
      priority: 1,
      checklist: [
        { text: 'Milk', done: true },
        { text: 'Bread', done: false },
      ],
      description: 'Transfer via https://bank.example.com/pay.',
    })
    expect(within(dialog).getByText('High')).toBeInTheDocument()
    // A list, not controls: items are ticked off in the editor.
    const items = within(dialog).getAllByRole('listitem')
    expect(items.map((i) => i.textContent)).toEqual(['Milk', 'Bread'])
    expect(within(items[0]!).getByRole('img', { name: 'Completed' })).toBeInTheDocument()
    expect(within(items[1]!).queryByRole('img')).toBeNull()
    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(1)
    expect(within(dialog).getByRole('link', { name: 'https://bank.example.com/pay' })).toHaveAttribute(
      'href',
      'https://bank.example.com/pay',
    )
  })

  it('completes the task from its check and closes', async () => {
    const user = userEvent.setup()
    const { dialog, fetch } = await openDetails({ id: 't7' })
    await user.click(within(dialog).getByRole('checkbox', { name: 'Completed: Pay rent' }))
    expect(useUi.getState().detail).toBeNull()
    await waitFor(() => {
      const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(put && urlOf(put[0])).toBe('/api/v1/todos/t7')
      expect(put && bodyOf(put[1])).toMatchObject({ status: 'COMPLETED', due: '2026-09-25T08:00:00Z' })
    })
  })

  it('offers only closing for a task in a read-only list', async () => {
    const { dialog } = await openDetails({ calendarId: 'c2' })
    expect(within(dialog).getByText('Read-only')).toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: 'Completed: Pay rent' })).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: 'Edit task' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Delete task' })).toBeNull()
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    })
  })

  it('asks before deleting the task', async () => {
    const user = userEvent.setup()
    const { dialog, fetch } = await openDetails({ id: 't7' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
    const alert = within(dialog).getByRole('alert')
    expect(alert).toHaveTextContent('Delete this task?')
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)

    await user.click(within(alert).getByRole('button', { name: 'Delete task' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'DELETE' && urlOf(input).endsWith('/todos/t7'))).toBe(true)
    })
    expect(useUi.getState().detail).toBeNull()
  })

  it('opens the editor with the task as it is now, not as it was clicked', async () => {
    const user = userEvent.setup()
    const { dialog, queryClient, task } = await openDetails({})
    // A reload replaced the task since: new title and ETag.
    const now = { ...task.todo, title: 'Pay rent and bills', etag: '"2"' }
    act(() => {
      queryClient.setQueryData(queryKeys.todos('c1'), { todos: [now], corrupted: [] })
    })
    expect(await within(dialog).findByRole('heading', { name: 'Pay rent and bills' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Edit task' }))
    expect(useUi.getState().taskEditor).toEqual({ mode: 'edit', todo: now })
    expect(useUi.getState().detail).toBeNull()
  })

  describe('recurring series (FR-17)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    // A recurring series and one of its occurrences (FR-17), joined as `useCalendarTasks` would.
    const series = (p: Partial<Todo> = {}) =>
      todo({
        id: 't1',
        calendarId: 'c1',
        title: 'Water the flowers',
        rrule: 'FREQ=DAILY',
        recurring: true,
        due: '2026-10-05T00:00:00Z',
        dueAllDay: true,
        ...p,
      })
    const occurrenceOf = (p: Partial<TodoOccurrence>) =>
      occurrenceTask(occurrence({ todoId: 't1', calendarId: 'c1', title: 'Water the flowers', ...p }), series())!

    it('shows an upcoming occurrence with its own date, no checkbox, and when it can be completed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 9, 5, 12))
      const t = occurrenceOf({
        due: '2026-10-08T00:00:00Z',
        dueAllDay: true,
        state: 'upcoming',
        recurrenceId: '2026-10-08T00:00:00Z',
        key: 't1@2026-10-08T00:00:00Z',
      })
      const { dialog } = await open(t, 'Water the flowers')
      expect(within(dialog).queryByRole('checkbox')).toBeNull()
      expect(within(dialog).getByText('Due Thu, Oct 8')).toBeInTheDocument()
      expect(within(dialog).getByText('Can be completed once Mon, Oct 5 is done.')).toBeInTheDocument()
    })

    it('says an upcoming occurrence on fixed days can be completed once the current one is done, like any other', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 9, 5, 12))
      const t = occurrenceTask(
        occurrence({
          todoId: 't1',
          calendarId: 'c1',
          title: 'Water the flowers',
          due: '2026-10-08T00:00:00Z',
          dueAllDay: true,
          state: 'upcoming',
          recurrenceId: '2026-10-08T00:00:00Z',
          key: 't1@2026-10-08T00:00:00Z',
        }),
        series({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TH', fixedDays: true }),
      )!
      const { dialog } = await open(t, 'Water the flowers')
      expect(within(dialog).getByText('Can be completed once Mon, Oct 5 is done.')).toBeInTheDocument()
    })

    it('marks the current occurrence of an overdue series overdue', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 9, 7, 12))
      const t = occurrenceOf({
        due: '2026-10-05T00:00:00Z',
        dueAllDay: true,
        state: 'current',
        recurrenceId: '2026-10-05T00:00:00Z',
        key: 't1@2026-10-05T00:00:00Z',
      })
      const { dialog } = await open(t, 'Water the flowers')
      expect(within(dialog).getByText('Overdue')).toBeInTheDocument()
    })

    // Only the current occurrence can be completed, so only it can be late: not the repeats after it, passed or not.
    it.each(['2026-10-06', '2026-10-08'])('does not mark the upcoming occurrence of %s overdue', async (date) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 9, 7, 12))
      const t = occurrenceOf({
        due: allDay(date),
        dueAllDay: true,
        state: 'upcoming',
        recurrenceId: allDay(date),
        key: `t1@${allDay(date)}`,
      })
      const { dialog } = await open(t, 'Water the flowers')
      expect(within(dialog).getByText('Can be completed once Mon, Oct 5 is done.')).toBeInTheDocument()
      expect(within(dialog).queryByText('Overdue')).toBeNull()
    })

    it('shows a done occurrence as completed elsewhere', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 9, 5, 12))
      const t = occurrenceOf({
        due: '2026-10-01T00:00:00Z',
        dueAllDay: true,
        state: 'done',
        recurrenceId: '2026-10-01T00:00:00Z',
        key: 't1@2026-10-01T00:00:00Z',
      })
      const { dialog } = await open(t, 'Water the flowers')
      expect(within(dialog).getByText('Completed in another app.')).toBeInTheDocument()
    })

    it('keeps the current occurrence completable and names the rule', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 9, 5, 12))
      const t = occurrenceOf({
        due: '2026-10-05T00:00:00Z',
        dueAllDay: true,
        state: 'current',
        recurrenceId: '2026-10-05T00:00:00Z',
        key: 't1@2026-10-05T00:00:00Z',
      })
      const { dialog } = await open(t, 'Water the flowers')
      expect(within(dialog).getByRole('checkbox', { name: 'Completed: Water the flowers' })).toBeEnabled()
      expect(within(dialog).getByText('Every day')).toBeInTheDocument()
    })

    // The series moves on to its next repeat: details left open would still show the one just completed.
    it('completes the current occurrence from its check and closes', async () => {
      const user = userEvent.setup()
      const t = occurrenceOf({
        due: '2026-10-05T00:00:00Z',
        dueAllDay: true,
        state: 'current',
        recurrenceId: '2026-10-05T00:00:00Z',
        key: 't1@2026-10-05T00:00:00Z',
      })
      const { dialog, fetch } = await open(t, 'Water the flowers')
      await user.click(within(dialog).getByRole('checkbox', { name: 'Completed: Water the flowers' }))
      expect(useUi.getState().detail).toBeNull()
      await waitFor(() => {
        const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')
        expect(put && urlOf(put[0])).toBe('/api/v1/todos/t1')
        expect(put && bodyOf(put[1])).toMatchObject({ status: 'COMPLETED' })
      })
    })

    describe('at a repeat of a series', () => {
      // A series due Monday, Oct 5 with Tuesday's repeat next; `repeatAt` is a repeat of it, the current one by default.
      const daily = series({
        recurrenceId: '2026-10-05T00:00:00Z',
        next: { start: null, due: '2026-10-06T00:00:00Z' },
      })
      const repeatAt = (date: string, state: TodoOccurrence['state'], t: Todo = daily) =>
        occurrenceTask(
          occurrence({
            todoId: t.id,
            calendarId: t.calendarId,
            title: 'Water the flowers',
            due: allDay(date),
            dueAllDay: true,
            state,
            recurrenceId: allDay(date),
            key: `t1@${allDay(date)}`,
          }),
          t,
        )!
      const question = 'This task repeats. Which repeats should be deleted?'
      const deletes = (fetch: Awaited<ReturnType<typeof open>>['fetch']) =>
        fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([input]) => urlOf(input))
      const awaitDelete = (fetch: Awaited<ReturnType<typeof open>>['fetch']) =>
        waitFor(() => {
          expect(deletes(fetch)).toHaveLength(1)
        })

      beforeEach(() => {
        // Only the date: fake timers would stall the requests.
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date(2026, 9, 5, 12))
      })

      it('asks which repeats to delete at the current repeat, and skips only it', async () => {
        const user = userEvent.setup()
        const { dialog, fetch } = await open(repeatAt('2026-10-05', 'current'), 'Water the flowers')
        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))

        const asked = within(dialog).getByRole('alertdialog', { name: question })
        expect(within(asked).getByRole('button', { name: 'Cancel' })).toHaveFocus()
        expect(within(asked).getAllByRole('button').map((b) => b.textContent)).toEqual([
          'Only this repeatSkipped. The series goes on Tue, Oct 6.',
          'All repeatsDone and detached ones stay.',
          'Cancel',
        ])
        // What a delete reaches is red; the repeat done before stays.
        const [only] = within(asked).getAllByRole('button')
        expect(Array.from(only!.querySelectorAll('circle'), (c) => c.getAttribute('fill'))).toContain('var(--destructive)')
        expect(deletes(fetch)).toEqual([])

        await user.click(within(asked).getByRole('button', { name: 'Only this repeat' }))
        await awaitDelete(fetch)
        expect(deletes(fetch)).toEqual(['/api/v1/todos/t1/occurrences/2026-10-05T00%3A00%3A00Z'])
        expect(useUi.getState().detail).toBeNull()
      })

      it('ends the series before a later repeat with This and following repeats', async () => {
        const user = userEvent.setup()
        const { dialog, fetch } = await open(repeatAt('2026-10-08', 'upcoming'), 'Water the flowers')
        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))

        const asked = within(dialog).getByRole('alertdialog', { name: question })
        expect(within(asked).getAllByRole('button').map((b) => b.textContent)).toEqual([
          'This and following repeatsThe series ends before Thu, Oct 8.',
          'All repeatsDone and detached ones stay.',
          'Cancel',
        ])
        // "Only this repeat" is for the current repeat alone, and the question says so.
        expect(asked).toHaveAccessibleDescription('Only the current repeat can be changed on its own.')

        await user.click(within(asked).getByRole('button', { name: 'This and following repeats' }))
        await awaitDelete(fetch)
        expect(deletes(fetch)).toEqual(['/api/v1/todos/t1/following/2026-10-08T00%3A00%3A00Z'])
        expect(useUi.getState().detail).toBeNull()
      })

      // FR-17: the toast draws in red the reach of the "All repeats" chosen, from the repeat it was chosen at.
      const red = 'var(--destructive)'
      it.each([
        ['current', '2026-10-05', ['✓', '✓', red, red, red]],
        ['upcoming', '2026-10-08', ['✓', red, red, red, red]],
      ] as const)('deletes the whole series with All repeats from the %s repeat', async (state, date, marks) => {
        const user = userEvent.setup()
        const success = vi.spyOn(toast, 'success')
        const { dialog, fetch } = await open(repeatAt(date, state), 'Water the flowers')
        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
        await user.click(within(within(dialog).getByRole('alertdialog', { name: question })).getByRole('button', { name: 'All repeats' }))
        await awaitDelete(fetch)
        expect(deletes(fetch)).toEqual(['/api/v1/todos/t1'])
        expect(useUi.getState().detail).toBeNull()

        await waitFor(() => {
          expect(success).toHaveBeenCalledWith('Task deleted', expect.objectContaining({ id: 'series:t1' }))
        })
        const [, options] = success.mock.calls.filter(([m]) => m === 'Task deleted').at(-1)!
        const { container } = render(<>{options?.icon}</>)
        expect(Array.from(container.querySelectorAll('svg > *'), (m) => (m.tagName === 'path' ? '✓' : m.getAttribute('fill')))).toEqual(
          marks,
        )
      })

      // Review Focus 3: the last repeat is a single task.
      it('asks only whether to delete the last repeat, and deletes the task', async () => {
        const user = userEvent.setup()
        const lastOne = series({ recurrenceId: '2026-10-05T00:00:00Z', next: null })
        const { dialog, fetch } = await open(repeatAt('2026-10-05', 'current', lastOne), 'Water the flowers')
        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))

        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        const alert = within(dialog).getByRole('alert')
        expect(alert).toHaveTextContent('Delete this task?')
        await user.click(within(alert).getByRole('button', { name: 'Delete task' }))
        await awaitDelete(fetch)
        expect(deletes(fetch)).toEqual(['/api/v1/todos/t1'])
      })

      // With attendees, no repeat can be split off: "all repeats" is the only option, and it is confirmed, not asked.
      it('confirms deleting all repeats of a series with attendees at a later repeat', async () => {
        const user = userEvent.setup()
        const shared = series({ recurrenceId: '2026-10-05T00:00:00Z', next: daily.next, hasAttendees: true })
        const { dialog, fetch } = await open(repeatAt('2026-10-08', 'upcoming', shared), 'Water the flowers')
        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))

        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        const alert = within(dialog).getByRole('alert')
        expect(alert).toHaveTextContent('This task repeats. Delete all repeats? Completed ones stay.')
        const success = vi.spyOn(toast, 'success')
        await user.click(within(alert).getByRole('button', { name: 'Delete task' }))
        await awaitDelete(fetch)
        expect(deletes(fetch)).toEqual(['/api/v1/todos/t1'])
        // A delete only confirmed keeps its plain toast.
        await waitFor(() => {
          expect(success).toHaveBeenCalledWith('Task deleted')
        })
      })

      it('skips the current repeat of a series with attendees, which detaches nothing', async () => {
        const user = userEvent.setup()
        const shared = series({ recurrenceId: '2026-10-05T00:00:00Z', next: daily.next, hasAttendees: true })
        const { dialog, fetch } = await open(repeatAt('2026-10-05', 'current', shared), 'Water the flowers')
        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
        await user.click(within(within(dialog).getByRole('alertdialog', { name: question })).getByRole('button', { name: 'Only this repeat' }))
        await awaitDelete(fetch)
        expect(deletes(fetch)).toEqual(['/api/v1/todos/t1/occurrences/2026-10-05T00%3A00%3A00Z'])
      })

      // NFR-27, Review Focus 5: Escape leaves the question, not the details, and the focus goes back.
      it('cancels only the delete question on Escape, leaving the details open', async () => {
        const user = userEvent.setup()
        const { dialog, fetch } = await open(repeatAt('2026-10-05', 'current'), 'Water the flowers')
        await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
        within(dialog).getByRole('alertdialog', { name: question })

        await user.keyboard('{Escape}')

        expect(within(dialog).queryByRole('alertdialog')).toBeNull()
        expect(screen.getByRole('dialog', { name: 'Water the flowers' })).toBe(dialog)
        expect(within(dialog).getByRole('button', { name: 'Delete task' })).toHaveFocus()
        expect(deletes(fetch)).toEqual([])
        expect(useUi.getState().detail).not.toBeNull()

        // A second Escape closes the details, as the question is gone.
        await user.keyboard('{Escape}')
        expect(useUi.getState().detail).toBeNull()
      })

      it('opens the editor at the repeat that was clicked', async () => {
        const user = userEvent.setup()
        const clicked = repeatAt('2026-10-08', 'upcoming')
        const { dialog } = await open(clicked, 'Water the flowers')
        await user.click(within(dialog).getByRole('button', { name: 'Edit task' }))
        expect(useUi.getState().taskEditor).toEqual({ mode: 'edit', todo: daily, repeat: repeatOf(clicked) })
        expect(useUi.getState().taskEditor).toMatchObject({ repeat: { recurrenceId: allDay('2026-10-08'), at: 'upcoming' } })
        expect(useUi.getState().detail).toBeNull()
      })

      it('opens the editor at the current repeat', async () => {
        const user = userEvent.setup()
        const { dialog } = await open(repeatAt('2026-10-05', 'current'), 'Water the flowers')
        await user.click(within(dialog).getByRole('button', { name: 'Edit task' }))
        expect(useUi.getState().taskEditor).toMatchObject({ mode: 'edit', repeat: { recurrenceId: allDay('2026-10-05'), at: 'current' } })
      })

      describe('a task detached from its series', () => {
        // "Only this repeat" made this a task of its own; the series it left goes on Mon, Oct 12.
        const detached = todo({ id: 't9', uid: 'u9', title: 'Water the flowers', due: allDay('2026-10-05'), dueAllDay: true, detachedFrom: 'u1' })
        const origin = todo({ id: 't1', uid: 'u1', title: 'Water the flowers', rrule: 'FREQ=WEEKLY', recurring: true, due: allDay('2026-10-12'), dueAllDay: true })

        it('shows the mark and where the series goes on', async () => {
          const { dialog, queryClient } = await open(toCalTask(detached)!, 'Water the flowers')
          act(() => {
            queryClient.setQueryData(queryKeys.todos('c1'), { todos: [origin, detached], corrupted: [] })
          })
          expect(await within(dialog).findByText('Detached from its series. The series goes on Mon, Oct 12.')).toBeInTheDocument()
          // The mark sits in the rule row's icon column, which is hidden from screen readers: the sentence says it.
          expect(dialog.querySelector('[aria-label="Detached from its series"]')).not.toBeNull()
          // A task of its own repeats no more: no rule.
          expect(within(dialog).queryByText(/^Every /)).toBeNull()
        })

        it('says only that it is detached without the series', async () => {
          const { dialog, queryClient } = await open(toCalTask(detached)!, 'Water the flowers')
          // Another list has the series' UID; the series is looked up in this task's list.
          act(() => {
            queryClient.setQueryData(queryKeys.todos('c1'), { todos: [detached], corrupted: [] })
            queryClient.setQueryData(queryKeys.todos('c2'), { todos: [{ ...origin, calendarId: 'c2' }], corrupted: [] })
          })
          expect(within(dialog).getByText('Detached from its series.')).toBeInTheDocument()
          expect(within(dialog).queryByText(/The series goes on/)).toBeNull()
          expect(dialog.querySelector('[aria-label="Detached from its series"]')).not.toBeNull()
        })

        it('shows nothing of it for a task that never was in a series', async () => {
          const { dialog } = await open(toCalTask({ ...detached, detachedFrom: null })!, 'Water the flowers')
          expect(within(dialog).queryByText(/Detached from its series/)).toBeNull()
          expect(dialog.querySelector('[aria-label="Detached from its series"]')).toBeNull()
        })
      })
    })
  })
})
