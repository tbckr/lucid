import { useDraggable, useDroppable } from '@dnd-kit/core'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { enUS } from 'date-fns/locale/en-US'
import { createRef, type ReactNode, type RefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskChip } from '@/components/tasks/TaskItems'
import { api } from '@/lib/api/client'
import { outsideWindow, toCalTask } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { type DragData, type DropData } from '@/lib/dnd'
import { type CalItem } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { previewOf } from '@/lib/quickCreate'
import { useUi } from '@/stores/ui'
import { bodyOf, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { CalendarDnd } from './CalendarDnd'
import { useDndState } from './dndState'

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
        }),
      )!
      renderWithProviders(
        <CalendarDnd renderOverlay={() => null}>
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
  })
})
