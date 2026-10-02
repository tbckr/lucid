import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { type Todo, type TodoOccurrence } from '@/lib/api/schemas'
import { occurrenceTask, toCalTask, type CalTask } from '@/lib/calendarTasks'
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
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse(204)))
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

    it('says an upcoming occurrence on fixed days can also only be moved once the current one is done', async () => {
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
      expect(within(dialog).getByText('Can be completed and moved once Mon, Oct 5 is done.')).toBeInTheDocument()
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

    it('asks to delete all repeats for a series', async () => {
      const user = userEvent.setup()
      const t = occurrenceOf({
        due: '2026-10-05T00:00:00Z',
        dueAllDay: true,
        state: 'current',
        recurrenceId: '2026-10-05T00:00:00Z',
        key: 't1@2026-10-05T00:00:00Z',
      })
      const { dialog } = await open(t, 'Water the flowers')
      await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
      expect(within(dialog).getByRole('alert')).toHaveTextContent('This task repeats. Delete all repeats? Completed ones stay.')
    })
  })
})
