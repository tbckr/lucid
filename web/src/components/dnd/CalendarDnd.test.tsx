import { useDraggable, useDroppable } from '@dnd-kit/core'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { isSameDay } from 'date-fns'
import { enUS } from 'date-fns/locale/en-US'
import { createRef, type ReactNode, type RefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventChip, ResizeHandle, TimedBlock } from '@/components/events/EventItems'
import { TaskChip } from '@/components/tasks/TaskItems'
import { queryKeys } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { outsideWindow, toCalTask } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { type DragData, type DropData } from '@/lib/dnd'
import { toCalEvent, type CalEvent, type CalItem } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { previewOf } from '@/lib/quickCreate'
import { useUi } from '@/stores/ui'
import { apiEvent, bodyOf, calendar, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { CalendarDnd } from './CalendarDnd'
import { useDndState, useScopePreview } from './dndState'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const colors = eventColors('#3b82f6', false)
const rent = toCalTask(todo({ id: 't1', title: 'Pay rent', due: '2026-09-25T00:00:00Z', dueAllDay: true }))!

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }
}

/**
 * A 100 px day cell at `left`; jsdom lays nothing out, so the cells report their rects
 * themselves. Hatches like the real views' day cells while a bounded series is dragged (FR-17).
 */
function Day({ day, left, children }: { day: Date; left: number; children?: ReactNode }) {
  const { moveWindow } = useDndState()
  const { setNodeRef } = useDroppable({ id: `day:${day.getDate()}`, data: { type: 'day', day } satisfies DropData })
  const hatched = moveWindow != null && outsideWindow(moveWindow, day)
  return (
    <div ref={setNodeRef} data-left={left} data-testid={`day:${day.getDate()}`} className={hatched ? 'hatched' : undefined}>
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

/** An event of a daily series, on 2026-09-`day` 10:00-11:00 in Berlin. */
function standup(day: number): CalEvent {
  const start = `2026-09-${day}T08:00:00Z`
  return toCalEvent(
    apiEvent({
      title: 'Standup',
      key: `e1@${start}`,
      start,
      end: `2026-09-${day}T09:00:00Z`,
      recurring: true,
      rrule: 'FREQ=DAILY',
      recurrenceId: start,
    }),
  )
}

/**
 * Renders `events` in a week of day cells from 09-25 (or `days`), and `more` after them, with
 * the calendars loaded as in the app.
 */
function renderWeek(events: CalEvent[], days = [25, 26, 27].map((d) => new Date(2026, 8, d)), more?: ReactNode) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.left ? rect(Number(this.dataset.left), 0, 100, 100) : rect(10, 40, 80, 20)
  })
  api.setCsrfToken('tok')
  const result = renderWithProviders(
    <CalendarDnd renderOverlay={() => null}>
      <Week days={days} events={events} />
      {more}
    </CalendarDnd>,
  )
  result.queryClient.setQueryData(queryKeys.calendars, [calendar()])
  return result
}

/** The chip named `name` in the day cell of the `day`th. */
function chipIn(day: number, name: string): HTMLElement {
  return within(screen.getByTestId(`day:${day}`)).getByRole('button', { name })
}

/**
 * Renders `event` as a block in Friday's (09-25) column of the time grid, with `children`
 * (a resize handle) in it, and the calendars loaded as in the app.
 */
