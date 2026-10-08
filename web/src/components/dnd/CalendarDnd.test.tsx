import { useDraggable, useDroppable } from '@dnd-kit/core'
import { MutationObserver, type QueryClient } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { isSameDay } from 'date-fns'
import { enUS } from 'date-fns/locale/en-US'
import { createRef, type ReactNode, type RefObject } from 'react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventChip, ResizeHandle, TimedBlock } from '@/components/events/EventItems'
import { TaskChip } from '@/components/tasks/TaskItems'
import { queryKeys, UNDO_EVENT_KEY } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { endpoints } from '@/lib/api/endpoints'
import { type ApiEvent, type EventRestore, type OccurrenceState, type Todo } from '@/lib/api/schemas'
import { occurrenceTask, toCalTask, type CalTask } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { type DragData, type DropData } from '@/lib/dnd'
import { toCalEvent, type CalEvent, type CalItem } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { previewOf } from '@/lib/quickCreate'
import { type ScopeHint } from '@/lib/scope'
import { useUi } from '@/stores/ui'
import { apiEvent, bodyOf, calendar, jsonResponse, occurrence, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { CalendarDnd } from './CalendarDnd'
import { useScopePreview } from './dndState'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const colors = eventColors('#3b82f6', false)
const rent = toCalTask(todo({ id: 't1', title: 'Pay rent', due: '2026-09-25T00:00:00Z', dueAllDay: true }))!

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }
}

/** A 100 px day cell at `left`; jsdom lays nothing out, so the cells report their rects themselves. */
function Day({ day, left, children }: { day: Date; left: number; children?: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: `day:${day.getDate()}`, data: { type: 'day', day } satisfies DropData })
  return (
    <div ref={setNodeRef} data-left={left} data-testid={`day:${day.getDate()}`}>
      {children}
    </div>
  )
}

/** A day column of the time grid at `left`; it gives its element, as the grid's do. */
function Column({ day, left, columnRef, children }: { day: Date; left: number; columnRef: RefObject<HTMLDivElement | null>; children?: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: `col:${day.getDate()}`, data: { type: 'column', day, ref: columnRef } satisfies DropData })
  return (
    <div
      ref={(el) => {
        columnRef.current = el
        setNodeRef(el)
      }}
      data-left={left}
    >
      {children}
    </div>
  )
}

/** The create popover's draft; the grid's takes only the pointer, this one also the keyboard. */
function Draft({ item, day }: { item: CalItem; day: Date }) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: 'draft',
    data: { type: 'timed', event: item, originDay: day, draft: true } satisfies DragData,
  })
  return (
    <button ref={setNodeRef} type="button" {...attributes} {...listeners}>
      Draft
    </button>
  )
}

/**
 * Day cells from `days[0]` on, with the chips of `events` on their days, through the scope
 * preview like the views (FR-17). Drag IDs name the day, as the views' do. The cell of the
 * `full`th has no room for them, like a full month cell.
 */
function Week({ days, events, full }: { days: Date[]; events: CalEvent[]; full?: number }) {
  const shown = useScopePreview(events).filter((e): e is CalEvent => e.kind === 'event')
  return days.map((day, i) => (
    <Day key={day.getDate()} day={day} left={i * 100}>
      {shown
        .filter((e) => isSameDay(e.startsAt, day) && day.getDate() !== full)
        .map((e) => (
          <EventChip
            key={e.key}
            event={e}
            colors={colors}
            prefs={prefs}
            drag={{ id: `chip:${e.key}:${day.getDate()}`, data: { type: 'event', event: e, originDay: day }, disabled: false }}
          />
        ))}
    </Day>
  ))
}

/**
 * An event of a daily series, on 2026-09-`day` 10:00-11:00 in Berlin, with `p` on top. Without
 * `p`, it is the series' first shown event, which has nothing before it to split off, so the
 * question asks only for this event or all (FR-17).
 */
function standup(day: number, p: Partial<ApiEvent> = {}): CalEvent {
  const start = `2026-09-${day}T08:00:00Z`
  return toCalEvent(
    apiEvent({
      title: 'Standup',
      key: `e1@${start}`,
      start,
      end: `2026-09-${day}T09:00:00Z`,
      recurring: true,
      first: true,
      rrule: 'FREQ=DAILY',
      recurrenceId: start,
      ...p,
    }),
  )
}

/** A later event of the daily series of `standup`, which the series can be split before (FR-17). */
function laterStandup(day: number, p: Partial<ApiEvent> = {}): CalEvent {
  return standup(day, { first: false, ...p })
}

/**
 * Loads the calendars before the first render, as the calendar page has them: the drop's
 * writes take their colors, and would fetch them otherwise.
 */
function loadCalendars(queryClient: QueryClient) {
  queryClient.setQueryData(queryKeys.calendars, [calendar()])
}

/** The views' overlay as the tests see it: what it is handed, nothing drawn. */
type Overlay = (data: DragData, limit: string | null, hint: ScopeHint | null) => ReactNode

/**
 * Renders `events` in a week of day cells from 09-25 (or `days`), and `more` after them, with
 * the calendars loaded as in the app.
 */
function renderWeek(
  events: CalEvent[],
  days = [25, 26, 27].map((d) => new Date(2026, 8, d)),
  more?: ReactNode,
  overlay: Overlay = () => null,
) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.left ? rect(Number(this.dataset.left), 0, 100, 100) : rect(10, 40, 80, 20)
  })
  api.setCsrfToken('tok')
  return renderWithProviders(
    <CalendarDnd renderOverlay={overlay}>
      <Week days={days} events={events} />
      {more}
    </CalendarDnd>,
    loadCalendars,
  )
}

/** The chip named `name` in the day cell of the `day`th. */
function chipIn(day: number, name: string): HTMLElement {
  return within(screen.getByTestId(`day:${day}`)).getByRole('button', { name })
}

/**
 * Renders `event` as a block in Friday's (09-25) column of the time grid, with `children`
 * (a resize handle) in it, and the calendars loaded as in the app.
 */
function renderBlock(event: CalEvent, children?: ReactNode, overlay: Overlay = () => null) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.left ? rect(Number(this.dataset.left), 0, 100, 1152) : rect(10, 480, 80, 46)
  })
  const fri = new Date(2026, 8, 25)
  return renderWithProviders(
    <CalendarDnd renderOverlay={overlay}>
      <Column day={fri} left={0} columnRef={createRef<HTMLDivElement>()}>
        <TimedBlock
          event={event}
          colors={colors}
          prefs={prefs}
          size="md"
          drag={{ id: 'block', data: { type: 'timed', event, originDay: fri }, disabled: false }}
        >
          {children}
        </TimedBlock>
      </Column>
    </CalendarDnd>,
    loadCalendars,
  )
}

/** Moves `item` 15 minutes down with the keyboard (NFR-27). */
async function moveDown(item: HTMLElement) {
  item.focus()
  fireEvent.keyDown(item, { code: 'Space', key: ' ' })
  await act(() => new Promise((resolve) => setTimeout(resolve)))
  fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' })
  fireEvent.keyDown(document, { code: 'Space', key: ' ' })
}

