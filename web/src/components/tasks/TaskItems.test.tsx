import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { enUS } from 'date-fns/locale/en-US'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DndStateContext, type DndState } from '@/components/dnd/dndState'
import { api } from '@/lib/api/client'
import { canDrag, occurrenceTask, toCalTask } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { type ScopePreview } from '@/lib/dnd'
import { formatShortTime, type FormatPrefs } from '@/lib/format'
import { type Scope } from '@/lib/scope'
import { useUi } from '@/stores/ui'
import { bodyOf, jsonResponse, occurrence, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { TaskAgendaRow, TaskBar, TaskBlock, TaskChip } from './TaskItems'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
/** The views' drag state with nothing going on. */
const dndDefaults: DndState = {
  pendingKeys: new Set(),
  pendingSeries: new Set(),
  pendingTodos: new Set(),
  resize: null,
  activeId: null,
  scope: null,
  held: null,
  scopeAnchor: () => undefined,
}
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

    it('pencils in an upcoming occurrence: no checkbox, a planned-repeat name, and draggable, on fixed days too', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 8, 25, 12))
      const t = occurrenceTask(
        occurrence({
          todoId: 't1',
          title: 'Water the flowers',
          due: '2026-10-08T00:00:00Z',
          dueAllDay: true,
          state: 'upcoming',
          recurrenceId: '2026-10-08T00:00:00Z',
          key: 't1@2026-10-08T00:00:00Z',
        }),
        series({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TH', fixedDays: true }),
      )!
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
      expect(button).toHaveAttribute('aria-roledescription', 'draggable')
    })

    it('opens the details from the pencil mark of an upcoming occurrence, not the cell underneath', async () => {
      const t = occurrenceOf({
        due: '2026-10-08T17:00:00Z',
        state: 'upcoming',
        recurrenceId: '2026-10-08T17:00:00Z',
        key: 't1@2026-10-08T17:00:00Z',
      })
      const user = userEvent.setup()
      const items = [
        <TaskChip key="chip" task={t} colors={colors} prefs={prefs} readOnly={false} />,
        <TaskBar key="bar" task={t} colors={colors} prefs={prefs} readOnly={false} />,
        <TaskBlock key="block" task={t} colors={colors} prefs={prefs} readOnly={false} size="md" />,
        <TaskAgendaRow key="agenda" task={t} time="5 PM" colors={colors} prefs={prefs} readOnly={false} />,
      ]
      // The month cell creates an event from a click that reaches it.
      const cell = vi.fn()
      document.body.addEventListener('click', cell)
      for (const item of items) {
        const { container, unmount } = renderWithProviders(item)
        await user.click(container.querySelector('.rounded-full.border-dashed')!)
        expect(useUi.getState().detail).toEqual({ item: t, anchor: screen.getByRole('button', { name: /Water the flowers/ }) })
        useUi.getState().openDetail(null)
        unmount()
      }
      document.body.removeEventListener('click', cell)
      expect(cell).not.toHaveBeenCalled()
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

    it('drops the repeat mark before the title in a narrow chip or one-line block', () => {
      const t = occurrenceOf({
        due: '2026-10-05T17:00:00Z',
        state: 'current',
        recurrenceId: '2026-10-05T17:00:00Z',
        key: 't1@2026-10-05T17:00:00Z',
      })
      const { unmount } = renderWithProviders(<TaskChip task={t} colors={colors} prefs={prefs} readOnly={false} />)
      const chip = screen.getByRole('button', { name: /^Water the flowers, / }).closest('[data-task-key]')
      expect(chip).toHaveClass('@container')
      expect(screen.getByRole('img', { name: 'Every day' })).toHaveClass('@max-[9rem]:hidden')
      unmount()

      renderWithProviders(<TaskBlock task={t} colors={colors} prefs={prefs} readOnly={false} size="xs" />)
      expect(screen.getByRole('button', { name: /^Water the flowers, / })).toHaveClass('@container')
      expect(screen.getByRole('img', { name: 'Every day' })).toHaveClass('@max-[7rem]:hidden')
    })

    it('keeps the repeat mark of a two-line block, whose title has its own line', () => {
      const t = occurrenceOf({
        due: '2026-10-05T17:00:00Z',
        state: 'current',
        recurrenceId: '2026-10-05T17:00:00Z',
        key: 't1@2026-10-05T17:00:00Z',
      })
      renderWithProviders(<TaskBlock task={t} colors={colors} prefs={prefs} readOnly={false} size="md" />)
      expect(screen.getByRole('img', { name: 'Every day' }).getAttribute('class')).not.toContain('@max-')
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

    // The current occurrence of a fixed-day series, as the drag overlay shows it over a day it can't reach.
    const current = () =>
      occurrenceTask(
        occurrence({
          todoId: 't1',
          title: 'Water the flowers',
          due: '2026-10-05T00:00:00Z',
          dueAllDay: true,
          state: 'current',
          recurrenceId: '2026-10-05T00:00:00Z',
          key: 't1@2026-10-05T00:00:00Z',
        }),
        series({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TH', fixedDays: true }),
      )!

    it('pencils in a blocked overlay item with a stop mark instead of the checkbox', () => {
      const t = current()
      const items = [
        { item: <TaskChip task={t} colors={colors} prefs={prefs} readOnly={false} blocked />, dashed: 'root' },
        { item: <TaskBar task={t} colors={colors} prefs={prefs} readOnly={false} blocked />, dashed: 'root' },
        { item: <TaskBlock task={t} colors={colors} prefs={prefs} readOnly={false} size="md" blocked />, dashed: 'button' },
      ] as const
      for (const { item, dashed } of items) {
        const { container, unmount } = renderWithProviders(item)
        expect(screen.queryByRole('checkbox')).toBeNull()
        const stop = container.querySelector('.lucide-ban')
        expect(stop).not.toBeNull()
        expect(stop).toHaveAttribute('aria-hidden', 'true')
        const outlined = dashed === 'root' ? container.querySelector<HTMLElement>('[data-task-key]')! : screen.getByRole('button')
        expect(outlined).toHaveClass('border-dashed')
        expect(outlined.style.borderColor).not.toBe('')
        expect(outlined.style.backgroundColor).toBe('')
        unmount()
      }
    })

    it('keeps the checkbox of the same item without blocked', () => {
      const { container } = renderWithProviders(<TaskBar task={current()} colors={colors} prefs={prefs} readOnly={false} />)
      expect(screen.getByRole('checkbox')).toBeInTheDocument()
      expect(container.querySelector('.lucide-ban')).toBeNull()
    })
  })

  // While the question which repeats a dropped one moves is open, the tiles its option in focus reaches get a ring.
  describe('the reach of the scope question (FR-17)', () => {
    const weekly = series({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TH', recurrenceId: '2026-10-05T00:00:00Z' })
    const repeatOn = (day: string, state: 'current' | 'upcoming' | 'done', todoId = 't1') =>
      occurrenceTask(
        occurrence({ key: `${todoId}@${day}`, todoId, title: `${state} ${day.slice(5, 10)}`, recurrenceId: day, due: day, dueAllDay: true, state }),
        todoId === 't1' ? weekly : series({ id: todoId }),
      )!
    // A done repeat, the current one, the one asked about, one after it, and the next repeat of another series.
    const tiles = [
      repeatOn('2026-10-01T00:00:00Z', 'done'),
      repeatOn('2026-10-05T00:00:00Z', 'current'),
      repeatOn('2026-10-08T00:00:00Z', 'upcoming'),
      repeatOn('2026-10-12T00:00:00Z', 'upcoming'),
      repeatOn('2026-10-08T00:00:00Z', 'upcoming', 't9'),
    ]
    const asked = tiles[2]!

    function renderAsked(reach: Scope | null, items = tiles) {
      const scope: ScopePreview = {
        kind: 'task',
        key: asked.key,
        id: 't1',
        from: '2026-10-08T00:00:00Z',
        to: { start: null, startAllDay: false, due: '2026-10-09T00:00:00.000Z', dueAllDay: true },
        reach,
      }
      const state = { ...dndDefaults, scope }
      return renderWithProviders(
        <DndStateContext value={state}>
          {items.map((t) => (
            <TaskChip key={t.key} task={t} colors={colors} prefs={prefs} readOnly={false} />
          ))}
        </DndStateContext>,
      )
    }
    const ringed = (container: HTMLElement) =>
      Array.from(container.querySelectorAll<HTMLElement>('[data-task-key].ring-2')).map(
        (el) => `${el.dataset.taskKey?.startsWith('t9') ? 'other ' : ''}${el.textContent}`,
      )

    it.each([
      // The repeat asked about, wherever the focus is.
      [null, ['upcoming 10-08']],
      ['this', ['upcoming 10-08']],
      // From it on, by recurrence ID.
      ['following', ['upcoming 10-08', 'upcoming 10-12']],
      // Every open repeat of the series, the current one too.
      ['all', ['current 10-05', 'upcoming 10-08', 'upcoming 10-12']],
    ] as const)('rings for %s the repeats it reaches', (reach, want) => {
      const { container } = renderAsked(reach)
      expect(ringed(container)).toEqual(want)
      const ring = container.querySelector<HTMLElement>('[data-task-key].ring-2')
      expect(ring?.style.getPropertyValue('--tw-ring-color')).toBe(colors.solid)
    })

    it('rings a bar and a grid block too', () => {
      for (const item of [
        <TaskBar key="bar" task={asked} colors={colors} prefs={prefs} readOnly={false} />,
        <TaskBlock key="block" task={asked} colors={colors} prefs={prefs} readOnly={false} size="md" />,
      ]) {
        const scope: ScopePreview = {
          kind: 'task',
          key: asked.key,
          id: 't1',
          from: '2026-10-08T00:00:00Z',
          to: { start: null, startAllDay: false, due: '2026-10-09T00:00:00.000Z', dueAllDay: true },
          reach: 'all',
        }
        const { container, unmount } = renderWithProviders(<DndStateContext value={{ ...dndDefaults, scope }}>{item}</DndStateContext>)
        expect(container.querySelector('.ring-2')).not.toBeNull()
        unmount()
      }
    })

    it('rings no task while an event of a series is asked about', () => {
      const scope: ScopePreview = {
        kind: 'event',
        key: asked.key,
        id: 't1',
        from: '2026-10-08T00:00:00Z',
        start: '2026-10-09T00:00:00.000Z',
        end: '2026-10-10T00:00:00.000Z',
        reach: 'all',
      }
      const { container } = renderWithProviders(
        <DndStateContext value={{ ...dndDefaults, scope }}>
          {tiles.map((t) => (
            <TaskChip key={t.key} task={t} colors={colors} prefs={prefs} readOnly={false} />
          ))}
        </DndStateContext>,
      )
      expect(container.querySelector('.ring-2')).toBeNull()
    })
  })

  // A repeat made a task of its own ("Only this repeat", FR-17) no longer repeats, but is marked as one changed on its own.
  it('marks a task detached from its series in every view', () => {
    const t = task({ detachedFrom: 'u-series' })
    for (const item of [
      <TaskChip key="chip" task={t} colors={colors} prefs={prefs} readOnly={false} />,
      <TaskBar key="bar" task={t} colors={colors} prefs={prefs} readOnly={false} />,
      <TaskBlock key="block" task={t} colors={colors} prefs={prefs} readOnly={false} size="md" />,
      <TaskAgendaRow key="agenda" task={t} time="10 AM" colors={colors} prefs={prefs} readOnly={false} />,
    ]) {
      const { unmount } = renderWithProviders(item)
      const mark = screen.getByRole('img', { name: 'Detached from its series' })
      // The repeat glyph with the dot of an occurrence changed on its own.
      expect(mark).toHaveClass('lucide-repeat-changed')
      unmount()
    }
  })

  it('marks no plain task', () => {
    renderWithProviders(<TaskChip task={task()} colors={colors} prefs={prefs} readOnly={false} />)
    expect(screen.queryByRole('img')).toBeNull()
  })
})