function renderBlock(event: CalEvent, children?: ReactNode) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.left ? rect(Number(this.dataset.left), 0, 100, 1152) : rect(10, 480, 80, 46)
  })
  const fri = new Date(2026, 8, 25)
  const result = renderWithProviders(
    <CalendarDnd renderOverlay={() => null}>
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
  )
  result.queryClient.setQueryData(queryKeys.calendars, [calendar()])
  return result
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
      const { queryClient } = renderWithProviders(
        // The views' overlay: the dragged event's own tile, which can't be dragged itself.
        <CalendarDnd
          renderOverlay={(d) =>
            d.event.kind === 'event' && <EventChip event={d.event} colors={colors} prefs={prefs} drag={{ id: 'overlay', data: d, disabled: true }} />
          }
        >
          <Week days={days} events={[standup(25)]} full={full} />
        </CalendarDnd>,
      )
      queryClient.setQueryData(queryKeys.calendars, [calendar()])

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

      await user.tab({ shift: true })
      expect(screen.getByRole('button', { name: 'All events' })).toHaveFocus()
      expect(chipIn(26, standupAt10)).toHaveClass('ring-2')
      expect(chipIn(27, standupAt10)).toHaveClass('ring-2')

      await user.tab()
      expect(chipIn(27, standupAt10)).not.toHaveClass('ring-2')
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

    it('offers only this event when a series on fixed days moves to another day', async () => {
      vi.spyOn(globalThis, 'fetch')
      const monthly = toCalEvent(
        apiEvent({
          title: 'Rent',
          key: 'e1@2026-10-09T08:00:00Z',
          start: '2026-10-09T08:00:00Z',
          end: '2026-10-09T09:00:00Z',
          recurring: true,
          rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
          recurrenceId: '2026-10-09T08:00:00Z',
        }),
      )
      renderWeek([monthly], [9, 10, 11].map((d) => new Date(2026, 9, d)))

      await moveRight(chipIn(9, 'Rent, 10 AM'))
      const question = await screen.findByRole('alertdialog', { name: moveQuestion })

      expect(within(question).queryByRole('button', { name: 'All events' })).toBeNull()
      expect(question).toHaveAccessibleDescription('The series stays on its days. Only this event can move to another day.')
      fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
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

      expect(
        await screen.findByRole('alertdialog', { name: 'This event repeats. Which events should change?' }),
      ).toBeInTheDocument()
      // Nothing else can be dragged meanwhile, the length included (FR-17).
      expect(screen.queryByRole('button', { name: 'Change end time' })).toBeNull()
      fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    })
  })

  describe('the move window of a bounded series (FR-17)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    /**
     * Renders a fixed-day series due 10-05 (next occurrence due 10-08, so its window is
     * [10-05, 10-08)) draggable across day cells 10-05..10-09, and picks it up with the
     * keyboard. Callers move it and finish the drag themselves.
     */
    async function pickUpBounded() {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 9, 5, 12))
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return this.dataset.left ? rect(Number(this.dataset.left), 0, 100, 100) : rect(10, 40, 80, 20)
      })
      const bounded = toCalTask(
        todo({
          id: 't2',
          title: 'Water the flowers',
          due: '2026-10-05T00:00:00Z',
          dueAllDay: true,
          recurring: true,
          fixedDays: true,
          next: { due: '2026-10-08T00:00:00Z' },
          moveWindow: { from: '2026-10-05T00:00:00Z', until: '2026-10-08T00:00:00Z' },
        }),
      )!
      renderWithProviders(
        <CalendarDnd renderOverlay={() => null}>
          <Day day={new Date(2026, 9, 4)} left={-100} />
          <Day day={new Date(2026, 9, 5)} left={0}>
            <TaskChip
              task={bounded}
              colors={colors}
              prefs={prefs}
              readOnly={false}
              drag={{ id: 'chip', data: { type: 'event', event: bounded, originDay: new Date(2026, 9, 5) }, disabled: false }}
            />
          </Day>
          <Day day={new Date(2026, 9, 6)} left={100} />
          <Day day={new Date(2026, 9, 7)} left={200} />
          <Day day={new Date(2026, 9, 8)} left={300} />
          <Day day={new Date(2026, 9, 9)} left={400} />
        </CalendarDnd>,
      )

      const chip = screen.getByRole('button', { name: 'Water the flowers, all day' })
      chip.focus()
      fireEvent.keyDown(chip, { code: 'Space', key: ' ' })
      await act(() => new Promise((resolve) => setTimeout(resolve)))
      return chip
    }

    it('hatches the days past the next occurrence and announces the limit while over one', async () => {
      await pickUpBounded()

      expect(screen.getByTestId('day:9').className).toContain('hatched')
      expect(screen.getByTestId('day:6').className).not.toContain('hatched')

      for (let i = 0; i < 4; i++) {
        fireEvent.keyDown(document, { code: 'ArrowRight', key: 'ArrowRight' })
      }
      expect(screen.getByRole('status')).toHaveTextContent('Only possible until Wed, Oct 7.')

      fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
    })

    it('saves nothing and announces the limit when a keyboard drop completes on a blocked day', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch')
      await pickUpBounded()
      for (let i = 0; i < 4; i++) {
        fireEvent.keyDown(document, { code: 'ArrowRight', key: 'ArrowRight' })
      }
      // End, not cancel: completes the drop instead of abandoning it.
      fireEvent.keyDown(document, { code: 'Space', key: ' ' })

      expect(screen.getByRole('status')).toHaveTextContent('Only possible until Wed, Oct 7.')
      expect(fetch).not.toHaveBeenCalled()
    })

    it('hatches the day before the series and announces the lower limit while over it', async () => {
      await pickUpBounded()

      expect(screen.getByTestId('day:4').className).toContain('hatched')

      fireEvent.keyDown(document, { code: 'ArrowLeft', key: 'ArrowLeft' })
      expect(screen.getByRole('status')).toHaveTextContent('Only possible from Mon, Oct 5 on.')

      fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
    })
  })
})
