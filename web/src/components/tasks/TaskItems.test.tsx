import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { enUS } from 'date-fns/locale/en-US'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api/client'
import { canDrag, occurrenceTask, toCalTask } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { formatShortTime, type FormatPrefs } from '@/lib/format'
import { useUi } from '@/stores/ui'
import { bodyOf, jsonResponse, occurrence, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { TaskAgendaRow, TaskBar, TaskBlock, TaskChip } from './TaskItems'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const colors = eventColors('#3b82f6', false)
const task = (p: Parameters<typeof todo>[0] = {}) =>
  toCalTask(todo({ id: 't1', title: 'Pay rent', due: '2026-09-25T08:00:00Z', ...p }))!

// A recurring series and one of its occurrences (FR-17), joined as `useCalendarTasks` would.
const series = (p: Parameters<typeof todo>[0] = {}) =>
  todo({ id: 't1', title: 'Water the flowers', rrule: 'FREQ=DAILY', recurring: true, ...p })
const occurrenceOf = (p: Parameters<typeof occurrence>[0]) =>
  occurrenceTask(occurrence({ todoId: 't1', title: 'Water the flowers', ...p }), series())!

describe('task items', () => {
  afterEach(() => {
    useUi.getState().openDetail(null)
  })

  it('toggles completion optimistically and keeps the start', async () => {
    api.setCsrfToken('tok')
    let resolve: (r: Response) => void = () => undefined
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolve = r
        }),
    )
    const t = task({ start: '2026-09-25T07:00:00Z' })
    const user = userEvent.setup()
    renderWithProviders(<TaskChip task={t} colors={colors} prefs={prefs} readOnly={false} />)
    const box = screen.getByRole('checkbox', { name: 'Completed: Pay rent' })
    await user.click(box)
    await waitFor(() => {
      expect(box).toHaveAttribute('aria-checked', 'true')
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(urlOf(url)).toBe('/api/v1/todos/t1')
    expect(bodyOf(init)).toMatchObject({ status: 'COMPLETED', start: '2026-09-25T07:00:00Z' })
    resolve(jsonResponse(200, { ...t.todo, status: 'COMPLETED', etag: '"2"' }))
  })

  it('opens the task details at the title, not the editor', async () => {
    const t = task()
    const user = userEvent.setup()
    renderWithProviders(<TaskBar task={t} colors={colors} prefs={prefs} readOnly={false} />)
    const title = screen.getByRole('button', { name: /Pay rent/ })
    await user.click(title)
    expect(useUi.getState().detail).toEqual({ item: t, anchor: title })
    expect(useUi.getState().taskEditor).toBeNull()
  })

  it('read-only calendar disables the checkbox but still opens the details', async () => {
    const t = task()
    const user = userEvent.setup()
    renderWithProviders(<TaskAgendaRow task={t} time="10 AM" colors={colors} prefs={prefs} readOnly />)
    expect(screen.getByRole('checkbox', { name: 'Completed: Pay rent' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Pay rent/ }))
    expect(useUi.getState().detail?.item).toBe(t)
  })

  it('labels an untitled task', () => {
    renderWithProviders(<TaskChip task={task({ title: '' })} colors={colors} prefs={prefs} readOnly={false} />)
    expect(screen.getByRole('checkbox', { name: 'Completed: (No title)' })).toBeInTheDocument()
    expect(screen.getByText('(No title)')).toBeInTheDocument()
  })

  it('shows only the time of a point task in the grid', () => {
    const point = task()
    const { unmount } = renderWithProviders(<TaskBlock task={point} colors={colors} prefs={prefs} readOnly={false} size="md" />)
    const block = screen.getByRole('button', { name: /Pay rent/ })
    expect(block).toHaveTextContent(formatShortTime(point.startsAt, prefs))
    expect(block).not.toHaveTextContent('–')
    unmount()

    const span = task({ start: '2026-09-25T07:00:00Z' })
    renderWithProviders(<TaskBlock task={span} colors={colors} prefs={prefs} readOnly={false} size="md" />)
    expect(screen.getByRole('button', { name: /Pay rent/ })).toHaveTextContent(
      `${formatShortTime(span.startsAt, prefs)} – ${formatShortTime(span.endsAt, prefs)}`,
    )
  })

  it('strikes through a completed task', () => {
    renderWithProviders(<TaskChip task={task({ status: 'COMPLETED' })} colors={colors} prefs={prefs} readOnly={false} />)
    expect(screen.getByText('Pay rent')).toHaveClass('line-through')
    expect(screen.getByRole('checkbox', { name: 'Completed: Pay rent' })).toHaveAttribute('aria-checked', 'true')
  })

  it('marks its root with the task key and calendar', () => {
    const { container } = renderWithProviders(
      <TaskChip task={task({ calendarId: 'c9' })} colors={colors} prefs={prefs} readOnly={false} />,
    )
    expect(container.querySelector('[data-task-key="task:t1"][data-calendar-id="c9"]')).not.toBeNull()
  })

  it('opens the details from anywhere on a grid block', async () => {
    const t = task({ start: '2026-09-25T07:00:00Z' })
    const user = userEvent.setup()
    renderWithProviders(<TaskBlock task={t} colors={colors} prefs={prefs} readOnly={false} size="md" />)
    // The tinted surface the user sees is the button itself, not a wrapper around it.
    const surface = screen.getByRole('button', { name: /Pay rent/ })
    expect(surface).toHaveStyle({ backgroundColor: colors.tint })
    await user.click(surface)
    expect(useUi.getState().detail?.item).toBe(t)
  })

  it('opens the details from the agenda time', async () => {
    const t = task()
    const user = userEvent.setup()
    renderWithProviders(<TaskAgendaRow task={t} time="10 AM" colors={colors} prefs={prefs} readOnly={false} />)
    await user.click(screen.getByText('10 AM'))
    expect(useUi.getState().detail?.item).toBe(t)
  })

  describe('recurring occurrences (FR-17)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('pencils in an upcoming occurrence: no checkbox, a planned-repeat name, not draggable', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 8, 25, 12))
      const t = occurrenceOf({
        due: '2026-10-08T00:00:00Z',
        dueAllDay: true,
        state: 'upcoming',
        recurrenceId: '2026-10-08T00:00:00Z',
        key: 't1@2026-10-08T00:00:00Z',
      })
      renderWithProviders(
        <TaskChip
          task={t}
          colors={colors}
          prefs={prefs}
          readOnly={false}
          drag={{ id: 'x', data: { type: 'event', event: t, originDay: t.startsAt }, disabled: !canDrag(t) }}
        />,
      )
      expect(screen.queryByRole('checkbox')).toBeNull()
      const button = screen.getByRole('button', { name: 'Water the flowers, planned repeat on Thu, Oct 8' })
      expect(button).not.toHaveAttribute('aria-roledescription')
    })

    it('shows a done occurrence with a checked, disabled checkbox', () => {
      const t = occurrenceOf({
        due: '2026-10-01T00:00:00Z',
        dueAllDay: true,
        state: 'done',
        recurrenceId: '2026-10-01T00:00:00Z',
        key: 't1@2026-10-01T00:00:00Z',
      })
      renderWithProviders(<TaskChip task={t} colors={colors} prefs={prefs} readOnly={false} />)
      const box = screen.getByRole('checkbox', { name: 'Completed: Water the flowers' })
      expect(box).toHaveAttribute('aria-checked', 'true')
      expect(box).toBeDisabled()
    })

    it('keeps the current occurrence completable and marks it recurring', () => {
      const t = occurrenceOf({
        due: '2026-10-05T00:00:00Z',
        dueAllDay: true,
        state: 'current',
        recurrenceId: '2026-10-05T00:00:00Z',
        key: 't1@2026-10-05T00:00:00Z',
      })
      renderWithProviders(<TaskChip task={t} colors={colors} prefs={prefs} readOnly={false} />)
      expect(screen.getByRole('checkbox', { name: 'Completed: Water the flowers' })).toBeEnabled()
      expect(screen.getByRole('img', { name: 'Every day' })).toBeInTheDocument()
    })

    it('previews an upcoming occurrence as dashed, with no background-color style', () => {
      const t = occurrenceOf({
        due: '2026-10-08T00:00:00Z',
        dueAllDay: true,
        state: 'upcoming',
        recurrenceId: '2026-10-08T00:00:00Z',
        key: 't1@2026-10-08T00:00:00Z',
      })
      renderWithProviders(<TaskBlock task={t} colors={colors} prefs={prefs} readOnly={false} size="md" />)
      const block = screen.getByRole('button', { name: /Water the flowers/ })
      expect(block).toHaveClass('border-dashed')
      expect(block.style.backgroundColor).toBe('')
    })
  })
})