/** Moves `item` one day to the right with the keyboard (NFR-27). */
async function moveRight(item: HTMLElement) {
  item.focus()
  fireEvent.keyDown(item, { code: 'Space', key: ' ' })
  // dnd-kit's sensor listens for keys only from a timer queued at the pick-up.
  await act(() => new Promise((resolve) => setTimeout(resolve)))
  fireEvent.keyDown(document, { code: 'ArrowRight', key: 'ArrowRight' })
  fireEvent.keyDown(document, { code: 'Space', key: ' ' })
}

describe('CalendarDnd', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    act(() => {
      useUi.getState().openCreate(null)
    })
  })

  it('saves a dropped task after the update of it still on its way, with the ETag that one got', async () => {
    // Anything but a day cell is the chip: a drag measures the overlay dnd-kit wraps around it.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.left ? rect(Number(this.dataset.left), 0, 100, 100) : rect(10, 40, 80, 20)
    })
    api.setCsrfToken('tok')
    let release: (r: Response) => void = () => undefined
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      )
      .mockImplementation(() => Promise.resolve(jsonResponse(200, { ...rent.todo, etag: '"3"' })))
    renderWithProviders(
      <CalendarDnd renderOverlay={() => null}>
        <Day day={new Date(2026, 8, 25)} left={0}>
          <TaskChip
            task={rent}
            colors={colors}
            prefs={prefs}
            readOnly={false}
            drag={{ id: 'chip', data: { type: 'event', event: rent, originDay: new Date(2026, 8, 25) }, disabled: false }}
          />
        </Day>
        <Day day={new Date(2026, 8, 26)} left={100} />
      </CalendarDnd>,
      loadCalendars,
    )

    const chip = screen.getByRole('button', { name: 'Pay rent, all day' })
    await moveRight(chip)
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(urlOf(url)).toBe('/api/v1/todos/t1')
    expect(bodyOf(init)).toMatchObject({ due: '2026-09-26T00:00:00.000Z', dueAllDay: true })

    // A second drop while the first is on its way waits for it, instead of conflicting with it.
    await moveRight(chip)
    release(jsonResponse(200, { ...rent.todo, due: '2026-09-26T00:00:00Z', etag: '"2"' }))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2)
    })
    expect(fetch.mock.calls[1]![1]?.headers).toMatchObject({ 'If-Match': '"2"' })
  })

  it('gives the create popover the times of a drop of its draft, and points it at the new column, without saving (FR-09)', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.left ? rect(Number(this.dataset.left), 0, 100, 1152) : rect(10, 480, 80, 46)
    })
    const fetch = vi.spyOn(globalThis, 'fetch')
    const fri = new Date(2026, 8, 25)
    const sat = new Date(2026, 8, 26)
    const friday = createRef<HTMLDivElement>()
    const saturday = createRef<HTMLDivElement>()
    const slot = document.createElement('button')
    act(() => {
      useUi.getState().openCreate({
        origin: { start: new Date(2026, 8, 25, 10), end: new Date(2026, 8, 25, 11), allDay: false, granularity: 'time', ranged: false },
        anchor: slot,
        span: { startMin: 600, endMin: 660 },
        returnFocus: slot,
      })
    })
    const draft = previewOf('event', useUi.getState().createWhen!.event, 'c1', 'Review', 'Europe/Berlin')!
    renderWithProviders(
      <CalendarDnd renderOverlay={() => null}>
        <Column day={fri} left={0} columnRef={friday}>
          <Draft item={draft} day={fri} />
        </Column>
        <Column day={sat} left={100} columnRef={saturday} />
      </CalendarDnd>,
      loadCalendars,
    )

    await moveRight(screen.getByRole('button', { name: 'Draft' }))
    await waitFor(() => {
      expect(useUi.getState().createWhen?.event).toEqual({
        allDay: false,
        startDate: '2026-09-26',
        startTime: '10:00',
        endDate: '2026-09-26',
        endTime: '11:00',
      })
    })
    const create = useUi.getState().create
    expect(create?.anchor).toBe(saturday.current)
    expect(create?.span).toEqual({ startMin: 600, endMin: 660 })
    expect(fetch).not.toHaveBeenCalled()
  })

  describe('an event of a series asks which events move (FR-10, FR-17)', () => {
    const standupAt10 = 'Standup, 10 AM'
    const moveQuestion = 'This event repeats. Which events should move?'
    // On the 15th of each month: another day is beyond the series (FR-17), only this one can go there.
    const monthly = toCalEvent(
      apiEvent({
        title: 'Rent',
        key: 'e1@2026-10-15T08:00:00Z',
        start: '2026-10-15T08:00:00Z',
        end: '2026-10-15T09:00:00Z',
        recurring: true,
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
        recurrenceId: '2026-10-15T08:00:00Z',
      }),
    )
    const october = [15, 16, 17].map((d) => new Date(2026, 9, d))

    /**
     * Like `renderWeek`, but a tile measures in its own day cell, so one of any day can be
     * moved; the overlay dnd-kit wraps around the dragged tile measures like the tile with the
     * focus, which a keyboard drag keeps.
     */
    function renderInCells(events: CalEvent[], days?: Date[]) {
      const result = renderWeek(events, days)
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.dataset.left) return rect(Number(this.dataset.left), 0, 100, 100)
        const cell = this.closest<HTMLElement>('[data-left]') ?? document.activeElement?.closest<HTMLElement>('[data-left]')
        return rect(cell ? Number(cell.dataset.left) + 10 : 10, 40, 80, 20)
      })
      return result
    }

    it('asks after dropping an event of a series, and moves only it', async () => {
      const user = userEvent.setup()
      let release: (r: Response) => void = () => undefined
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      )
      const { queryClient } = renderWeek([standup(25)])

      await moveRight(chipIn(25, standupAt10))
      const question = await screen.findByRole('alertdialog', { name: moveQuestion })
      await waitFor(() => {
        expect(within(question).getByRole('button', { name: 'Only this event' })).toHaveFocus()
      })
      // The question is the popover's only dialog, not one inside another, unnamed one.
      expect(screen.queryByRole('dialog')).toBeNull()
      // Until the answer, the event shows where it was dropped, and nothing is saved.
      expect(chipIn(26, standupAt10)).toBeInTheDocument()
      expect(fetch).not.toHaveBeenCalled()

      await user.keyboard('{Enter}')
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      const [url, init] = fetch.mock.calls[0]!
      expect(urlOf(url)).toBe(`/api/v1/events/e1/occurrences/${encodeURIComponent('2026-09-25T08:00:00Z')}`)
      expect(init?.method).toBe('PUT')
      expect(bodyOf(init)).toMatchObject({ start: '2026-09-26T08:00:00.000Z', end: '2026-09-26T09:00:00.000Z' })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      // While it saves, the event stays where it was dropped, without a saving state (NFR-26),
      // and has the focus back (NFR-27).
      await waitFor(() => {
        expect(chipIn(26, standupAt10)).toHaveFocus()
      })
      expect(chipIn(26, standupAt10)).not.toHaveAttribute('aria-busy')
      release(jsonResponse(200, apiEvent({ title: 'Standup', start: '2026-09-26T08:00:00Z', end: '2026-09-26T09:00:00Z' })))
      await waitFor(() => {
        expect(queryClient.isMutating()).toBe(0)
      })
    })

    it('moves the whole series with All events', async () => {
      const user = userEvent.setup()
      let release: (r: Response) => void = () => undefined
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      )
      const { queryClient } = renderWeek([standup(25)])

      await moveRight(chipIn(25, standupAt10))
      await user.click(await screen.findByRole('button', { name: 'All events' }))
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      const [url, init] = fetch.mock.calls[0]!
      expect(urlOf(url)).toBe('/api/v1/events/e1')
      expect(init?.method).toBe('PUT')
      expect(bodyOf(init)).toMatchObject({
        start: '2026-09-26T08:00:00.000Z',
        end: '2026-09-26T09:00:00.000Z',
        instanceStart: '2026-09-25T08:00:00Z',
      })
      // The series shows its saving state at its old place until it is reloaded (NFR-26).
      expect(chipIn(25, standupAt10)).toHaveAttribute('aria-busy', 'true')
      await waitFor(() => {
        expect(chipIn(25, standupAt10)).toHaveFocus()
      })
      release(jsonResponse(200, apiEvent({ title: 'Standup', start: '2026-09-26T08:00:00Z', end: '2026-09-26T09:00:00Z' })))
      await waitFor(() => {
        expect(queryClient.isMutating()).toBe(0)
      })
    })

    it('marks an event busy while its series is undone', async () => {
      let release: (r: Response) => void = () => undefined
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      )
      const event = standup(25)
      const { queryClient } = renderWeek([event])
      expect(chipIn(25, standupAt10)).not.toHaveAttribute('aria-busy')

      // An undo as the toast after a change of the series runs it (FR-17).
      const undo = new MutationObserver<EventRestore, unknown, { event: CalEvent }>(queryClient, {
        mutationKey: UNDO_EVENT_KEY,
        mutationFn: ({ event: e }) => endpoints.undoEvent(e.id, 'tok'),
      })
      act(() => {
        void undo.mutate({ event })
      })
      await waitFor(() => {
        expect(chipIn(25, standupAt10)).toHaveAttribute('aria-busy', 'true')
      })

      release(jsonResponse(200, { etag: '"3"' }))
      await waitFor(() => {
        expect(chipIn(25, standupAt10)).not.toHaveAttribute('aria-busy')
      })
    })

    // After "All events" the series is reloaded with other recurrence IDs, so the event the undo
    // was started with matches none of the tiles any more: the series is busy by its ID.
    it('marks all events of a series busy while it is undone, whatever their keys', async () => {
      let release: (r: Response) => void = () => undefined
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      )
      const other = toCalEvent(
        apiEvent({
          id: 'e2',
          title: 'Review',
          key: 'e2@2026-09-27T08:00:00Z',
          start: '2026-09-27T08:00:00Z',
          end: '2026-09-27T09:00:00Z',
          recurring: true,
          rrule: 'FREQ=DAILY',
          recurrenceId: '2026-09-27T08:00:00Z',
        }),
      )
      const { queryClient } = renderWeek([standup(25), standup(26), other])
      const busy = (day: number, name: string) => chipIn(day, name).getAttribute('aria-busy')
      expect(busy(25, standupAt10)).toBeNull()

      // The undo of a change that moved the series a day, as the toast runs it: its event is the
      // one as it was shown before, which the reloaded series has no tile of.
      const undo = new MutationObserver<EventRestore, unknown, { event: CalEvent }>(queryClient, {
        mutationKey: UNDO_EVENT_KEY,
        mutationFn: ({ event: e }) => endpoints.undoEvent(e.id, 'tok'),
      })
      act(() => {
        void undo.mutate({ event: standup(24) })
      })
      await waitFor(() => {
        expect(busy(25, standupAt10)).toBe('true')
      })
      expect(busy(26, standupAt10)).toBe('true')
      expect(busy(27, 'Review, 10 AM')).toBeNull()

      release(jsonResponse(200, { etag: '"3"' }))
      await waitFor(() => {
        expect(busy(25, standupAt10)).toBeNull()
      })
      expect(busy(26, standupAt10)).toBeNull()
    })

    it('says why and leaves the series in place when it cannot move like this', async () => {
      const user = userEvent.setup()
      const error = vi.spyOn(toast, 'error')
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(
          jsonResponse(400, {
            error: { code: 'series_move_unsupported', message: "all events of this series can't move like this, only this event can" },
          }),
        ),
      )
      const { queryClient } = renderWeek([standup(25)])

      await moveRight(chipIn(25, standupAt10))
      await user.click(await screen.findByRole('button', { name: 'All events' }))
      await waitFor(() => {
        expect(error).toHaveBeenCalledWith("This series can't move like this. Move only this one instead.")
      })
      await waitFor(() => {
        expect(queryClient.isMutating()).toBe(0)
      })
      // Back at its old place, no longer saving (NFR-26).
      expect(chipIn(25, standupAt10)).not.toHaveAttribute('aria-busy')
      expect(within(screen.getByTestId('day:26')).queryByRole('button')).toBeNull()
    })

    // All events of a series share one ETag; "Only this event" locks none of the others (FR-17).
    describe('after an earlier move of the same series', () => {
      /** Answers to the requests, in order, given only when the test says so. */
      function holdRequests() {
        const answers: ((r: Response) => void)[] = []
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
          () =>
            new Promise<Response>((resolve) => {
              answers.push(resolve)
            }),
        )
        const ifMatch = (i: number) => (fetch.mock.calls[i]?.[1]?.headers as Record<string, string>)['If-Match']
        return { fetch, answers, ifMatch }
      }
      const movedTo27 = () =>
        jsonResponse(
          200,
          apiEvent({ ...standup(26), start: '2026-09-27T08:00:00Z', end: '2026-09-27T09:00:00Z', etag: '"2"', modified: true }),
        )

      /** Moves the 26th's event to the 27th with "Only this event", and leaves its PUT on its way. */
      async function moveOnly26(user: ReturnType<typeof userEvent.setup>) {
        await moveRight(chipIn(26, standupAt10))
        const question = await screen.findByRole('alertdialog', { name: moveQuestion })
        await waitFor(() => {
          expect(within(question).getByRole('button', { name: 'Only this event' })).toHaveFocus()
        })
        await user.keyboard('{Enter}')
      }

      it('moves another event of it after that one, with the ETag that one got', async () => {
        const user = userEvent.setup()
        const { fetch, answers, ifMatch } = holdRequests()
        const { queryClient } = renderInCells([standup(25), standup(26)])

        await moveOnly26(user)
        await waitFor(() => {
          expect(fetch).toHaveBeenCalledTimes(1)
        })
        await moveRight(chipIn(25, standupAt10))
        const question = await screen.findByRole('alertdialog', { name: moveQuestion })
        await waitFor(() => {
          expect(within(question).getByRole('button', { name: 'Only this event' })).toHaveFocus()
        })
        await user.keyboard('{Enter}')

        answers[0]?.(movedTo27())
        await waitFor(() => {
          expect(fetch).toHaveBeenCalledTimes(2)
        })
        expect(urlOf(fetch.mock.calls[1]![0])).toBe(`/api/v1/events/e1/occurrences/${encodeURIComponent('2026-09-25T08:00:00Z')}`)
        expect(ifMatch(1)).toBe('"2"')
        answers[1]?.(jsonResponse(200, apiEvent({ ...standup(25), start: '2026-09-26T08:00:00Z', etag: '"3"' })))
        await waitFor(() => {
          expect(queryClient.isMutating()).toBe(0)
        })
      })

      it.each([
        ['Only this event', `/api/v1/events/e1/occurrences/${encodeURIComponent('2026-09-25T08:00:00Z')}`],
        ['All events', '/api/v1/events/e1'],
      ])('answers the question opened before that one was saved with the ETag it got (%s)', async (choice, url) => {
        const user = userEvent.setup()
        const { fetch, answers, ifMatch } = holdRequests()
        const { queryClient } = renderInCells([standup(25), standup(26)])

        await moveOnly26(user)
        await moveRight(chipIn(25, standupAt10))
        await screen.findByRole('alertdialog', { name: moveQuestion })
        answers[0]?.(movedTo27())
        await waitFor(() => {
          expect(queryClient.isMutating()).toBe(0)
        })

        await user.click(screen.getByRole('button', { name: choice }))
        await waitFor(() => {
          expect(fetch).toHaveBeenCalledTimes(2)
        })
        expect(urlOf(fetch.mock.calls[1]![0])).toBe(url)
        expect(ifMatch(1)).toBe('"2"')
        answers[1]?.(jsonResponse(200, apiEvent({ ...standup(25), start: '2026-09-26T08:00:00Z', etag: '"3"' })))
        await waitFor(() => {
          expect(queryClient.isMutating()).toBe(0)
        })
      })
    })

    it('saves nothing when the question is cancelled with Escape', async () => {
      const user = userEvent.setup()
      const fetch = vi.spyOn(globalThis, 'fetch')
      renderWeek([standup(25)])

      await moveRight(chipIn(25, standupAt10))
      await screen.findByRole('alertdialog', { name: moveQuestion })
      await user.keyboard('{Escape}')

      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(within(screen.getByTestId('day:26')).queryByRole('button')).toBeNull()
      await waitFor(() => {
        expect(chipIn(25, standupAt10)).toHaveFocus()
      })
      expect(fetch).not.toHaveBeenCalled()
    })

    it.each([
      ['at the event at its new place, not at the drag overlay', undefined],
      ['where the drop ended while a full cell hides the event', 26],
    ])('points the question %s', async (_, full) => {
      // Like a browser: the page fills a 1024 x 768 viewport, a tile measures in its day cell,
      // the overlay outside of them, and an element no longer on the page as nothing.
      vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024)
      vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768)
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this === document.documentElement || this === document.body) return rect(0, 0, 1024, 768)
        if (this.dataset.left) return rect(Number(this.dataset.left), 0, 100, 100)
        if (!this.isConnected) return rect(0, 0, 0, 0)
        const cell = this.closest<HTMLElement>('[data-left]')
        return rect(cell ? Number(cell.dataset.left) + 10 : 10, 40, 80, 20)
      })
      vi.spyOn(globalThis, 'fetch')
      const days = [25, 26, 27].map((d) => new Date(2026, 8, d))
      renderWithProviders(
        // The views' overlay: the dragged event's own tile, which can't be dragged itself.
        <CalendarDnd
          renderOverlay={(d) =>
            d.event.kind === 'event' && <EventChip event={d.event} colors={colors} prefs={prefs} drag={{ id: 'overlay', data: d, disabled: true }} />
          }
        >
          <Week days={days} events={[standup(25)]} full={full} />
        </CalendarDnd>,
        loadCalendars,
      )

      await moveRight(chipIn(25, standupAt10))
      await screen.findByRole('alertdialog', { name: moveQuestion })

      // Below the tile in Saturday's cell (left 110, bottom 60), 6 px apart; the drop ended there too.
      await waitFor(() => {
        expect(document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')?.style.transform).toBe(
          'translate(110px, 66px)',
        )
      })
      fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    })

    it('rings every shown event of the series while All events has focus', async () => {
      const user = userEvent.setup()
      vi.spyOn(globalThis, 'fetch')
      renderWeek([standup(25), standup(27)])

      await moveRight(chipIn(25, standupAt10))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Only this event' })).toHaveFocus()
      })
      expect(chipIn(26, standupAt10)).toHaveClass('ring-2')
      expect(chipIn(26, standupAt10).style.getPropertyValue('--tw-ring-color')).toBe(colors.solid)
      expect(chipIn(27, standupAt10)).not.toHaveClass('ring-2')

      await user.tab()
      expect(screen.getByRole('button', { name: 'All events' })).toHaveFocus()
      expect(chipIn(26, standupAt10)).toHaveClass('ring-2')
      expect(chipIn(27, standupAt10)).toHaveClass('ring-2')

      await user.tab()
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
      expect(chipIn(27, standupAt10)).not.toHaveClass('ring-2')
      await user.keyboard('{Escape}')
    })

    it('offers this and following events at a later event and splits the series', async () => {
      const user = userEvent.setup()
      let release: (r: Response) => void = () => undefined
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      )
      const { queryClient } = renderWeek([laterStandup(25)])

      await moveRight(chipIn(25, standupAt10))
      const question = await screen.findByRole('alertdialog', { name: moveQuestion })
      // From the smallest reach to the largest (FR-17).
      const [only, following, all, cancel] = within(question).getAllByRole('button')
      expect(only).toHaveAccessibleName('Only this event')
      expect(following).toHaveAccessibleName('This and following events')
      expect(following).toHaveAccessibleDescription(
        /^From Fri, Sep 25(, 2026)? on, as a series of its own\. Earlier ones stay as they are\.$/,
      )
      expect(all).toHaveAccessibleName('All events')
      expect(cancel).toHaveAccessibleName('Cancel')
      expect(question).not.toHaveAccessibleDescription()

      await user.click(following!)
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      const [url, init] = fetch.mock.calls[0]!
      expect(urlOf(url)).toBe(`/api/v1/events/e1/following/${encodeURIComponent('2026-09-25T08:00:00Z')}`)
      expect(init?.method).toBe('PUT')
      expect(bodyOf(init)).toMatchObject({ start: '2026-09-26T08:00:00.000Z', end: '2026-09-26T09:00:00.000Z' })
      expect(bodyOf(init)).not.toHaveProperty('instanceStart')
      // Not optimistic: the series shows its saving state at its old place until it is reloaded (NFR-26).
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(chipIn(25, standupAt10)).toHaveAttribute('aria-busy', 'true')
      release(
        jsonResponse(200, {
          event: apiEvent({ ...laterStandup(25), id: 'e2', start: '2026-09-26T08:00:00Z', end: '2026-09-26T09:00:00Z' }),
          etag: '"2"',
        }),
      )
      await waitFor(() => {
        expect(queryClient.isMutating()).toBe(0)
      })
    })

    it('leaves out this and following at the first event', async () => {
      vi.spyOn(globalThis, 'fetch')
      renderWeek([standup(25)])

      await moveRight(chipIn(25, standupAt10))
      const question = await screen.findByRole('alertdialog', { name: moveQuestion })
      const [only, all, cancel] = within(question).getAllByRole('button')
      expect(only).toHaveAccessibleName('Only this event')
      expect(all).toHaveAccessibleName('All events')
      expect(cancel).toHaveAccessibleName('Cancel')
      expect(within(question).getAllByRole('button')).toHaveLength(3)
      // Nothing before the first event to keep: nothing to explain either.
      expect(question).not.toHaveAccessibleDescription()
      fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    })

    it('says that attendees keep the series from being split', async () => {
      vi.spyOn(globalThis, 'fetch')
      renderWeek([laterStandup(25, { hasAttendees: true })])

      await moveRight(chipIn(25, standupAt10))
      const question = await screen.findByRole('alertdialog', { name: moveQuestion })
      const [only, all, cancel] = within(question).getAllByRole('button')
      expect(only).toHaveAccessibleName('Only this event')
      expect(all).toHaveAccessibleName('All events')
      expect(cancel).toHaveAccessibleName('Cancel')
      expect(within(question).getAllByRole('button')).toHaveLength(3)
      expect(question).toHaveAccessibleDescription("With attendees, the series can't be split.")
      fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    })

    it('rings this and the later events while this and following has the focus', async () => {
      const user = userEvent.setup()
      vi.spyOn(globalThis, 'fetch')
      const days = [24, 25, 26, 27].map((d) => new Date(2026, 8, d))
      renderInCells([laterStandup(24), laterStandup(25), laterStandup(27)], days)

      // The 25th's event to the 26th.
      await moveRight(chipIn(25, standupAt10))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Only this event' })).toHaveFocus()
      })
      expect(chipIn(26, standupAt10)).toHaveClass('ring-2')
      expect(chipIn(24, standupAt10)).not.toHaveClass('ring-2')
      expect(chipIn(27, standupAt10)).not.toHaveClass('ring-2')

      await user.tab()
      expect(screen.getByRole('button', { name: 'This and following events' })).toHaveFocus()
      expect(chipIn(26, standupAt10)).toHaveClass('ring-2')
      expect(chipIn(27, standupAt10)).toHaveClass('ring-2')
      expect(chipIn(27, standupAt10).style.getPropertyValue('--tw-ring-color')).toBe(colors.solid)
      expect(chipIn(24, standupAt10)).not.toHaveClass('ring-2')

      await user.tab()
      expect(screen.getByRole('button', { name: 'All events' })).toHaveFocus()
      expect(chipIn(24, standupAt10)).toHaveClass('ring-2')
      await user.keyboard('{Escape}')
    })

    it('lets nothing else be dragged while the question is open', async () => {
      vi.spyOn(globalThis, 'fetch')
      const task = (
        <TaskChip
          task={rent}
          colors={colors}
          prefs={prefs}
          readOnly={false}
          drag={{ id: 'task', data: { type: 'event', event: rent, originDay: new Date(2026, 8, 25) }, disabled: false }}
        />
      )
      renderWeek([standup(25), standup(27)], undefined, task)
      expect(screen.getByRole('button', { name: 'Pay rent, all day' })).toHaveAttribute('aria-roledescription', 'draggable')

      await moveRight(chipIn(25, standupAt10))
      await screen.findByRole('alertdialog', { name: moveQuestion })

      expect(chipIn(27, standupAt10)).toHaveAttribute('aria-disabled', 'true')
      expect(screen.getByRole('button', { name: 'Pay rent, all day' })).not.toHaveAttribute('aria-roledescription')
      fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
      await waitFor(() => {
        expect(chipIn(27, standupAt10)).toHaveAttribute('aria-disabled', 'false')
      })
    })

    it('moves a single event without asking', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, apiEvent({ title: 'Review' })))
      renderWeek([toCalEvent(apiEvent({ title: 'Review' }))])

      await moveRight(chipIn(25, 'Review, 10 AM'))
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      expect(urlOf(fetch.mock.calls[0]![0])).toBe('/api/v1/events/e1')
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(screen.getByRole('status')).toHaveTextContent('Event moved.')
    })

    it('does not ask for an invitation to one event of a series', async () => {
      // Only an override was shared, without its series: Lucid sees a single event.
      const invitation = apiEvent({ title: 'Review', key: 'e1@2026-09-25T08:00:00Z', recurrenceId: '2026-09-25T08:00:00Z' })
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, invitation))
      renderWeek([toCalEvent(invitation)])

      await moveRight(chipIn(25, 'Review, 10 AM'))
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      const [url, init] = fetch.mock.calls[0]!
      expect(urlOf(url)).toBe('/api/v1/events/e1')
      expect(bodyOf(init)).not.toHaveProperty('instanceStart')
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })

    it('ends a keyboard drag of a series in the same question', async () => {
      vi.spyOn(globalThis, 'fetch')
      renderWeek([standup(25)])

      await moveRight(chipIn(25, standupAt10))

      expect(screen.getByRole('status')).toHaveTextContent('Choose which events should move.')
      expect(await screen.findByRole('alertdialog', { name: moveQuestion })).toBeInTheDocument()
      fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    })

    it("moves only this event without asking when the series can't follow", async () => {
      let release: (r: Response) => void = () => undefined
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      )
      const { queryClient } = renderWeek([monthly], october)

      await moveRight(chipIn(15, 'Rent, 10 AM'))
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      const [url, init] = fetch.mock.calls[0]!
      expect(urlOf(url)).toBe(`/api/v1/events/e1/occurrences/${encodeURIComponent('2026-10-15T08:00:00Z')}`)
      expect(init?.method).toBe('PUT')
      expect(bodyOf(init)).toMatchObject({ start: '2026-10-16T08:00:00.000Z', end: '2026-10-16T09:00:00.000Z' })
      expect(screen.getByRole('status')).toHaveTextContent('Event moved.')
      // Held at its new place while it saves, as after "Only this event" (NFR-26).
      expect(chipIn(16, 'Rent, 10 AM')).not.toHaveAttribute('aria-busy')
      release(jsonResponse(200, apiEvent({ ...monthly, start: '2026-10-16T08:00:00Z', end: '2026-10-16T09:00:00Z' })))
      await waitFor(() => {
        expect(queryClient.isMutating()).toBe(0)
      })
    })

    // The pill under the dragged event is hidden from screen readers; the announcement says the same
    // (FR-17, NFR-27).
    it('tells under the dragged event that only it can move', async () => {
      vi.spyOn(globalThis, 'fetch')
      const overlay = vi.fn<Overlay>(() => null)
      renderWeek([monthly], october, undefined, overlay)

      const chip = chipIn(15, 'Rent, 10 AM')
      chip.focus()
      fireEvent.keyDown(chip, { code: 'Space', key: ' ' })
      await act(() => new Promise((resolve) => setTimeout(resolve)))
      expect(overlay.mock.lastCall?.[2]).toBeNull()

      fireEvent.keyDown(document, { code: 'ArrowRight', key: 'ArrowRight' })
      const hint = overlay.mock.lastCall?.[2]
      expect(hint?.text).toBe('Only this event. The series stays on its days.')
      expect(hint?.reach).toBe('this')
      expect(screen.getByRole('status')).toHaveTextContent(
        /^New time: .+\. Only this event\. The series stays on its days\.$/,
      )

      // Back on its own day, a drop would change nothing, and there is nothing to say.
      fireEvent.keyDown(document, { code: 'ArrowLeft', key: 'ArrowLeft' })
      expect(overlay.mock.lastCall?.[2]).toBeNull()
      expect(screen.getByRole('status')).toHaveTextContent('Time unchanged.')
      fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
    })

    it('gives no hint where the series can follow', async () => {
      vi.spyOn(globalThis, 'fetch')
      const overlay = vi.fn<Overlay>(() => null)
      const weekly = toCalEvent(
        apiEvent({
          title: 'Standup',
          key: 'e1@2026-09-25T08:00:00Z',
          recurring: true,
          rrule: 'FREQ=WEEKLY',
          recurrenceId: '2026-09-25T08:00:00Z',
        }),
      )
      renderBlock(weekly, undefined, overlay)

      const block = screen.getByRole('button', { name: 'Standup, 10 AM – 11 AM' })
      block.focus()
      fireEvent.keyDown(block, { code: 'Space', key: ' ' })
      await act(() => new Promise((resolve) => setTimeout(resolve)))
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' })

      // The drag has a target, 15 minutes later the same day, which the whole series can follow.
      const [data, , hint] = overlay.mock.lastCall ?? []
      expect(data?.event.startsAt).toEqual(new Date('2026-09-25T08:15:00Z'))
      expect(hint).toBeNull()
      expect(screen.getByRole('status')).toHaveTextContent(/^New time: [^.]+\.$/)
      fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
    })

    it('keeps the question after a keyboard move within the day', async () => {
      // After a keyboard drop, dnd-kit gives the focus back to the dragged tile when it has lost
      // it. Here the tile stays where it was: that must not take the focus from the question,
      // which would close it (NFR-27).
      vi.spyOn(globalThis, 'fetch')
      renderBlock(standup(25))

      await moveDown(screen.getByRole('button', { name: 'Standup, 10 AM – 11 AM' }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Only this event' })).toHaveFocus()
      })
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))

      expect(screen.getByRole('alertdialog', { name: moveQuestion })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Only this event' })).toHaveFocus()
      fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    })

    it('asks which events change after resizing an event of a series', async () => {
      vi.spyOn(globalThis, 'fetch')
      const event = standup(25)
      renderBlock(event, <ResizeHandle event={event} disabled={false} />)

      // The handle takes no Tab stop, but a keyboard drag of it ends like a pointer's.
      await moveDown(screen.getByRole('button', { name: 'Change end time' }))

      expect(screen.getByRole('status')).toHaveTextContent('Choose which events should change.')
      expect(
        await screen.findByRole('alertdialog', { name: 'This event repeats. Which events should change?' }),
      ).toBeInTheDocument()
      // Nothing else can be dragged meanwhile, the length included (FR-17).
      expect(screen.queryByRole('button', { name: 'Change end time' })).toBeNull()
      fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    })
  })

  describe('dropping a task of a series (FR-10, FR-17)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    const moveQuestion = 'This task repeats. Which repeats should move?'
    const october = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => new Date(2026, 9, from + i))

    /** A date as the wire writes the repeats of the series below, which are due on whole days. */
    const dayOf = (d: number, month = 10) => `2026-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00Z`

    /** Due Mondays and Thursdays: its current repeat is due Mon 10-05, the next one Thu 10-08. */
    function watering(p: Partial<Todo> = {}): Todo {
      return todo({
        id: 't2',
        title: 'Water the flowers',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
        due: dayOf(5),
        dueAllDay: true,
        recurring: true,
        fixedDays: true,
        recurrenceId: dayOf(5),
        next: { due: dayOf(8), dueAllDay: true },
        ...p,
      })
    }

    /** The repeat of `series` due on `due`, as the views place it. */
    function repeatOn(series: Todo, due: string, state: OccurrenceState = 'upcoming'): CalTask {
      return occurrenceTask(
        occurrence({ key: `t2@${due}`, todoId: 't2', title: series.title, recurrenceId: due, due, dueAllDay: true, state }),
        series,
      )!
    }

    /** Day cells of `days` with the chips of `tasks` on their days, through the scope preview like the views (FR-17). */
    function TaskDays({ days, tasks }: { days: Date[]; tasks: CalTask[] }) {
      const shown = useScopePreview(tasks).filter((e): e is CalTask => e.kind === 'task')
      return days.map((day, i) => (
        <Day key={day.getDate()} day={day} left={i * 100}>
          {shown
            .filter((task) => isSameDay(task.startsAt, day))
            .map((task) => (
              <TaskChip
                key={task.key}
                task={task}
                colors={colors}
                prefs={prefs}
                readOnly={false}
                drag={{ id: `chip:${task.key}:${day.getDate()}`, data: { type: 'event', event: task, originDay: day }, disabled: false }}
              />
            ))}
        </Day>
      ))
    }

    /**
     * Renders `tasks` in the day cells of October `days` (default the 4th to the 13th) on Mon 10-05, noon,
     * with the calendars loaded as in the app. A tile measures in its own day cell, and the overlay dnd-kit
     * wraps around the dragged one like the tile with the focus, which a keyboard drag keeps.
     */
    function renderTasks(tasks: CalTask[], { days = october(4, 13), overlay = () => null }: { days?: Date[]; overlay?: Overlay } = {}) {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 9, 5, 12))
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.dataset.left) return rect(Number(this.dataset.left), 0, 100, 100)
        const cell = this.closest<HTMLElement>('[data-left]') ?? document.activeElement?.closest<HTMLElement>('[data-left]')
        return rect(cell ? Number(cell.dataset.left) + 10 : 10, 40, 80, 20)
      })
      api.setCsrfToken('tok')
      return renderWithProviders(
        <CalendarDnd renderOverlay={overlay}>
          <TaskDays days={days} tasks={tasks} />
        </CalendarDnd>,
        loadCalendars,
      )
    }

    /** The task tile, with its ring, of the chip named `name` in the day cell of the `day`th. */
    const tileIn = (day: number, name: string) => chipIn(day, name).closest<HTMLElement>('[data-task-key]')!

    /** Picks `chip` up with the keyboard and moves it one day to the right, without dropping it (NFR-27). */
    async function dragRight(chip: HTMLElement) {
      chip.focus()
      fireEvent.keyDown(chip, { code: 'Space', key: ' ' })
      await act(() => new Promise((resolve) => setTimeout(resolve)))
      fireEvent.keyDown(document, { code: 'ArrowRight', key: 'ArrowRight' })
    }

    const current = 'Water the flowers, all day'
    const planned = (date: string) => `Water the flowers, planned repeat on ${date}`

    /**
     * Each place of the reach icon of the toast `message` from left to right: '✓' for a done repeat, else the
     * dot's fill ('none' for a ring).
     */
    function marksOf(calls: Parameters<typeof toast.success>[], message: string): (string | null)[] {
      const { container } = render(<>{calls.find(([m]) => m === message)?.[1]?.icon}</>)
      return [...container.querySelectorAll('svg > *')].map((m) => (m.tagName === 'path' ? '✓' : m.getAttribute('fill')))
    }
    const dot = colors.solid

    it('asks at the current repeat, and holds only it at its drop while it is detached', async () => {
      const user = userEvent.setup()
      let release: (r: Response) => void = () => undefined
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      )
      const success = vi.spyOn(toast, 'success')
      const series = watering()
      const { queryClient } = renderTasks([repeatOn(series, dayOf(5), 'current'), repeatOn(series, dayOf(8))])

      await moveRight(chipIn(5, current))
      expect(screen.getByRole('status')).toHaveTextContent('Choose which repeats should move.')
      const question = await screen.findByRole('alertdialog', { name: moveQuestion })
      const [only, all, cancel] = within(question).getAllByRole('button')
      expect(only).toHaveAccessibleName('Only this repeat')
      expect(only).toHaveAccessibleDescription('Becomes a task of its own. The series goes on Thu, Oct 8.')
      expect(all).toHaveAccessibleName('All repeats')
      expect(cancel).toHaveAccessibleName('Cancel')
      expect(question).not.toHaveAccessibleDescription()
      await waitFor(() => {
        expect(only).toHaveFocus()
      })
      // Until the answer, the repeat shows where it was dropped, and nothing is saved.
      expect(chipIn(6, current)).toBeInTheDocument()
      expect(within(screen.getByTestId('day:5')).queryByRole('button', { name: current })).toBeNull()
      expect(fetch).not.toHaveBeenCalled()

      await user.keyboard('{Enter}')
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      const [url, init] = fetch.mock.calls[0]!
      expect(urlOf(url)).toBe(`/api/v1/todos/t2/occurrences/${encodeURIComponent(dayOf(5))}`)
      expect(init?.method).toBe('PUT')
      // The series' values with the repeat's new date; the rule belongs to the series.
      expect(bodyOf(init)).toMatchObject({ title: 'Water the flowers', due: '2026-10-06T00:00:00.000Z', dueAllDay: true })
      expect(bodyOf(init)).not.toHaveProperty('rrule')
      expect(screen.queryByRole('alertdialog')).toBeNull()
      // While it saves, the repeat stays where it was dropped (NFR-26), and has the focus back (NFR-27).
      await waitFor(() => {
        expect(chipIn(6, current)).toHaveFocus()
      })
      expect(within(screen.getByTestId('day:5')).queryByRole('button', { name: current })).toBeNull()

      release(
        jsonResponse(200, {
          ...series,
          due: dayOf(8),
          recurrenceId: dayOf(8),
          next: { due: dayOf(12), dueAllDay: true },
          etag: '"2"',
          undoToken: 'u1',
          detachedCopy: todo({ id: 't3', title: 'Water the flowers', due: '2026-10-06T00:00:00Z', dueAllDay: true, detachedFrom: 'u1' }),
        }),
      )
      const moved = 'Moved to Tue, Oct 6 as a task of its own. The series goes on Thu, Oct 8.'
      await waitFor(() => {
        expect(success).toHaveBeenCalledWith(moved, expect.anything())
      })
      // ✓ ✓ ● ○ ○: only the current repeat.
      expect(marksOf(success.mock.calls, moved)).toEqual(['✓', '✓', dot, 'none', 'none'])
      await waitFor(() => {
        expect(queryClient.isMutating()).toBe(0)
      })
      // Settled, it is no longer held: these views are not reloaded, so it shows where it was.
      await waitFor(() => {
        expect(chipIn(5, current)).toBeInTheDocument()
      })
    })

    it.each([
      [
        'This and following repeats',
        `/api/v1/todos/t2/following/${encodeURIComponent(dayOf(8))}`,
        // The repeat's new date.
        '2026-10-09T00:00:00.000Z',
        {
          todo: todo({ id: 't4', title: 'Water the flowers', rrule: 'FREQ=WEEKLY;BYDAY=TU,FR', recurring: true, due: dayOf(9) }),
          series: { ...watering(), etag: '"2"' },
          undoToken: 'u1',
        },
        'Moved from Thu, Oct 8 on, as a series of its own.',
        // ✓ ○ ● ● ●: from this repeat on; the current one stays.
        ['✓', 'none', dot, dot, dot],
      ],
      [
        'All repeats',
        '/api/v1/todos/t2',
        // The series' dates, which are its current repeat's, moved as far as the repeat was.
        '2026-10-06T00:00:00.000Z',
        { ...watering(), due: '2026-10-06T00:00:00Z', etag: '"2"', undoToken: 'u1' },
        'Series moved. Next up: Tue, Oct 6',
        // ✓ ● ● ● ●: the current repeat too.
        ['✓', dot, dot, dot, dot],
      ],
    ])('asks at a later repeat, and saves %s', async (choice, url, due, answer, message, marks) => {
      const user = userEvent.setup()
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, answer))
      const success = vi.spyOn(toast, 'success')
      const series = watering()
      const { queryClient } = renderTasks([repeatOn(series, dayOf(5), 'current'), repeatOn(series, dayOf(8))])

      await moveRight(chipIn(8, planned('Thu, Oct 8')))
      const question = await screen.findByRole('alertdialog', { name: moveQuestion })
      const buttons = within(question).getAllByRole('button')
      expect(buttons.map((b) => b.textContent)).toEqual([
        expect.stringMatching(/^This and following repeats/),
        expect.stringMatching(/^All repeats/),
        'Cancel',
      ])
      // Only the current repeat can be detached: the question says why it isn't offered here.
      expect(question).toHaveAccessibleDescription('Only the current repeat can be changed on its own.')
      expect(chipIn(9, planned('Fri, Oct 9'))).toBeInTheDocument()

      await user.click(within(question).getByRole('button', { name: choice }))
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      const [called, init] = fetch.mock.calls[0]!
      expect(urlOf(called)).toBe(url)
      expect(init?.method).toBe('PUT')
      expect(bodyOf(init)).toMatchObject({ title: 'Water the flowers', due, dueAllDay: true })
      expect(bodyOf(init)).not.toHaveProperty('rrule')
      await waitFor(() => {
        expect(success).toHaveBeenCalledWith(message, expect.anything())
      })
      expect(marksOf(success.mock.calls, message)).toEqual(marks)
      await waitFor(() => {
        expect(queryClient.isMutating()).toBe(0)
      })
    })

    // The pill under the dragged task and the stop mark come from `renderOverlay`'s `limit` (FR-17); screen
    // readers hear the same (NFR-27).
    it("says under the dragged repeat why it can't move there, and saves nothing", async () => {
      const fetch = vi.spyOn(globalThis, 'fetch')
      const message = vi.spyOn(toast, 'message')
      const overlay = vi.fn<Overlay>(() => null)
      // On the 15th of each month: no repeat of it can go to another day, nor can the series.
      const rent = watering({
        title: 'Pay rent',
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
        due: dayOf(15, 9),
        recurrenceId: dayOf(15, 9),
        next: { due: dayOf(15), dueAllDay: true },
      })
      renderTasks([repeatOn(rent, dayOf(15))], { days: october(14, 17), overlay })

      await dragRight(chipIn(15, 'Pay rent, planned repeat on Thu, Oct 15'))
      expect(overlay.mock.lastCall?.[1]).toBe("Can't move. The series stays on its days.")
      expect(overlay.mock.lastCall?.[2]).toBeNull()
      expect(screen.getByRole('status')).toHaveTextContent("Can't move. The series stays on its days.")

      // Back on its own day, a drop would change nothing, and there is nothing to say.
      fireEvent.keyDown(document, { code: 'ArrowLeft', key: 'ArrowLeft' })
      expect(overlay.mock.lastCall?.[1]).toBeNull()
      fireEvent.keyDown(document, { code: 'ArrowRight', key: 'ArrowRight' })
      fireEvent.keyDown(document, { code: 'Space', key: ' ' })

      expect(screen.getByRole('status')).toHaveTextContent("Can't move. The series stays on its days.")
      expect(message).toHaveBeenCalledWith('Not moved', { description: 'The series stays on its days.' })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(chipIn(15, 'Pay rent, planned repeat on Thu, Oct 15')).toBeInTheDocument()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('moves the last repeat at once, as a single task', async () => {
      const series = watering({ next: null })
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonResponse(200, { ...series, due: '2026-10-06T00:00:00Z', etag: '"2"' }))
      const overlay = vi.fn<Overlay>(() => null)
      const { queryClient } = renderTasks([repeatOn(series, dayOf(5), 'current')], { overlay })

      await dragRight(chipIn(5, current))
      // Nothing to choose, nothing to say.
      expect(overlay.mock.lastCall?.slice(1)).toEqual([null, null])
      fireEvent.keyDown(document, { code: 'Space', key: ' ' })

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      const [url, init] = fetch.mock.calls[0]!
      expect(urlOf(url)).toBe('/api/v1/todos/t2')
      expect(bodyOf(init)).toMatchObject({ due: '2026-10-06T00:00:00.000Z', dueAllDay: true })
      expect(screen.getByRole('status')).toHaveTextContent('Task moved.')
      await waitFor(() => {
        expect(queryClient.isMutating()).toBe(0)
      })
    })

    it('moves all repeats at once where attendees keep the current one in the series, as the pill said', async () => {
      const series = watering({ hasAttendees: true })
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse(200, { ...series, due: '2026-10-06T00:00:00Z', next: { due: dayOf(9), dueAllDay: true }, etag: '"2"' }),
      )
      const success = vi.spyOn(toast, 'success')
      const overlay = vi.fn<Overlay>(() => null)
      const { queryClient } = renderTasks([repeatOn(series, dayOf(5), 'current')], { overlay })

      await dragRight(chipIn(5, current))
      const hint = overlay.mock.lastCall?.[2]
      expect(hint?.text).toBe("Moves all repeats. With attendees, a repeat can't become a task of its own.")
      expect(hint?.slots).toEqual(['done', 'done', 'affected', 'affected', 'affected'])
      expect(overlay.mock.lastCall?.[1]).toBeNull()
      expect(screen.getByRole('status')).toHaveTextContent(
        /^New time: .+\. Moves all repeats\. With attendees, a repeat can't become a task of its own\.$/,
      )
      fireEvent.keyDown(document, { code: 'Space', key: ' ' })

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      const [url, init] = fetch.mock.calls[0]!
      expect(urlOf(url)).toBe('/api/v1/todos/t2')
      expect(bodyOf(init)).toMatchObject({ due: '2026-10-06T00:00:00.000Z', dueAllDay: true })
      // Its toast draws the repeats it reached, as the pill did.
      const moved = 'Moved to Tue, Oct 6. Then: Fri, Oct 9'
      await waitFor(() => {
        expect(success).toHaveBeenCalledWith(moved, expect.anything())
      })
      // ✓ ✓ ● ● ●, as the pill drew it.
      expect(marksOf(success.mock.calls, moved)).toEqual(['✓', '✓', dot, dot, dot])
      await waitFor(() => {
        expect(queryClient.isMutating()).toBe(0)
      })
    })

    it('saves nothing when the question is cancelled with Escape, and gives the focus back to the repeat', async () => {
      const user = userEvent.setup()
      const fetch = vi.spyOn(globalThis, 'fetch')
      const series = watering()
      renderTasks([repeatOn(series, dayOf(5), 'current')])

      await moveRight(chipIn(5, current))
      await screen.findByRole('alertdialog', { name: moveQuestion })
      await user.keyboard('{Escape}')

      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(within(screen.getByTestId('day:6')).queryByRole('button')).toBeNull()
      await waitFor(() => {
        expect(chipIn(5, current)).toHaveFocus()
      })
      expect(fetch).not.toHaveBeenCalled()
    })

    it('points the question at the repeat at its new place, not at the drag overlay', async () => {
      vi.spyOn(globalThis, 'fetch')
      renderTasks([repeatOn(watering(), dayOf(5), 'current')], {
        // The views' overlay: the dragged repeat's own tile, without a drag binding.
        overlay: (d) => d.event.kind === 'task' && <TaskChip task={d.event} colors={colors} prefs={prefs} readOnly={false} />,
      })
      // Like a browser: the page fills a 1024 x 768 viewport, a tile measures in its day cell 10 px
      // above its middle, where a keyboard drop centres the overlay, and an element no longer on the
      // page as nothing.
      vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024)
      vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768)
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this === document.documentElement || this === document.body) return rect(0, 0, 1024, 768)
        if (this.dataset.left) return rect(Number(this.dataset.left), 0, 100, 100)
        if (!this.isConnected) return rect(0, 0, 0, 0)
        const cell = this.closest<HTMLElement>('[data-left]') ?? document.activeElement?.closest<HTMLElement>('[data-left]')
        return rect(cell ? Number(cell.dataset.left) + 10 : 10, 30, 80, 20)
      })

      await moveRight(chipIn(5, current))
      await screen.findByRole('alertdialog', { name: moveQuestion })

      // Below the tile in Tuesday's cell (left 210, bottom 50), 6 px apart; the drop ended 10 px lower.
      await waitFor(() => {
        expect(document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')?.style.transform).toBe(
          'translate(210px, 56px)',
        )
      })
      fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    })

    it('rings only this and the later repeats while the pointer is on This and following repeats', async () => {
      const user = userEvent.setup()
      vi.spyOn(globalThis, 'fetch')
      const series = watering()
      renderTasks([repeatOn(series, dayOf(5), 'current'), repeatOn(series, dayOf(8)), repeatOn(series, dayOf(12))])

      // The repeat of Thu 10-08 to Fri 10-09.
      await moveRight(chipIn(8, planned('Thu, Oct 8')))
      const following = await screen.findByRole('button', { name: 'This and following repeats' })
      await waitFor(() => {
        expect(following).toHaveFocus()
      })
      await user.tab()
      expect(screen.getByRole('button', { name: 'All repeats' })).toHaveFocus()
      expect(tileIn(5, current)).toHaveClass('ring-2')

      await user.hover(following)
      expect(tileIn(9, planned('Fri, Oct 9'))).toHaveClass('ring-2')
      expect(tileIn(12, planned('Mon, Oct 12'))).toHaveClass('ring-2')
      expect(tileIn(12, planned('Mon, Oct 12')).style.getPropertyValue('--tw-ring-color')).toBe(colors.solid)
      expect(tileIn(5, current)).not.toHaveClass('ring-2')
      await user.keyboard('{Escape}')
    })
  })
})
