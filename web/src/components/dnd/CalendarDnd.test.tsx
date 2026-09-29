import { useDroppable } from '@dnd-kit/core'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { enUS } from 'date-fns/locale/en-US'
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskChip } from '@/components/tasks/TaskItems'
import { api } from '@/lib/api/client'
import { toCalTask } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { type DropData } from '@/lib/dnd'
import { type FormatPrefs } from '@/lib/format'
import { bodyOf, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { CalendarDnd } from './CalendarDnd'

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
    <div ref={setNodeRef} data-left={left}>
      {children}
    </div>
  )
}

/** Moves the task one day to the right with the keyboard (NFR-27). */
async function moveRight() {
  const title = screen.getByRole('button', { name: 'Pay rent, all day' })
  title.focus()
  fireEvent.keyDown(title, { code: 'Space', key: ' ' })
  // dnd-kit's sensor listens for keys only from a timer queued at the pick-up.
  await act(() => new Promise((resolve) => setTimeout(resolve)))
  fireEvent.keyDown(document, { code: 'ArrowRight', key: 'ArrowRight' })
  fireEvent.keyDown(document, { code: 'Space', key: ' ' })
}

describe('CalendarDnd', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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

    await moveRight()
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(urlOf(url)).toBe('/api/v1/todos/t1')
    expect(bodyOf(init)).toMatchObject({ due: '2026-09-26T00:00:00.000Z', dueAllDay: true })

    // A second drop while the first is on its way waits for it, instead of conflicting with it.
    await moveRight()
    release(jsonResponse(200, { ...rent.todo, due: '2026-09-26T00:00:00Z', etag: '"2"' }))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2)
    })
    expect(fetch.mock.calls[1]![1]?.headers).toMatchObject({ 'If-Match': '"2"' })
  })
})
