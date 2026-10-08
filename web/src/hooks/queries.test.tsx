import { QueryClient, QueryClientProvider, useMutationState, useQuery } from '@tanstack/react-query'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { type MouseEvent, type ReactNode } from 'react'
import { toast, type Action } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api/client'
import { endpoints, type EventList, type TodoList } from '@/lib/api/endpoints'
import { type RestoredTodo, type Todo, type UpdatedTodo } from '@/lib/api/schemas'
import { currentRepeat, type TaskRepeat } from '@/lib/calendarTasks'
import { toCalEvent, type CalEvent } from '@/lib/events'
import { taskGlyphSlots } from '@/lib/scope'
import { todoToInput } from '@/lib/tasks'
import { apiEvent, bodyOf, calendar, jsonResponse, occurrence, todo, urlOf } from '@/test/fixtures'
import { defaultSettings, useSettings } from '@/stores/settings'
import {
  MOVE_EVENT_KEY,
  queryKeys,
  useCalendarTasks,
  useDeleteEvent,
  useDeleteFollowing,
  useDeleteOccurrence,
  useDeleteTodo,
  useDeleteTodos,
  useDetachTodo,
  useEndTodo,
  useMoveEvent,
  useMoveFollowing,
  useMoveOccurrence,
  usePendingSeries,
  useSkipTodo,
  useTodoFollowing,
  useTodos,
  useUpdateEvent,
  useUpdateFollowing,
  useUpdateOccurrence,
  useUpdateTodo,
  type MoveVars,
} from './queries'

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

afterEach(() => {
  useSettings.setState(defaultSettings)
  // Sonner keeps its toasts in module state, and without a Toaster none ever closes: a write of
  // the next test would find this test's toast of its series.
  toast.dismiss()
})

/** The color of calendar `c1`, which the toast after a change of a series takes (FR-17). */
const CALENDAR_COLOR = '#0e9f6e'

/** A client with calendar `c1` loaded, as the calendar page has it: event writes take its colors. */
function eventClient(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.calendars, [calendar({ id: 'c1', color: CALENDAR_COLOR })])
  return queryClient
}

/** The current action of the live toast `series:<id>`, sonner's own state (A-26 dedup). */
function seriesToastAction(id: string): Action | undefined {
  const entry = toast.getToasts().find((x) => x.id === `series:${id}`)
  if (!entry || !('action' in entry)) return undefined
  return entry.action as Action | undefined
}

/** The fill of each dot of a toast's reach icon, from left to right ('none' for a ring). */
function dotsOf(icon: ReactNode): (string | null)[] {
  const { container } = render(<>{icon}</>)
  return [...container.querySelectorAll('svg circle')].map((c) => c.getAttribute('fill'))
}

/** Each place of a toast's reach icon from left to right: '✓' for a done repeat, else the dot's fill ('none' for a ring). */
function marksOf(icon: ReactNode): (string | null)[] {
  const { container } = render(<>{icon}</>)
  return [...container.querySelectorAll('svg > *')].map((m) => (m.tagName === 'path' ? '✓' : m.getAttribute('fill')))
}

/** The toast `toast.success` showed with `message`: its ID, how long it stays, and its action. */
function toastOf(calls: Parameters<typeof toast.success>[], message: string) {
  const options = calls.find(([m]) => m === message)?.[1]
  const action = options?.action as Action | undefined
  return {
    id: options?.id,
    duration: options?.duration,
    icon: options?.icon,
    action: action?.label,
    click: () => {
      action?.onClick({} as MouseEvent<HTMLButtonElement>)
    },
  }
}

describe('useTodos', () => {
  it('keeps the tasks of calendars hidden in the sidebar', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = urlOf(input)
      if (url.endsWith('/calendars')) {
        return Promise.resolve(
          jsonResponse(200, {
            calendars: [calendar({ id: 'a', name: 'Personal' }), calendar({ id: 'b', name: 'Work' })],
          }),
        )
      }
      const id = url.includes('/calendars/a/') ? 'a' : 'b'
      return Promise.resolve(jsonResponse(200, { todos: [todo({ id: `t-${id}`, calendarId: id })], corrupted: [] }))
    })
    useSettings.getState().toggleCalendar('b')

    const { result } = renderHook(() => useTodos(), { wrapper })

    await waitFor(() => {
      expect(result.current.groups.map((g) => g.todos.map((x) => x.id))).toEqual([['t-a'], ['t-b']])
    })
  })
})

describe('useCalendarTasks', () => {
  it('skips calendars hidden in the sidebar', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = urlOf(input)
      if (url.endsWith('/calendars')) {
        return Promise.resolve(jsonResponse(200, { calendars: [calendar({ id: 'a' }), calendar({ id: 'b' })] }))
      }
      const id = url.includes('/calendars/a/') ? 'a' : 'b'
      const due = '2026-09-25T08:00:00Z'
      return Promise.resolve(jsonResponse(200, { todos: [todo({ id: `t-${id}`, calendarId: id, due })], corrupted: [] }))
    })
    useSettings.getState().toggleCalendar('b')
    const range = { start: new Date(2026, 8, 20), end: new Date(2026, 8, 27) }

    const { result } = renderHook(() => useCalendarTasks(range), { wrapper })

    await waitFor(() => {
      expect(result.current.tasks.map((x) => x.key)).toEqual(['task:t-a'])
    })
  })

  it('keeps tasks within the range of todo calendars only', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = urlOf(input)
      if (url.endsWith('/calendars')) {
        return Promise.resolve(
          jsonResponse(200, { calendars: [calendar({ id: 'a' }), calendar({ id: 'e', supportsTodos: false })] }),
        )
      }
      const todos = [
        todo({ id: 'in', calendarId: 'a', due: '2026-09-25T08:00:00Z' }),
        todo({ id: 'later', calendarId: 'a', due: '2026-10-10T08:00:00Z' }),
        todo({ id: 'undated', calendarId: 'a' }),
      ]
      return Promise.resolve(jsonResponse(200, { todos, corrupted: [] }))
    })
    const range = { start: new Date(2026, 8, 20), end: new Date(2026, 8, 27) }

    const { result } = renderHook(() => useCalendarTasks(range), { wrapper })

    await waitFor(() => {
      expect(result.current.tasks.map((x) => x.key)).toEqual(['task:in'])
    })
    expect(fetch.mock.calls.map(([u]) => urlOf(u))).not.toContain('/api/v1/calendars/e/todos')
  })

  describe('completed tasks', () => {
    function serveTodos() {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        if (urlOf(input).endsWith('/calendars')) {
          return Promise.resolve(jsonResponse(200, { calendars: [calendar({ id: 'a' })] }))
        }
        const due = '2026-09-25T08:00:00Z'
        const todos = [
          todo({ id: 'open', calendarId: 'a', due }),
          todo({ id: 'done', calendarId: 'a', due, status: 'COMPLETED' }),
          todo({ id: 'cancelled', calendarId: 'a', due, status: 'CANCELLED' }),
        ]
        return Promise.resolve(jsonResponse(200, { todos, corrupted: [] }))
      })
    }
    const range = { start: new Date(2026, 8, 20), end: new Date(2026, 8, 27) }

    it('are shown by default', async () => {
      serveTodos()

      const { result } = renderHook(() => useCalendarTasks(range), { wrapper })

      await waitFor(() => {
        expect(result.current.tasks.map((x) => x.key)).toEqual(['task:open', 'task:done', 'task:cancelled'])
      })
    })

    it('are hidden, like cancelled ones, when the setting is on', async () => {
      serveTodos()
      useSettings.setState({ hideCompletedInCalendar: true })

      const { result } = renderHook(() => useCalendarTasks(range), { wrapper })

      await waitFor(() => {
        expect(result.current.tasks.map((x) => x.key)).toEqual(['task:open'])
      })
    })
  })

  describe('recurring tasks', () => {
    const range = { start: new Date(2026, 8, 21), end: new Date(2026, 8, 28) }
    const day = (d: string) => `2026-09-${d}T00:00:00Z`
    const single = todo({ id: 't1', calendarId: 'a', due: day('25'), dueAllDay: true })
    const series = todo({
      id: 't2',
      calendarId: 'a',
      title: 'Water the flowers',
      due: day('24'),
      dueAllDay: true,
      rrule: 'FREQ=DAILY;INTERVAL=2',
      recurring: true,
      next: { due: day('26') },
    })
    const repeat = (d: string, state: 'current' | 'upcoming' | 'done') =>
      occurrence({ key: `t2@${day(d)}`, todoId: 't2', calendarId: 'a', recurrenceId: day(d), due: day(d), state })

    /** One todo calendar with `single` and `series`, whose occurrences `occurrences` answers. */
    function serve(occurrences: () => Response) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = urlOf(input)
        if (url.endsWith('/calendars')) {
          return Promise.resolve(jsonResponse(200, { calendars: [calendar({ id: 'a' })] }))
        }
        if (url.includes('/todos/occurrences?')) return Promise.resolve(occurrences())
        return Promise.resolve(jsonResponse(200, { todos: [single, series], corrupted: [] }))
      })
    }

    it('places a series by its occurrences, between the single tasks', async () => {
      const fetch = serve(() =>
        jsonResponse(200, { occurrences: [repeat('24', 'current'), repeat('26', 'upcoming'), { todoId: 't2' }] }),
      )

      const { result } = renderHook(() => useCalendarTasks(range), { wrapper })

      await waitFor(() => {
        expect(result.current.tasks.map((x) => x.key)).toEqual([`t2@${day('24')}`, 'task:t1', `t2@${day('26')}`])
      })
      // The list's own entry of the series is not placed a second time.
      expect(result.current.tasks.map((x) => x.key)).not.toContain('task:t2')
      const [current, , upcoming] = result.current.tasks
      expect(current?.todo).toEqual(series)
      expect(current?.occurrence?.state).toBe('current')
      expect(upcoming?.occurrence?.state).toBe('upcoming')
      expect(result.current.corrupted.map((c) => c.calendarId)).toEqual(['a'])
      expect(result.current.errors).toEqual([])
      const url = fetch.mock.calls.map(([u]) => urlOf(u)).find((u) => u.includes('/occurrences?'))
      expect(url).toMatch(/^\/api\/v1\/calendars\/a\/todos\/occurrences\?start=.+&end=.+$/)
    })

    it('skips the occurrences of a series that is not loaded', async () => {
      const orphan = occurrence({ todoId: 'gone', calendarId: 'a' })
      serve(() => jsonResponse(200, { occurrences: [repeat('24', 'current'), orphan] }))

      const { result } = renderHook(() => useCalendarTasks(range), { wrapper })

      await waitFor(() => {
        expect(result.current.tasks.map((x) => x.key)).toEqual([`t2@${day('24')}`, 'task:t1'])
      })
    })

    it('hides occurrences done elsewhere when completed tasks are hidden', async () => {
      serve(() => jsonResponse(200, { occurrences: [repeat('22', 'done'), repeat('24', 'current')] }))
      useSettings.setState({ hideCompletedInCalendar: true })

      const { result } = renderHook(() => useCalendarTasks(range), { wrapper })

      await waitFor(() => {
        expect(result.current.tasks.map((x) => x.key)).toEqual([`t2@${day('24')}`, 'task:t1'])
      })
    })

    it('reports a failed load of the occurrences and still places the single tasks', async () => {
      serve(() => jsonResponse(500, { error: { code: 'internal', message: 'x' } }))

      const { result } = renderHook(() => useCalendarTasks(range), { wrapper })

      await waitFor(() => {
        expect(result.current.errors).toHaveLength(1)
      })
      await waitFor(() => {
        expect(result.current.tasks.map((x) => x.key)).toEqual(['task:t1'])
      })
    })
  })
})

describe('useMoveOccurrence', () => {
  const calendarId = 'c1'
  // Two occurrences of the same series: moving one must not touch the other, only its ETag once the server answers.
  const first = apiEvent({
    id: 'e1',
    key: 'e1@2025-03-03T08:00:00Z',
    etag: '"1"',
    recurring: true,
    recurrenceId: '2025-03-03T08:00:00Z',
  })
  const second = apiEvent({
    id: 'e1',
    key: 'e1@2025-03-10T08:00:00Z',
    etag: '"1"',
    recurring: true,
    recurrenceId: '2025-03-10T08:00:00Z',
  })

  /** A client holding `first` and `second`, and PUTs that answer only when told to. */
  function setup() {
    api.setCsrfToken('tok')
    const queryClient = eventClient()
    queryClient.setQueryData<EventList>(queryKeys.events(calendarId, 'r1', 'r2'), {
      events: [first, second],
      corrupted: [],
    })
    const answers: ((r: Response) => void)[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve)
        }),
    )
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const cached = () => queryClient.getQueryData<EventList>(queryKeys.events(calendarId, 'r1', 'r2'))?.events
    return { fetch, answers, wrap, cached }
  }

  it('moves one event of a series at once and gives its siblings the new ETag', async () => {
    const { fetch, answers, wrap, cached } = setup()
    const event = toCalEvent(second)
    const { result } = renderHook(() => useMoveOccurrence(), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event, start: '2025-03-10T09:00:00Z', end: '2025-03-10T10:00:00Z' })
    })
    await waitFor(() => {
      expect(cached()?.find((e) => e.key === second.key)?.start).toBe('2025-03-10T09:00:00Z')
    })
    expect(answers).toHaveLength(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(urlOf(url)).toBe('/api/v1/events/e1/occurrences/2025-03-10T08%3A00%3A00Z')
    expect(init?.method).toBe('PUT')
    expect((init?.headers as Record<string, string>)['If-Match']).toBe('"1"')

    answers[0]?.(
      jsonResponse(
        200,
        apiEvent({
          ...second,
          start: '2025-03-10T09:00:00Z',
          end: '2025-03-10T10:00:00Z',
          etag: '"2"',
          modified: true,
        }),
      ),
    )

    await waitFor(() => {
      expect(cached()?.map((e) => e.etag)).toEqual(['"2"', '"2"'])
    })
    expect(cached()?.find((e) => e.key === second.key)?.modified).toBe(true)
  })

  it('puts a failed move of one event back', async () => {
    const { answers, wrap, cached } = setup()
    const event = toCalEvent(second)
    const { result } = renderHook(() => useMoveOccurrence(), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event, start: '2025-03-10T09:00:00Z', end: '2025-03-10T10:00:00Z' })
    })
    await waitFor(() => {
      expect(cached()?.find((e) => e.key === second.key)?.start).toBe('2025-03-10T09:00:00Z')
    })

    answers[0]?.(jsonResponse(409, { error: { code: 'conflict', message: 'x' } }))

    await waitFor(() => {
      expect(cached()?.find((e) => e.key === second.key)?.start).toBe(second.start)
    })
    expect(cached()?.find((e) => e.key === first.key)?.etag).toBe('"1"')
  })
})

describe('useDeleteOccurrence', () => {
  it('deletes one event of a series at once and keeps its siblings', async () => {
    api.setCsrfToken('tok')
    const calendarId = 'c1'
    const first = apiEvent({
      id: 'e1',
      key: 'e1@2025-03-03T08:00:00Z',
      etag: '"1"',
      recurring: true,
      recurrenceId: '2025-03-03T08:00:00Z',
    })
    const second = apiEvent({
      id: 'e1',
      key: 'e1@2025-03-10T08:00:00Z',
      etag: '"1"',
      recurring: true,
      recurrenceId: '2025-03-10T08:00:00Z',
    })
    const queryClient = eventClient()
    queryClient.setQueryData<EventList>(queryKeys.events(calendarId, 'r1', 'r2'), {
      events: [first, second],
      corrupted: [],
    })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useDeleteOccurrence(), { wrapper: wrap })

    act(() => {
      result.current.mutate(toCalEvent(second))
    })

    await waitFor(() => {
      expect(queryClient.getQueryData<EventList>(queryKeys.events(calendarId, 'r1', 'r2'))?.events).toEqual([first])
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(urlOf(url)).toBe('/api/v1/events/e1/occurrences/2025-03-10T08%3A00%3A00Z')
    expect(init?.method).toBe('DELETE')
    expect((init?.headers as Record<string, string>)['If-Match']).toBe('"1"')
  })

  it('gives the other events of the series the ETag the delete answered with', async () => {
    api.setCsrfToken('tok')
    const calendarId = 'c1'
    const first = apiEvent({
      id: 'e1',
      key: 'e1@2025-03-03T08:00:00Z',
      etag: '"1"',
      recurring: true,
      recurrenceId: '2025-03-03T08:00:00Z',
    })
    const second = apiEvent({ ...first, key: 'e1@2025-03-10T08:00:00Z', recurrenceId: '2025-03-10T08:00:00Z' })
    const other = apiEvent({ id: 'e2', key: 'e2', etag: '"9"' })
    const queryClient = eventClient()
    queryClient.setQueryData<EventList>(queryKeys.events(calendarId, 'r1', 'r2'), {
      events: [first, second, other],
      corrupted: [],
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { etag: '"2"' }))
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useDeleteOccurrence(), { wrapper: wrap })

    act(() => {
      result.current.mutate(toCalEvent(second))
    })

    await waitFor(() => {
      expect(queryClient.getQueryData<EventList>(queryKeys.events(calendarId, 'r1', 'r2'))?.events).toEqual([
        { ...first, etag: '"2"' },
        other,
      ])
    })
  })
})

/** The delete hooks of a series, for a test to pick one. */
interface Hooks {
  deleteOccurrence: ReturnType<typeof useDeleteOccurrence>
  deleteEvent: ReturnType<typeof useDeleteEvent>
}

// FR-17: all events of a series share one resource and so one ETag; "Only this event" is
// optimistic and locks none of the others, so writes of one series follow each other quickly.
describe('writes of one series', () => {
  const first = apiEvent({
    id: 'e1',
    key: 'e1@2025-03-03T08:00:00Z',
    etag: '"1"',
    recurring: true,
    rrule: 'FREQ=WEEKLY',
    recurrenceId: '2025-03-03T08:00:00Z',
  })
  const second = apiEvent({ ...first, key: 'e1@2025-03-10T08:00:00Z', recurrenceId: '2025-03-10T08:00:00Z' })
  const input = { title: 'Event', description: '', location: '', allDay: false, timezone: 'Europe/Berlin' }

  it.each([
    ['only this event', (h: Hooks) => h.deleteOccurrence],
    ['the whole series', (h: Hooks) => h.deleteEvent],
  ])('run one after another, each with the ETag the one before got, up to deleting %s', async (_, del) => {
    api.setCsrfToken('tok')
    const queryClient = eventClient()
    const answers: ((r: Response) => void)[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve)
        }),
    )
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(
      () => ({
        updateOccurrence: useUpdateOccurrence('e1'),
        updateEvent: useUpdateEvent('e1'),
        deleteOccurrence: useDeleteOccurrence('e1'),
        deleteEvent: useDeleteEvent('e1'),
      }),
      { wrapper: wrap },
    )
    const ifMatch = (i: number) => (fetch.mock.calls[i]?.[1]?.headers as Record<string, string>)['If-Match']

    // All three from the events as shown, with the ETag they were loaded with.
    act(() => {
      result.current.updateOccurrence.mutate({
        event: toCalEvent(first),
        input: { ...input, start: '2025-03-03T09:00:00Z', end: '2025-03-03T10:00:00Z' },
      })
      result.current.updateEvent.mutate({
        event: toCalEvent(second),
        input: {
          ...input,
          start: '2025-03-10T09:00:00Z',
          end: '2025-03-10T10:00:00Z',
          rrule: 'FREQ=WEEKLY',
          instanceStart: second.recurrenceId!,
        },
      })
      del(result.current).mutate(toCalEvent(second))
    })
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    expect(ifMatch(0)).toBe('"1"')

    answers[0]?.(jsonResponse(200, apiEvent({ ...first, start: '2025-03-03T09:00:00Z', etag: '"2"', modified: true })))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2)
    })
    expect(urlOf(fetch.mock.calls[1]![0])).toBe('/api/v1/events/e1')
    expect(ifMatch(1)).toBe('"2"')

    answers[1]?.(jsonResponse(200, apiEvent({ ...second, start: '2025-03-10T09:00:00Z', etag: '"3"' })))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(3)
    })
    expect(fetch.mock.calls[2]![1]?.method).toBe('DELETE')
    expect(ifMatch(2)).toBe('"3"')

    answers[2]?.(new Response(null, { status: 204 }))
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
  })

  it('run a write queued behind deleting one event with the ETag the delete answered with', async () => {
    api.setCsrfToken('tok')
    const queryClient = eventClient()
    const answers: ((r: Response) => void)[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve)
        }),
    )
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(
      () => ({ deleteOccurrence: useDeleteOccurrence('e1'), updateOccurrence: useUpdateOccurrence('e1') }),
      { wrapper: wrap },
    )
    const ifMatch = (i: number) => (fetch.mock.calls[i]?.[1]?.headers as Record<string, string>)['If-Match']

    // Both from the events as shown, with the ETag they were loaded with.
    act(() => {
      result.current.deleteOccurrence.mutate(toCalEvent(first))
      result.current.updateOccurrence.mutate({
        event: toCalEvent(second),
        input: { ...input, start: '2025-03-10T09:00:00Z', end: '2025-03-10T10:00:00Z' },
      })
    })
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    expect(fetch.mock.calls[0]![1]?.method).toBe('DELETE')
    expect(ifMatch(0)).toBe('"1"')

    answers[0]?.(jsonResponse(200, { etag: '"2"' }))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2)
    })
    expect(urlOf(fetch.mock.calls[1]![0])).toBe('/api/v1/events/e1/occurrences/2025-03-10T08%3A00%3A00Z')
    expect(ifMatch(1)).toBe('"2"')

    answers[1]?.(jsonResponse(200, apiEvent({ ...second, start: '2025-03-10T09:00:00Z', etag: '"3"', modified: true })))
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
  })
})

// FR-10, FR-17: a change of a series says which events it changed, with an Undo while the server
// handed out a token for it.
describe('event series toasts', () => {
  const key = queryKeys.events('c1', 'r1', 'r2')
  const first = apiEvent({
    id: 'e1',
    key: 'e1@2025-03-03T08:00:00Z',
    etag: '"1"',
    recurring: true,
    rrule: 'FREQ=WEEKLY',
    recurrenceId: '2025-03-03T08:00:00Z',
  })
  const second = apiEvent({ ...first, key: 'e1@2025-03-10T08:00:00Z', recurrenceId: '2025-03-10T08:00:00Z' })
  const single = apiEvent({ id: 'e2', key: 'e2', etag: '"5"' })
  const to = { start: '2025-03-10T09:00:00Z', end: '2025-03-10T10:00:00Z' }
  const input = { title: 'Event', description: '', location: '', allDay: false, timezone: 'Europe/Berlin', ...to }
  /** The server's answer to a write of the series: its new ETag, and the token to undo the write. */
  const answer = (etag: string, undoToken?: string) =>
    jsonResponse(200, apiEvent({ ...second, ...to, etag, modified: true, ...(undoToken ? { undoToken } : {}) }))

  /** A client holding the events, and a server answering each request with the next of `answers`. */
  function setup(...answers: (Response | Promise<Response>)[]) {
    api.setCsrfToken('tok')
    const queryClient = eventClient()
    queryClient.setQueryData<EventList>(key, { events: [first, second, single], corrupted: [] })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const next = answers.shift()
      return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected request'))
    })
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const writes = () =>
      fetch.mock.calls.map(([url, init]) => ({
        request: `${init?.method} ${urlOf(url)}`,
        etag: (init?.headers as Record<string, string>)['If-Match'],
        body: bodyOf(init),
      }))
    return { queryClient, wrap, writes }
  }

  it('says only this event moved, with an undo', async () => {
    const success = vi.spyOn(toast, 'success')
    const { queryClient, wrap, writes } = setup(answer('"2"', 'tok'), jsonResponse(200, { etag: '"3"' }))
    const { result } = renderHook(() => useMoveOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'Only this event moved.')
    expect(shown).toMatchObject({ id: 'series:e1', duration: 8000, action: 'Undo' })
    // The reload the change itself asked for is done: only the undo's is left to see.
    queryClient.setQueryData<EventList>(key, { events: [first, second, single], corrupted: [] })
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false)

    act(shown.click)
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith('Undone.')
    })
    expect(writes().map((w) => w.request)).toEqual([
      'PUT /api/v1/events/e1/occurrences/2025-03-10T08%3A00%3A00Z',
      'POST /api/v1/events/e1/undo',
    ])
    expect(writes()[1]?.body).toEqual({ token: 'tok' })
    await waitFor(() => {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    })
  })

  it('shows the reach of the change as the toast icon', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(answer('"2"', 'tok'))
    const { result } = renderHook(() => useMoveOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    // Five dots, only the middle one filled: the event moved, in the color of its calendar.
    expect(dotsOf(toastOf(success.mock.calls, 'Only this event moved.').icon)).toEqual([
      'none',
      'none',
      CALENDAR_COLOR,
      'none',
      'none',
    ])
  })

  it('says only this event changed after a resize', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(answer('"2"', 'tok'))
    const { result } = renderHook(() => useMoveOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to, change: true })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(toastOf(success.mock.calls, 'Only this event changed.')).toMatchObject({
      id: 'series:e1',
      duration: 8000,
      action: 'Undo',
    })
    expect(success).toHaveBeenCalledTimes(1)
  })

  it('says all events moved', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(answer('"2"', 'tok'))
    const { result } = renderHook(() => useMoveEvent('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'All events moved.')
    expect(shown).toMatchObject({ id: 'series:e1', duration: 8000, action: 'Undo' })
    expect(success).toHaveBeenCalledTimes(1)
    // Every dot filled: all events moved.
    expect(dotsOf(shown.icon)).toEqual(Array<string>(5).fill(CALENDAR_COLOR))
  })

  it('says all events changed after a resize', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(answer('"2"', 'tok'))
    const { result } = renderHook(() => useMoveEvent('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to, change: true })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(toastOf(success.mock.calls, 'All events changed.')).toMatchObject({ id: 'series:e1', action: 'Undo' })
  })

  it('shows nothing after moving a single event', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(jsonResponse(200, apiEvent({ ...single, ...to, etag: '"6"' })))
    const { result } = renderHook(() => useMoveEvent(), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(single), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(success).not.toHaveBeenCalled()
  })

  it('says all events changed', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(answer('"2"', 'tok'))
    const { result } = renderHook(() => useUpdateEvent('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({
        event: toCalEvent(second),
        input: { ...input, rrule: 'FREQ=WEEKLY', instanceStart: second.recurrenceId! },
      })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'All events changed.')
    expect(shown).toMatchObject({ id: 'series:e1', duration: 8000, action: 'Undo' })
    expect(success).not.toHaveBeenCalledWith('Event saved')
    expect(dotsOf(shown.icon)).toEqual(Array<string>(5).fill(CALENDAR_COLOR))
  })

  // Red only where the change deletes the other events (spec §2), as the server decides: saved
  // without a rule, a series that had one, or whose all-day flag changes, becomes this one event.
  // A series of dates alone (RDATE, no rule) saved as it was keeps them all.
  it.each([
    { change: 'a changed rule', rrule: 'FREQ=WEEKLY', saved: { rrule: 'FREQ=DAILY' }, red: false },
    { change: 'a removed rule', rrule: 'FREQ=WEEKLY', saved: { rrule: '' }, red: true },
    { change: 'the all-day flag beside a rule', rrule: 'FREQ=WEEKLY', saved: { rrule: 'FREQ=WEEKLY', allDay: true }, red: false },
    { change: 'nothing of a series of dates alone', rrule: '', saved: { rrule: '' }, red: false },
    { change: 'the all-day flag of a series of dates alone', rrule: '', saved: { rrule: '', allDay: true }, red: true },
  ])('draws the reach of $change in red: $red', async ({ rrule, saved, red }) => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(answer('"2"', 'tok'))
    const { result } = renderHook(() => useUpdateEvent('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({
        event: toCalEvent({ ...second, rrule }),
        input: { ...input, ...saved, instanceStart: second.recurrenceId! },
      })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'All events changed.')
    expect(shown).toMatchObject({ id: 'series:e1', action: 'Undo' })
    expect(dotsOf(shown.icon)).toEqual(Array<string>(5).fill(red ? 'var(--destructive)' : CALENDAR_COLOR))
  })

  it('says a single event was saved', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(jsonResponse(200, apiEvent({ ...single, ...to, etag: '"6"' })))
    const { result } = renderHook(() => useUpdateEvent(), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(single), input: { ...input, rrule: '' } })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(success).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledWith('Event saved')
  })

  it('says only this event changed', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(answer('"2"', 'tok'))
    const { result } = renderHook(() => useUpdateOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), input })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(toastOf(success.mock.calls, 'Only this event changed.')).toMatchObject({
      id: 'series:e1',
      duration: 8000,
      action: 'Undo',
    })
    expect(success).not.toHaveBeenCalledWith('Event saved')
  })

  it('says only this event deleted, with an undo', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap, writes } = setup(jsonResponse(200, { etag: '"2"', undoToken: 'tok' }), jsonResponse(200, { etag: '"3"' }))
    const { result } = renderHook(() => useDeleteOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate(toCalEvent(second))
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'Only this event deleted.')
    expect(shown).toMatchObject({ id: 'series:e1', duration: 8000, action: 'Undo' })
    // The event deleted, in red, as the question that deleted it drew it.
    expect(dotsOf(shown.icon)).toEqual(['none', 'none', 'var(--destructive)', 'none', 'none'])

    act(shown.click)
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith('Undone.')
    })
    expect(writes()[1]).toMatchObject({ request: 'POST /api/v1/events/e1/undo', body: { token: 'tok' } })
  })

  it('offers no undo once the series is gone', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(new Response(null, { status: 204 }))
    const { result } = renderHook(() => useDeleteOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate(toCalEvent(second))
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'Only this event deleted.')
    expect(shown).toMatchObject({ id: 'series:e1', duration: 8000 })
    expect(shown.action).toBeUndefined()
  })

  it('offers no undo without a token, whatever the event it changed carried', async () => {
    const success = vi.spyOn(toast, 'success')
    // The server kept no snapshot (no ETag to restore against, or too big): the answer has no token.
    // The event as shown still carries the token of an earlier answer, which must not be offered.
    const { wrap } = setup(answer('"2"'))
    const { result } = renderHook(() => useMoveOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent({ ...second, undoToken: 'stale' }), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'Only this event moved.')
    expect(shown.duration).toBe(8000)
    expect(shown.action).toBeUndefined()
  })

  it('takes the undo of an earlier change away when the next one has none', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(answer('"2"', 'tok1'), answer('"3"'))
    const { result } = renderHook(() => useMoveOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(seriesToastAction('e1')?.label).toBe('Undo')

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    // The first change's toast, the same without its Undo as the second starts, the second's.
    await waitFor(() => {
      expect(success).toHaveBeenCalledTimes(3)
    })
    // Sonner merges a toast into the one of its ID: the earlier action stays unless it is overridden.
    expect(toast.getToasts().filter((x) => x.id === 'series:e1')).toHaveLength(1)
    expect(seriesToastAction('e1')).toBeUndefined()
  })

  it('replaces the undo toast of an earlier change of the series', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap, writes } = setup(
      answer('"2"', 'tok1'),
      answer('"3"', 'tok2'),
      jsonResponse(200, { etag: '"7"' }),
      answer('"8"', 'tok3'),
    )
    const { result } = renderHook(() => useMoveOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(success).toHaveBeenCalledTimes(3)
    })
    // One toast, whose Undo is the second change's: the first's went as the second started.
    const [one, taken, two] = success.mock.calls.map((call) => toastOf([call], 'Only this event moved.'))
    expect(one).toMatchObject({ id: 'series:e1', action: 'Undo' })
    expect(taken?.id).toBe('series:e1')
    expect(taken?.action).toBeUndefined()
    expect(two).toMatchObject({ id: 'series:e1', action: 'Undo' })
    expect(toast.getToasts().filter((x) => x.id === 'series:e1')).toHaveLength(1)

    act(() => {
      two?.click()
    })
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith('Undone.')
    })
    expect(writes().map((w) => w.etag)).toEqual(['"1"', '"2"', undefined])
    expect(writes()[2]).toMatchObject({ request: 'POST /api/v1/events/e1/undo', body: { token: 'tok2' } })

    // The next drag, of an event as it was loaded, writes on top of what the undo restored.
    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(4)
    })
    expect(writes()[3]?.etag).toBe('"7"')
  })

  // FR-17: a later write of the series makes the Undo of an earlier change fail (409), so only the
  // latest change keeps one. The earlier toast stays, without its Undo: dismissing it would take
  // the next toast of its ID away too, when that comes within sonner's two animation frames.
  it('takes the undo of an earlier change away once the series changes again', async () => {
    let answerSecond: (r: Response) => void = () => undefined
    const { wrap, writes } = setup(
      answer('"2"', 'tok1'),
      new Promise<Response>((resolve) => (answerSecond = resolve)),
      jsonResponse(200, { etag: '"4"' }),
    )
    const { result } = renderHook(() => useMoveOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(seriesToastAction('e1')?.label).toBe('Undo')
    })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    // While the second change is on its way, the first's toast says what it did, without Undo.
    const shown = toast.getToasts().find((x) => x.id === 'series:e1')
    expect(shown && 'title' in shown ? shown.title : undefined).toBe('Only this event moved.')
    expect(seriesToastAction('e1')).toBeUndefined()

    answerSecond(answer('"3"', 'tok2'))
    await waitFor(() => {
      expect(seriesToastAction('e1')?.label).toBe('Undo')
    })
    act(() => {
      seriesToastAction('e1')?.onClick({} as MouseEvent<HTMLButtonElement>)
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(3)
    })
    expect(writes()[2]).toMatchObject({ request: 'POST /api/v1/events/e1/undo', body: { token: 'tok2' } })
  })

  it('offers no undo for a change overtaken while it was saving', async () => {
    const success = vi.spyOn(toast, 'success')
    let answerFirst: (r: Response) => void = () => undefined
    let answerSecond: (r: Response) => void = () => undefined
    const { wrap, writes } = setup(
      new Promise<Response>((resolve) => (answerFirst = resolve)),
      new Promise<Response>((resolve) => (answerSecond = resolve)),
      jsonResponse(200, { etag: '"4"' }),
    )
    const { result } = renderHook(() => useMoveOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(1)
    })
    // The second change waits for the first, which then answers with a token.
    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    answerFirst(answer('"2"', 'tok1'))
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    const first = toastOf(success.mock.calls, 'Only this event moved.')
    expect(first.id).toBe('series:e1')
    expect(first.action).toBeUndefined()
    expect(toast.getToasts().some((x) => x.id === 'series:e1')).toBe(true)
    expect(seriesToastAction('e1')).toBeUndefined()

    answerSecond(answer('"3"', 'tok2'))
    await waitFor(() => {
      expect(seriesToastAction('e1')?.label).toBe('Undo')
    })
    act(() => {
      seriesToastAction('e1')?.onClick({} as MouseEvent<HTMLButtonElement>)
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(3)
    })
    expect(writes()[2]).toMatchObject({ request: 'POST /api/v1/events/e1/undo', body: { token: 'tok2' } })
  })

  it("runs an undo in the series' scope, after the writes ahead of it", async () => {
    const success = vi.spyOn(toast, 'success')
    let answerSecond: (r: Response) => void = () => undefined
    const { queryClient, wrap, writes } = setup(
      answer('"2"', 'tok1'),
      new Promise<Response>((resolve) => (answerSecond = resolve)),
      jsonResponse(200, { etag: '"4"' }),
    )
    const { result } = renderHook(() => useMoveOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const undo = toastOf(success.mock.calls, 'Only this event moved.')
    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })

    // The first change's Undo, called directly: the second change took it off the toast as it
    // started, so no one can click it now. What this pins is the order in the series' scope.
    act(undo.click)
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    // Queued behind the change still on its way, not sent beside it.
    expect(writes()).toHaveLength(2)
    expect(queryClient.isMutating()).toBe(2)

    answerSecond(answer('"3"', 'tok2'))
    await waitFor(() => {
      expect(writes()).toHaveLength(3)
    })
    expect(writes()[2]?.request).toBe('POST /api/v1/events/e1/undo')
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
  })

  // Every write of the series takes the earlier Undo away as it starts, also one that shows no
  // toast of its own (deleting the series, or moving it after it became a single event).
  describe('when another write of the series starts', () => {
    function useSeriesWrites() {
      return {
        moveEvent: useMoveEvent('e1'),
        moveOccurrence: useMoveOccurrence('e1'),
        updateEvent: useUpdateEvent('e1'),
        updateOccurrence: useUpdateOccurrence('e1'),
        deleteOccurrence: useDeleteOccurrence('e1'),
        deleteEvent: useDeleteEvent('e1'),
        moveFollowing: useMoveFollowing('e1'),
        updateFollowing: useUpdateFollowing('e1'),
        deleteFollowing: useDeleteFollowing('e1'),
      }
    }

    const starts: [string, (h: ReturnType<typeof useSeriesWrites>) => void][] = [
      ['moving all events', (h) => h.moveEvent.mutate({ event: toCalEvent(second), ...to })],
      ['moving a single event of it', (h) => h.moveEvent.mutate({ event: toCalEvent({ ...second, recurring: false }), ...to })],
      ['moving only this event', (h) => h.moveOccurrence.mutate({ event: toCalEvent(second), ...to })],
      [
        'changing all events',
        (h) => {
          h.updateEvent.mutate({
            event: toCalEvent(second),
            input: { ...input, rrule: 'FREQ=WEEKLY', instanceStart: second.recurrenceId! },
          })
        },
      ],
      ['changing only this event', (h) => h.updateOccurrence.mutate({ event: toCalEvent(second), input })],
      ['deleting only this event', (h) => h.deleteOccurrence.mutate(toCalEvent(second))],
      ['deleting the series', (h) => h.deleteEvent.mutate(toCalEvent(second))],
      ['moving this and the following events', (h) => h.moveFollowing.mutate({ event: toCalEvent(second), ...to })],
      [
        'changing this and the following events',
        (h) => {
          h.updateFollowing.mutate({ event: toCalEvent(second), input: { ...input, rrule: 'FREQ=WEEKLY' } })
        },
      ],
      ['deleting this and the following events', (h) => h.deleteFollowing.mutate(toCalEvent(second))],
    ]

    it.each(starts)('takes the undo of an earlier change away as soon as %s starts', async (_name, start) => {
      // The second write's answer never comes: the Undo is gone before it.
      const { wrap, writes } = setup(answer('"2"', 'tok1'), new Promise<Response>(() => undefined))
      const { result } = renderHook(useSeriesWrites, { wrapper: wrap })

      act(() => {
        result.current.moveOccurrence.mutate({ event: toCalEvent(second), ...to })
      })
      await waitFor(() => {
        expect(seriesToastAction('e1')?.label).toBe('Undo')
      })

      act(() => {
        start(result.current)
      })
      await waitFor(() => {
        expect(writes()).toHaveLength(2)
      })
      expect(toast.getToasts().some((x) => x.id === 'series:e1')).toBe(true)
      expect(seriesToastAction('e1')).toBeUndefined()
    })
  })

  it('queues a write behind a pending undo with the ETag the undo answered with', async () => {
    const success = vi.spyOn(toast, 'success')
    let answerUndo: (r: Response) => void = () => undefined
    const { queryClient, wrap, writes } = setup(
      answer('"2"', 'tok1'),
      new Promise<Response>((resolve) => (answerUndo = resolve)),
      answer('"8"', 'tok2'),
    )
    const { result } = renderHook(() => useMoveOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    act(toastOf(success.mock.calls, 'Only this event moved.').click)
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })

    // A drag of the event as it was loaded, while the undo is on its way: it waits for the undo.
    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(writes()).toHaveLength(2)

    answerUndo(jsonResponse(200, { etag: '"7"' }))
    await waitFor(() => {
      expect(writes()).toHaveLength(3)
    })
    // The queued PUT's If-Match; not where replaceEtag runs, which only TanStack's internals would show.
    expect(writes()[2]).toMatchObject({
      request: 'PUT /api/v1/events/e1/occurrences/2025-03-10T08%3A00%3A00Z',
      etag: '"7"',
    })
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
  })

  it('reports a gone undo', async () => {
    const success = vi.spyOn(toast, 'success')
    const error = vi.spyOn(toast, 'error')
    const { wrap } = setup(answer('"2"', 'tok'), jsonResponse(404, { error: { code: 'not_found', message: 'x' } }))
    const { result } = renderHook(() => useMoveOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    act(toastOf(success.mock.calls, 'Only this event moved.').click)

    await waitFor(() => {
      expect(error).toHaveBeenCalledWith('Nothing to undo anymore.')
    })
  })

  it('reports an undo conflict', async () => {
    const success = vi.spyOn(toast, 'success')
    const error = vi.spyOn(toast, 'error')
    const { queryClient, wrap } = setup(
      answer('"2"', 'tok'),
      jsonResponse(409, { error: { code: 'conflict', message: 'x' } }),
    )
    const { result } = renderHook(() => useMoveOccurrence('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(second), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    queryClient.setQueryData<EventList>(key, { events: [first, second, single], corrupted: [] })

    act(toastOf(success.mock.calls, 'Only this event moved.').click)
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Couldn't undo: the event was changed elsewhere in the meantime.")
    })
    expect(success).not.toHaveBeenCalledWith('Undone.')
    await waitFor(() => {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    })
  })
})

// FR-17: "This and following events" ends a series before an event, and a change of it goes on
// from there as a series of its own. Neither is optimistic: the series is reloaded afterwards.
describe('this and following events', () => {
  const key = queryKeys.events('c1', 'r1', 'r2')
  const first = apiEvent({
    id: 'e1',
    key: 'e1@2025-03-03T08:00:00Z',
    etag: '"1"',
    start: '2025-03-03T08:00:00Z',
    end: '2025-03-03T09:00:00Z',
    recurring: true,
    rrule: 'FREQ=WEEKLY',
    recurrenceId: '2025-03-03T08:00:00Z',
    first: true,
  })
  // Mon, Mar 17: the event the series is split at.
  const late = apiEvent({
    ...first,
    key: 'e1@2025-03-17T08:00:00Z',
    start: '2025-03-17T08:00:00Z',
    end: '2025-03-17T09:00:00Z',
    recurrenceId: '2025-03-17T08:00:00Z',
    first: false,
  })
  const to = { start: '2025-03-17T10:00:00Z', end: '2025-03-17T11:00:00Z' }
  const input = { title: 'Event', description: '', location: '', allDay: false, timezone: 'Europe/Berlin', ...to }
  /** The answer to a split: the event in the new series `e9`, and the old series' new ETag. */
  const split = (etag: string, undoToken?: string) =>
    jsonResponse(200, {
      event: apiEvent({ ...late, ...to, id: 'e9', key: 'e9@2025-03-17T10:00:00Z', uid: 'u9', etag: '"n1"', first: true }),
      etag,
      ...(undoToken ? { undoToken } : {}),
    })
  /** The answer when the server changed the whole series, as it does at its first event. */
  const whole = (etag: string, undoToken?: string) =>
    jsonResponse(200, { event: apiEvent({ ...late, ...to, etag }), etag, ...(undoToken ? { undoToken } : {}) })
  const red = 'var(--destructive)'

  beforeEach(() => {
    // Only the date, so the toast leaves the year out: fake timers would stall the requests.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2025, 2, 10, 12))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A client holding the series, and a server answering each request with the next of `answers`. */
  function setup(...answers: (Response | Promise<Response>)[]) {
    api.setCsrfToken('tok')
    const queryClient = eventClient()
    queryClient.setQueryData<EventList>(key, { events: [first, late], corrupted: [] })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const next = answers.shift()
      return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected request'))
    })
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const writes = () =>
      fetch.mock.calls.map(([url, init]) => ({
        request: `${init?.method} ${urlOf(url)}`,
        etag: (init?.headers as Record<string, string>)['If-Match'],
        body: bodyOf(init),
      }))
    const cached = () => queryClient.getQueryData<EventList>(key)?.events
    return { queryClient, wrap, writes, cached }
  }

  it('splits a series from a moved event, and says from when', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap, writes } = setup(split('"2"', 'tok'))
    const { result } = renderHook(() => useMoveFollowing('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(late), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    // The event is named in the path: the body has no instanceStart.
    expect(writes()).toEqual([
      {
        request: 'PUT /api/v1/events/e1/following/2025-03-17T08%3A00%3A00Z',
        etag: '"1"',
        body: { ...input, rrule: 'FREQ=WEEKLY' },
      },
    ])
    const shown = toastOf(success.mock.calls, 'Moved from Mon, Mar 17 on, as a series of its own.')
    expect(shown).toMatchObject({ id: 'series:e1', duration: 8000, action: 'Undo' })
    // This event and the ones after it, in the color of its calendar.
    expect(dotsOf(shown.icon)).toEqual(['none', 'none', CALENDAR_COLOR, CALENDAR_COLOR, CALENDAR_COLOR])
  })

  it('says the series changed from when after a resize', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(split('"2"', 'tok'))
    const { result } = renderHook(() => useMoveFollowing('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(late), ...to, change: true })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(toastOf(success.mock.calls, 'Changed from Mon, Mar 17 on, as a series of its own.')).toMatchObject({
      id: 'series:e1',
      action: 'Undo',
    })
    expect(success).toHaveBeenCalledTimes(1)
  })

  it('marks a split busy as a move, until the server answers', async () => {
    let answerSplit: (r: Response) => void = () => undefined
    const { queryClient, wrap, cached } = setup(new Promise<Response>((resolve) => (answerSplit = resolve)))
    const { result } = renderHook(
      () => ({
        split: useMoveFollowing('e1'),
        // As `CalendarDnd` finds the tiles to show busy.
        moving: useMutationState({
          filters: { mutationKey: MOVE_EVENT_KEY, status: 'pending' },
          select: (m) => (m.state.variables as MoveVars | undefined)?.event.key,
        }),
      }),
      { wrapper: wrap },
    )

    act(() => {
      result.current.split.mutate({ event: toCalEvent(late), ...to })
    })
    await waitFor(() => {
      expect(result.current.moving).toEqual([late.key])
    })
    // Not optimistic: the event stays where it was until the series is reloaded.
    expect(cached()).toEqual([first, late])

    answerSplit(split('"2"', 'tok'))
    await waitFor(() => {
      expect(result.current.moving).toEqual([])
    })
    await waitFor(() => {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    })
  })

  it("queues a write behind a split with the old series' new ETag", async () => {
    let answerSplit: (r: Response) => void = () => undefined
    const { queryClient, wrap, writes } = setup(
      new Promise<Response>((resolve) => (answerSplit = resolve)),
      jsonResponse(200, apiEvent({ ...first, start: '2025-03-03T09:00:00Z', etag: '"10"', modified: true })),
    )
    const { result } = renderHook(
      () => ({ split: useMoveFollowing('e1'), occurrence: useMoveOccurrence('e1') }),
      { wrapper: wrap },
    )

    // Both from the events as shown, with the ETag they were loaded with.
    act(() => {
      result.current.split.mutate({ event: toCalEvent(late), ...to })
      result.current.occurrence.mutate({
        event: toCalEvent(first),
        start: '2025-03-03T09:00:00Z',
        end: '2025-03-03T10:00:00Z',
      })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(1)
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(writes()).toHaveLength(1)

    answerSplit(split('"9"', 'tok'))
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    expect(writes()[1]).toMatchObject({
      request: 'PUT /api/v1/events/e1/occurrences/2025-03-03T08%3A00%3A00Z',
      etag: '"9"',
    })
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
  })

  it('queues a write behind a split with the ETag it had when the server told no new one', async () => {
    const { queryClient, wrap, writes } = setup(
      split(''),
      jsonResponse(200, apiEvent({ ...first, start: '2025-03-03T09:00:00Z', etag: '"10"', modified: true })),
    )
    const { result } = renderHook(
      () => ({ split: useMoveFollowing('e1'), occurrence: useMoveOccurrence('e1') }),
      { wrapper: wrap },
    )

    act(() => {
      result.current.split.mutate({ event: toCalEvent(late), ...to })
      result.current.occurrence.mutate({
        event: toCalEvent(first),
        start: '2025-03-03T09:00:00Z',
        end: '2025-03-03T10:00:00Z',
      })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    // No new ETag to go on: the write keeps the one it had, and conflicts as after a change elsewhere.
    expect(writes()[1]?.etag).toBe('"1"')
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
  })

  // Final review, Important 1: a write that sends the series' rule, made from the view before a
  // split and queued behind it, would write the rule back as the view had it, without the end the
  // split gave the series. Run after the split's reload, it goes with the ETag it was read with.
  describe('a write of the rule queued behind a split', () => {
    // Mon, Mar 10: an event before the split, as the view showed it before.
    const mid = apiEvent({
      ...late,
      key: 'e1@2025-03-10T08:00:00Z',
      start: '2025-03-10T08:00:00Z',
      end: '2025-03-10T09:00:00Z',
      recurrenceId: '2025-03-10T08:00:00Z',
    })
    const moved = { start: '2025-03-10T09:00:00Z', end: '2025-03-10T10:00:00Z' }
    const conflict = () => jsonResponse(409, { error: { code: 'conflict', message: 'x' } })
    const writesOfRule = [
      {
        write: 'a move of all events',
        request: 'PUT /api/v1/events/e1',
        answer: () => jsonResponse(200, apiEvent({ ...mid, ...moved, etag: '"3"' })),
        useWrite: () => {
          const move = useMoveEvent('e1')
          return () => {
            move.mutate({ event: toCalEvent(mid), ...moved })
          }
        },
      },
      {
        write: 'the editor, all events',
        request: 'PUT /api/v1/events/e1',
        answer: () => jsonResponse(200, apiEvent({ ...mid, ...moved, etag: '"3"' })),
        useWrite: () => {
          const update = useUpdateEvent('e1')
          return () => {
            update.mutate({
              event: toCalEvent(mid),
              input: { ...input, ...moved, rrule: 'FREQ=WEEKLY', instanceStart: mid.recurrenceId! },
            })
          }
        },
      },
      {
        write: 'a move of the following events',
        request: 'PUT /api/v1/events/e1/following/2025-03-10T08%3A00%3A00Z',
        answer: () => split('"3"'),
        useWrite: () => {
          const move = useMoveFollowing('e1')
          return () => {
            move.mutate({ event: toCalEvent(mid), ...moved })
          }
        },
      },
      {
        write: 'the editor, the following events',
        request: 'PUT /api/v1/events/e1/following/2025-03-10T08%3A00%3A00Z',
        answer: () => split('"3"'),
        useWrite: () => {
          const update = useUpdateFollowing('e1')
          return () => {
            update.mutate({ event: toCalEvent(mid), input: { ...input, ...moved, rrule: 'FREQ=WEEKLY' } })
          }
        },
      },
    ]

    /**
     * Splits the series at `late` and, queued behind it, runs `write`, made from `mid` before the
     * split. The calendar, shown meanwhile, reloads the series after the split with `rule`. With
     * `older`, the list of a week shown a minute before, not reloaded since, holds the series with
     * that rule.
     */
    async function queueBehindSplit(rule: string, useWrite: () => () => void, answer: Response, older?: string) {
      const { queryClient, wrap, writes } = setup(split('"2"', 'tok'), answer)
      queryClient.setQueryData<EventList>(key, { events: [first, mid, late], corrupted: [] })
      if (older !== undefined) {
        queryClient.setQueryData<EventList>(
          queryKeys.events('c1', 'r0', 'r1'),
          { events: [{ ...first, rrule: older }], corrupted: [] },
          { updatedAt: Date.now() - 60_000 },
        )
      }
      // The old series after the split, with the ETag it gave: its events before Mar 17.
      const reloaded = (): EventList => ({
        events: [first, mid].map((e) => ({ ...e, rrule: rule, etag: '"2"' })),
        corrupted: [],
      })
      const { result } = renderHook(
        () => ({
          split: useMoveFollowing('e1'),
          write: useWrite(),
          shown: useQuery({ queryKey: key, queryFn: () => Promise.resolve(reloaded()), staleTime: Infinity }),
        }),
        { wrapper: wrap },
      )

      act(() => {
        result.current.split.mutate({ event: toCalEvent(late), ...to })
        result.current.write()
      })
      await waitFor(() => {
        expect(writes()).toHaveLength(2)
      })
      await waitFor(() => {
        expect(queryClient.isMutating()).toBe(0)
      })
      return writes()[1]
    }

    it.each(writesOfRule)(
      'goes with the ETag it was read with once the series has another rule: $write',
      async ({ request, useWrite }) => {
        const warning = vi.spyOn(toast, 'warning')
        const sent = await queueBehindSplit('FREQ=WEEKLY;UNTIL=20250317T075959Z', useWrite, conflict())

        // The series no longer has it: the server refuses the write as a conflict, which reloads.
        expect(sent).toMatchObject({ request, etag: '"1"' })
        expect(warning).toHaveBeenCalledWith('This item was changed elsewhere. Lucid reloaded the latest version.')
      },
    )

    it.each(writesOfRule)(
      "goes with the ETag the split gave while the series has the rule it was read with: $write",
      async ({ request, useWrite, answer }) => {
        const sent = await queueBehindSplit('FREQ=WEEKLY', useWrite, answer())

        expect(sent).toMatchObject({ request, etag: '"2"' })
      },
    )

    it('takes the rule from the newest list that holds the series', async () => {
      const [move] = writesOfRule
      const sent = await queueBehindSplit('FREQ=WEEKLY', move!.useWrite, move!.answer(), 'FREQ=DAILY')

      expect(sent).toMatchObject({ request: move!.request, etag: '"2"' })
    })
  })

  // Review Focus 5: "following" at what is the series' first event by now (a stale view) is "All".
  it.each([
    {
      write: 'a move',
      message: 'All events moved.',
      useWrite: () => {
        const move = useMoveFollowing('e1')
        return () => {
          move.mutate({ event: toCalEvent(late), ...to })
        }
      },
    },
    {
      write: 'the editor',
      message: 'All events changed.',
      useWrite: () => {
        const update = useUpdateFollowing('e1')
        return () => {
          update.mutate({ event: toCalEvent(late), input: { ...input, rrule: 'FREQ=WEEKLY' } })
        }
      },
    },
  ])('says all events changed when the server changed the whole series by $write', async ({ message, useWrite }) => {
    const success = vi.spyOn(toast, 'success')
    const { queryClient, wrap } = setup(whole('"2"', 'tok'))
    const { result } = renderHook(useWrite, { wrapper: wrap })

    act(result.current)
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
    const shown = toastOf(success.mock.calls, message)
    expect(shown).toMatchObject({ id: 'series:e1', duration: 8000, action: 'Undo' })
    expect(success).toHaveBeenCalledTimes(1)
    expect(dotsOf(shown.icon)).toEqual(Array<string>(5).fill(CALENDAR_COLOR))
  })

  it('splits a series from the editor, and says from when', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap, writes } = setup(split('"2"', 'tok'))
    const { result } = renderHook(() => useUpdateFollowing('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({
        event: toCalEvent(late),
        input: { ...input, rrule: 'FREQ=DAILY', instanceStart: late.recurrenceId! },
      })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(writes()).toEqual([
      {
        request: 'PUT /api/v1/events/e1/following/2025-03-17T08%3A00%3A00Z',
        etag: '"1"',
        body: { ...input, rrule: 'FREQ=DAILY' },
      },
    ])
    const shown = toastOf(success.mock.calls, 'Changed from Mon, Mar 17 on, as a series of its own.')
    expect(shown).toMatchObject({ id: 'series:e1', duration: 8000, action: 'Undo' })
    expect(dotsOf(shown.icon)).toEqual(['none', 'none', CALENDAR_COLOR, CALENDAR_COLOR, CALENDAR_COLOR])
  })

  it('ends a series from the editor in red when the rule is removed', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(split('"2"', 'tok'))
    const { result } = renderHook(() => useUpdateFollowing('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(late), input: { ...input, rrule: '' } })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'The series now ends before Mon, Mar 17.')
    expect(shown).toMatchObject({ id: 'series:e1', duration: 8000, action: 'Undo' })
    expect(dotsOf(shown.icon)).toEqual(['none', 'none', red, red, red])
  })

  it('ends a series before an event', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap, writes } = setup(jsonResponse(200, { etag: '"2"', undoToken: 'tok' }), jsonResponse(200, { etag: '"3"' }))
    const { result } = renderHook(() => useDeleteFollowing('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate(toCalEvent(late))
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(writes()[0]).toMatchObject({
      request: 'DELETE /api/v1/events/e1/following/2025-03-17T08%3A00%3A00Z',
      etag: '"1"',
    })
    const shown = toastOf(success.mock.calls, 'The series now ends before Mon, Mar 17.')
    expect(shown).toMatchObject({ id: 'series:e1', duration: 8000, action: 'Undo' })
    expect(dotsOf(shown.icon)).toEqual(['none', 'none', red, red, red])

    act(shown.click)
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith('Undone.')
    })
    expect(writes()[1]).toMatchObject({ request: 'POST /api/v1/events/e1/undo', body: { token: 'tok' } })
  })

  // P10: a 204 is either the series deleted (a stale first event) or kept with an ETag the server
  // didn't tell; either way, nothing to undo.
  it('says the series ended, without undo, when the server tells no ETag', async () => {
    const success = vi.spyOn(toast, 'success')
    const { wrap } = setup(new Response(null, { status: 204 }))
    const { result } = renderHook(() => useDeleteFollowing('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate(toCalEvent(late))
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'The series now ends before Mon, Mar 17.')
    expect(shown).toMatchObject({ id: 'series:e1', duration: 8000 })
    expect(shown.action).toBeUndefined()
    expect(dotsOf(shown.icon)).toEqual(['none', 'none', red, red, red])
    expect(success).not.toHaveBeenCalledWith('Event deleted')
  })

  // Final review, Minor 2: the server splits by recurrence ID, so an event moved on its own past
  // later ones takes them along; the toast names the day it reaches from, its recurrence date.
  it.each([
    {
      write: 'a move',
      answer: () => split('"2"', 'tok'),
      message: 'Moved from Mon, Mar 17 on, as a series of its own.',
      useWrite: () => {
        const move = useMoveFollowing('e1')
        return (event: CalEvent) => {
          move.mutate({ event, ...to })
        }
      },
    },
    {
      write: 'the editor removing the rule',
      answer: () => split('"2"', 'tok'),
      message: 'The series now ends before Mon, Mar 17.',
      useWrite: () => {
        const update = useUpdateFollowing('e1')
        return (event: CalEvent) => {
          update.mutate({ event, input: { ...input, rrule: '' } })
        }
      },
    },
    {
      write: 'a delete',
      answer: () => jsonResponse(200, { etag: '"2"', undoToken: 'tok' }),
      message: 'The series now ends before Mon, Mar 17.',
      useWrite: () => {
        const remove = useDeleteFollowing('e1')
        return (event: CalEvent) => {
          remove.mutate(event)
        }
      },
    },
  ])('names the recurrence date of an event moved on its own after it: $write', async ({ answer, message, useWrite }) => {
    const success = vi.spyOn(toast, 'success')
    const { queryClient, wrap } = setup(answer())
    const { result } = renderHook(useWrite, { wrapper: wrap })
    // Shown on Thursday, Mar 20, in place of Monday, Mar 17.
    const moved = toCalEvent({ ...late, start: '2025-03-20T08:00:00Z', end: '2025-03-20T09:00:00Z', modified: true })

    act(() => {
      result.current(moved)
    })
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
    expect(success.mock.calls.map(([m]) => m)).toEqual([message])
  })

  // Review Focus 4: the undo of a split deletes the new series only while no other app changed it.
  it('tells that the new series stays after an undo', async () => {
    const success = vi.spyOn(toast, 'success')
    const warning = vi.spyOn(toast, 'warning')
    const { wrap, writes } = setup(split('"2"', 'tok'), jsonResponse(200, { etag: '"3"', copyKept: true }))
    const { result } = renderHook(() => useMoveFollowing('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(late), ...to })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    act(toastOf(success.mock.calls, 'Moved from Mon, Mar 17 on, as a series of its own.').click)

    await waitFor(() => {
      expect(warning).toHaveBeenCalledWith('Undone. The new series was changed in another app and stays.')
    })
    expect(success).not.toHaveBeenCalledWith('Undone.')
    // Sent to the old series, the one the toast is about.
    expect(writes()[1]).toMatchObject({ request: 'POST /api/v1/events/e1/undo', body: { token: 'tok' } })
  })

  /** An event of the new series `e9` a split makes, Mon, Mar 24, the week after the one it starts at. */
  const ofNew = apiEvent({
    ...late,
    ...to,
    id: 'e9',
    key: 'e9@2025-03-24T10:00:00Z',
    uid: 'u9',
    etag: '"n1"',
    start: '2025-03-24T10:00:00Z',
    end: '2025-03-24T11:00:00Z',
    recurrenceId: '2025-03-24T10:00:00Z',
  })
  const ofNewMoved = { start: '2025-03-24T12:00:00Z', end: '2025-03-24T13:00:00Z' }

  // FR-17: the server refuses the undo of a split once the new series changed, as it would list
  // the events from the split on twice; a write of the new series takes the split's Undo away.
  it.each([
    {
      write: 'a move',
      message: 'Moved from Mon, Mar 17 on, as a series of its own.',
      useSplit: () => {
        const move = useMoveFollowing('e1')
        return () => {
          move.mutate({ event: toCalEvent(late), ...to })
        }
      },
    },
    {
      write: 'the editor',
      message: 'Changed from Mon, Mar 17 on, as a series of its own.',
      useSplit: () => {
        const update = useUpdateFollowing('e1')
        return () => {
          update.mutate({ event: toCalEvent(late), input: { ...input, rrule: 'FREQ=WEEKLY' } })
        }
      },
    },
  ])("takes the split's undo away once the new series changes: $write", async ({ message, useSplit }) => {
    const success = vi.spyOn(toast, 'success')
    let answerNew: (r: Response) => void = () => undefined
    const { queryClient, wrap, writes } = setup(
      split('"2"', 'tok'),
      new Promise<Response>((resolve) => (answerNew = resolve)),
    )
    const { result } = renderHook(() => ({ split: useSplit(), ofNew: useMoveOccurrence('e9') }), {
      wrapper: wrap,
    })

    act(() => {
      result.current.split()
    })
    await waitFor(() => {
      expect(seriesToastAction('e1')?.label).toBe('Undo')
    })
    expect(toastOf(success.mock.calls, message).action).toBe('Undo')

    act(() => {
      result.current.ofNew.mutate({ event: toCalEvent(ofNew), ...ofNewMoved })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    // While the write of the new series is on its way, the split's toast stays, without Undo.
    const shown = toast.getToasts().find((x) => x.id === 'series:e1')
    expect(shown && 'title' in shown ? shown.title : undefined).toBe(message)
    expect(seriesToastAction('e1')).toBeUndefined()

    answerNew(
      jsonResponse(200, apiEvent({ ...ofNew, ...ofNewMoved, etag: '"n2"', modified: true, undoToken: 'tok9' })),
    )
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
    expect(seriesToastAction('e1')).toBeUndefined()
    // The new series' own change keeps its Undo.
    expect(seriesToastAction('e9')?.label).toBe('Undo')
  })

  it('keeps a later undo of the old series when the new series changes after it', async () => {
    const earlier = { start: '2025-03-03T09:00:00Z', end: '2025-03-03T10:00:00Z' }
    const { queryClient, wrap, writes } = setup(
      split('"2"', 'tok'),
      jsonResponse(200, apiEvent({ ...first, ...earlier, etag: '"3"', modified: true, undoToken: 'tok2' })),
      jsonResponse(200, apiEvent({ ...ofNew, ...ofNewMoved, etag: '"n2"', modified: true })),
      jsonResponse(200, { etag: '"4"' }),
    )
    const { result } = renderHook(
      () => ({ split: useMoveFollowing('e1'), old: useMoveOccurrence('e1'), ofNew: useMoveOccurrence('e9') }),
      { wrapper: wrap },
    )

    act(() => {
      result.current.split.mutate({ event: toCalEvent(late), ...to })
    })
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
    act(() => {
      result.current.old.mutate({ event: toCalEvent(first), ...earlier })
    })
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
    act(() => {
      result.current.ofNew.mutate({ event: toCalEvent(ofNew), ...ofNewMoved })
    })
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
    expect(writes()).toHaveLength(3)

    expect(seriesToastAction('e1')?.label).toBe('Undo')
    act(() => {
      seriesToastAction('e1')?.onClick({} as MouseEvent<HTMLButtonElement>)
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(4)
    })
    expect(writes()[3]).toMatchObject({ request: 'POST /api/v1/events/e1/undo', body: { token: 'tok2' } })
  })

  it('reports a series that cannot be split', async () => {
    const error = vi.spyOn(toast, 'error')
    const { queryClient, wrap } = setup(
      jsonResponse(400, { error: { code: 'series_split_unsupported', message: 'x' } }),
    )
    const { result } = renderHook(() => useMoveFollowing('e1'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ event: toCalEvent(late), ...to })
    })
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("This series can't be split. Change only this one or all instead.")
    })
    await waitFor(() => {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    })
  })
})

describe('useUpdateTodo', () => {
  const old = todo({ id: 'x', calendarId: 'c1', etag: '"1"', title: 'Old' })

  /** A client holding `old`, and PUTs that answer only when told to. */
  function setup() {
    api.setCsrfToken('tok')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData<TodoList>(queryKeys.todos('c1'), { todos: [old], corrupted: [] })
    const answers: ((r: Response) => void)[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve)
        }),
    )
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const cached = () => queryClient.getQueryData<TodoList>(queryKeys.todos('c1'))?.todos[0]
    return { queryClient, fetch, answers, wrap, cached }
  }

  it('shows an update at once and takes it back when it fails', async () => {
    const { answers, wrap, cached } = setup()
    const { result } = renderHook(() => useUpdateTodo('x'), { wrapper: wrap })

    act(() => {
      result.current.mutate({ todo: old, input: todoToInput(old, { title: 'New' }) })
    })
    await waitFor(() => {
      expect(cached()?.title).toBe('New')
    })
    expect(answers).toHaveLength(1)

    answers[0]?.(jsonResponse(500, { error: { code: 'internal', message: 'x' } }))
    await waitFor(() => {
      expect(cached()?.title).toBe('Old')
    })
  })

  it('runs the updates of a task one after another, each with the ETag the one before got', async () => {
    const { fetch, answers, wrap, cached } = setup()
    // Two hooks, like the title field and the check of one row.
    const { result } = renderHook(() => ({ title: useUpdateTodo('x'), check: useUpdateTodo('x') }), { wrapper: wrap })

    act(() => {
      result.current.title.mutate({ todo: old, input: todoToInput(old, { title: 'New' }) })
    })
    // Computed while the first is in flight: from the task as shown, with its old ETag.
    await waitFor(() => {
      expect(cached()?.title).toBe('New')
    })
    const shown = cached()!
    act(() => {
      result.current.check.mutate({ todo: shown, input: todoToInput(shown, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(answers).toHaveLength(1)
    })
    answers[0]?.(jsonResponse(200, { ...old, title: 'New', etag: '"2"' }))

    await waitFor(() => {
      expect(answers).toHaveLength(2)
    })
    const [, init] = fetch.mock.calls[1]!
    expect((init?.headers as Record<string, string>)['If-Match']).toBe('"2"')
    expect(bodyOf(init)).toMatchObject({ title: 'New', status: 'COMPLETED' })
    answers[1]?.(jsonResponse(200, { ...old, title: 'New', status: 'COMPLETED', etag: '"3"' }))
    await waitFor(() => {
      expect(cached()).toMatchObject({ status: 'COMPLETED', etag: '"3"' })
    })
  })

  it('sends an ETag again that came back with a later update', async () => {
    const { fetch, answers, wrap } = setup()
    const { result } = renderHook(() => useUpdateTodo('x'), { wrapper: wrap })
    const put = async (from: Todo, title: string, answer: Todo) => {
      act(() => {
        result.current.mutate({ todo: from, input: todoToInput(from, { title }) })
      })
      await waitFor(() => {
        expect(answers).toHaveLength(fetch.mock.calls.length)
      })
      answers.at(-1)?.(jsonResponse(200, answer))
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
    }
    // Content-derived ETags: back to the old title, back to the old ETag.
    const renamed = { ...old, title: 'New', etag: '"2"' }
    await put(old, 'New', renamed)
    await put(renamed, 'Old', old)

    act(() => {
      result.current.mutate({ todo: old, input: todoToInput(old, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(3)
    })
    const [, init] = fetch.mock.calls[2]!
    expect((init?.headers as Record<string, string>)['If-Match']).toBe('"1"')
  })
})

describe('useUpdateTodo with a recurring task', () => {
  const series = todo({
    id: 't2',
    calendarId: 'c1',
    etag: '"1"',
    title: 'Water the flowers',
    due: '2026-10-05T00:00:00Z',
    dueAllDay: true,
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
    recurring: true,
    fixedDays: true,
    next: { due: '2026-10-08T00:00:00Z' },
  })
  const rolled = {
    ...series,
    etag: '"2"',
    due: '2026-10-08T00:00:00Z',
    next: { due: '2026-10-12T00:00:00Z' },
    undoToken: 'tok',
  }
  const copy = todo({
    id: 'copy1',
    calendarId: 'c1',
    uid: 'u-copy',
    etag: '"c"',
    title: 'Water the flowers',
    due: '2026-10-05T00:00:00Z',
    dueAllDay: true,
    status: 'COMPLETED',
    completed: '2026-10-05T10:00:00Z',
  })

  beforeEach(() => {
    // Only the date: fake timers would stall the requests.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 5, 12))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  type Answer = UpdatedTodo | RestoredTodo | Response

  interface SetupOptions {
    /** The series as the list shows it. */
    from?: Todo
  }

  /**
   * A client showing the task list with `from`, and a server that answers
   * each PUT (a series change) or POST .../undo with the next of `answers`
   * and keeps what it stored, so the reloads after a change show the
   * server's state. Undo is a single request: the server removes the
   * completed copy itself, unless the answer carries `copyKept`.
   */
  function setup(answers: (Answer | Promise<Answer>)[], { from = series }: SetupOptions = {}) {
    api.setCsrfToken('tok')
    const queryClient = eventClient()
    queryClient.setQueryData<TodoList>(queryKeys.todos('c1'), { todos: [from], corrupted: [] })
    let stored: Todo[] = [from]
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = urlOf(input)
      const undoing = url.endsWith('/undo')
      const id = (undoing ? url.slice(0, -'/undo'.length) : url).split('/').at(-1) ?? ''
      const mutating = init?.method === 'PUT' || (init?.method === 'POST' && undoing)
      if (!mutating) return jsonResponse(200, { todos: stored, corrupted: [] })
      const answer = await answers.shift()
      if (!answer) throw new Error(`unexpected ${init.method} of ${id}`)
      if (answer instanceof Response) return answer
      if (undoing) {
        const { copyKept, ...master } = answer as RestoredTodo
        stored = stored.filter((x) => x.id !== copy.id || copyKept).map((x) => (x.id === id ? master : x))
      } else {
        const { completedCopy, ...master } = answer as UpdatedTodo
        stored = [...stored.map((x) => (x.id === id ? master : x)), ...(completedCopy ? [completedCopy] : [])]
      }
      return jsonResponse(200, answer)
    })
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(
      () => {
        // The task list, reloaded like in the app.
        useQuery({
          queryKey: queryKeys.todos('c1'),
          queryFn: ({ signal }) => endpoints.listTodos('c1', signal),
          staleTime: Number.POSITIVE_INFINITY,
        })
        return useUpdateTodo('t2')
      },
      { wrapper: wrap },
    )
    const cached = () => queryClient.getQueryData<TodoList>(queryKeys.todos('c1'))?.todos
    const writes = () =>
      fetch.mock.calls.filter(([, init]) => init?.method !== 'GET').map(([url, init]) => ({
        request: `${init?.method} ${urlOf(url)}`,
        etag: (init?.headers as Record<string, string>)['If-Match'],
        body: bodyOf(init),
      }))
    return { queryClient, result, cached, writes }
  }

  it('completes a series without showing it done, and keeps the completed repeat', async () => {
    const success = vi.spyOn(toast, 'success')
    let answer: (a: Answer) => void = () => undefined
    const { result, cached, writes } = setup([new Promise<Answer>((resolve) => (answer = resolve))])

    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(1)
    })
    const [put] = writes()
    expect(put?.request).toBe('PUT /api/v1/todos/t2')
    expect(put?.etag).toBe('"1"')
    expect(put?.body.status).toBe('COMPLETED')
    expect(put?.body).not.toHaveProperty('rrule')
    // The series moves on to its next repeat: it is never shown done in the meantime.
    expect(cached()).toEqual([series])

    answer({ ...rolled, completedCopy: copy })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(cached()?.map((x) => [x.id, x.due, x.status])).toEqual([
      ['t2', '2026-10-08T00:00:00Z', 'NEEDS-ACTION'],
      ['copy1', '2026-10-05T00:00:00Z', 'COMPLETED'],
    ])
    expect(cached()?.[0]).not.toHaveProperty('completedCopy')
    expect(success).toHaveBeenCalledTimes(1)
    expect(toastOf(success.mock.calls, 'Done. Next up: Thu, Oct 8')).toMatchObject({ duration: 8000, action: 'Undo' })
  })

  it('reads the rolled occurrence as a day when a timed series turns all-day (A-04)', async () => {
    // The series itself is timed; completing it rolls to a current occurrence
    // that is now all-day (e.g. an override changed its value type). The
    // "Next up" toast reads the *rolled* todo's own flags directly
    // (`anchorOf(updated)`, not `.next`), so a near-midnight UTC due pins
    // that the day, not the time, decides the toast.
    const success = vi.spyOn(toast, 'success')
    const timed = todo({
      id: 't2',
      calendarId: 'c1',
      etag: '"1"',
      title: 'Water the flowers',
      due: '2026-10-05T07:00:00Z',
      rrule: 'FREQ=WEEKLY',
      recurring: true,
      next: { due: '2026-10-12T07:00:00Z' },
    })
    const rolledAllDay = {
      ...timed,
      etag: '"2"',
      due: '2026-10-08T23:30:00Z',
      dueAllDay: true,
      next: { due: '2026-10-15T07:00:00Z' },
      undoToken: 'tok',
    }
    const doneCopy = todo({
      id: 'copy2',
      calendarId: 'c1',
      uid: 'u-copy2',
      etag: '"c2"',
      title: 'Water the flowers',
      due: '2026-10-05T07:00:00Z',
      status: 'COMPLETED',
      completed: '2026-10-05T10:00:00Z',
    })
    const { result } = setup([{ ...rolledAllDay, completedCopy: doneCopy }], { from: timed })

    act(() => {
      result.current.mutate({ todo: timed, input: todoToInput(timed, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(toastOf(success.mock.calls, 'Done. Next up: Thu, Oct 8')).toMatchObject({ duration: 8000, action: 'Undo' })
  })

  it('warns and reloads when the series changed elsewhere, without an undo', async () => {
    const success = vi.spyOn(toast, 'success')
    const warning = vi.spyOn(toast, 'warning')
    const { queryClient, result, cached } = setup([jsonResponse(409, { error: { code: 'conflict', message: 'x' } })])
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
    expect(warning).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.todos('c1') })
    expect(success).not.toHaveBeenCalled()
    expect(cached()).toEqual([series])
  })

  it('says so when the last repeat is done', async () => {
    const success = vi.spyOn(toast, 'success')
    const last = { ...series, next: null }
    const done = {
      ...last,
      etag: '"2"',
      status: 'COMPLETED' as const,
      completed: '2026-10-05T10:00:00Z',
      undoToken: 'tok',
    }
    const { result, cached } = setup([done], { from: last })

    act(() => {
      result.current.mutate({ todo: last, input: todoToInput(last, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(toastOf(success.mock.calls, 'Done. That was the last repeat.')).toMatchObject({
      duration: 8000,
      action: 'Undo',
    })
    expect(cached()?.map((x) => [x.id, x.status])).toEqual([['t2', 'COMPLETED']])
  })

  it('tells where a moved series is and when it repeats, with an undo', async () => {
    const success = vi.spyOn(toast, 'success')
    let answerMove: (a: Answer) => void = () => undefined
    const { result, cached, writes } = setup([new Promise<Answer>((resolve) => (answerMove = resolve))])

    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { due: '2026-10-07T00:00:00.000Z' }) })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(1)
    })
    // A move shows at once.
    expect(cached()?.[0]?.due).toBe('2026-10-07T00:00:00.000Z')

    answerMove({ ...series, etag: '"2"', due: '2026-10-07T00:00:00Z', undoToken: 'tok' })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'Moved to Wed, Oct 7. Then: Thu, Oct 8')
    expect(shown).toMatchObject({ duration: 8000, action: 'Undo' })
    // No reach given, as for a task that asks nothing.
    expect(shown.icon).toBeUndefined()
  })

  it('tells the next repeat on its own day, not the moved occurrence value type (A-04)', async () => {
    // The series itself is timed; an override elsewhere turned the *next*
    // repeat all-day. The toast must read that from `next`, not from the
    // moved occurrence's own (still timed) flag, or a late UTC hour spills
    // into the wrong local day.
    const success = vi.spyOn(toast, 'success')
    const timed = todo({
      id: 't2',
      calendarId: 'c1',
      etag: '"1"',
      title: 'Call the vet',
      due: '2026-10-05T07:00:00Z',
      rrule: 'FREQ=WEEKLY',
      recurring: true,
      fixedDays: true,
      next: { due: '2026-10-08T07:00:00Z' },
    })
    const { result } = setup(
      [
        {
          ...timed,
          etag: '"2"',
          due: '2026-10-07T00:00:00.000Z',
          next: { due: '2026-10-08T23:30:00Z', dueAllDay: true },
          undoToken: 'tok',
        },
      ],
      { from: timed },
    )

    act(() => {
      result.current.mutate({ todo: timed, input: todoToInput(timed, { due: '2026-10-07T00:00:00.000Z' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(toastOf(success.mock.calls, 'Moved to Wed, Oct 7. Then: Thu, Oct 8')).toMatchObject({
      duration: 8000,
      action: 'Undo',
    })
  })

  it('says the whole series moved, and what is next up, when a later repeat was dragged', async () => {
    const success = vi.spyOn(toast, 'success')
    const weekly = { ...series, rrule: 'FREQ=WEEKLY', fixedDays: false, next: { due: '2026-10-12T00:00:00Z' } }
    const { result } = setup(
      [{ ...weekly, etag: '"2"', due: '2026-10-07T00:00:00Z', next: { due: '2026-10-14T00:00:00Z' }, undoToken: 'tok' }],
      { from: weekly },
    )

    act(() => {
      result.current.mutate({
        todo: weekly,
        input: todoToInput(weekly, { due: '2026-10-07T00:00:00.000Z' }),
        byUpcoming: true,
      })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(toastOf(success.mock.calls, 'Series moved. Next up: Wed, Oct 7')).toMatchObject({
      duration: 8000,
      action: 'Undo',
    })
  })

  it('tells where a series moved on its last repeat', async () => {
    const success = vi.spyOn(toast, 'success')
    const last = { ...series, next: null }
    const { result } = setup([{ ...last, etag: '"2"', due: '2026-10-07T00:00:00Z', undoToken: 'tok' }], {
      from: last,
    })

    act(() => {
      result.current.mutate({ todo: last, input: todoToInput(last, { due: '2026-10-07T00:00:00.000Z' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(toastOf(success.mock.calls, 'Moved to Wed, Oct 7.')).toMatchObject({ duration: 8000, action: 'Undo' })
  })

  it('offers no undo for a move that changes the rule, which undo could not restore', async () => {
    const success = vi.spyOn(toast, 'success')
    const { result } = setup([
      { ...series, etag: '"2"', due: '2026-10-07T00:00:00Z', rrule: 'FREQ=DAILY', fixedDays: false },
      { ...series, etag: '"3"', due: '2026-10-07T00:00:00Z', rrule: '', recurring: false, next: null },
    ])

    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { due: '2026-10-07T00:00:00.000Z', rrule: 'FREQ=DAILY' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { due: '2026-10-07T00:00:00.000Z', rrule: '' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
      expect(result.current.variables?.input.rrule).toBe('')
    })
    expect(success).not.toHaveBeenCalled()
  })

  it('tells about a move that sends the rule again, in whatever case', async () => {
    const success = vi.spyOn(toast, 'success')
    const { result } = setup([{ ...series, etag: '"2"', due: '2026-10-07T00:00:00Z', undoToken: 'tok' }])

    act(() => {
      const input = todoToInput(series, { due: '2026-10-07T00:00:00.000Z', rrule: 'freq=weekly;byday=mo,th' })
      result.current.mutate({ todo: series, input })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(toastOf(success.mock.calls, 'Moved to Wed, Oct 7. Then: Thu, Oct 8')).toMatchObject({ action: 'Undo' })
  })

  it('tells about a completion that also changes the rule', async () => {
    const success = vi.spyOn(toast, 'success')
    const { result } = setup([{ ...rolled, rrule: 'FREQ=DAILY', completedCopy: copy }])

    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { status: 'COMPLETED', rrule: 'FREQ=DAILY' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(toastOf(success.mock.calls, 'Done. Next up: Thu, Oct 8')).toMatchObject({ duration: 8000, action: 'Undo' })
  })

  // FR-17: "all repeats" changes the other fields of every open repeat too, which the toast says,
  // with the reach the question or the hint showed before.
  it('says all repeats changed after an edit of other fields, with an undo', async () => {
    const success = vi.spyOn(toast, 'success')
    const { result, writes } = setup([
      { ...series, etag: '"2"', title: 'Water the garden', undoToken: 'tok' },
      { ...series, etag: '"3"' },
    ])

    act(() => {
      // The editor writes the same dates in its own way.
      result.current.mutate({
        todo: series,
        input: todoToInput(series, { title: 'Water the garden', due: '2026-10-05T00:00:00.000Z' }),
        look: { slots: taskGlyphSlots('all', 'upcoming') },
      })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'All repeats changed.')
    expect(shown).toMatchObject({ id: 'series:t2', duration: 8000, action: 'Undo' })
    expect(marksOf(shown.icon)).toEqual(['✓', CALENDAR_COLOR, CALENDAR_COLOR, CALENDAR_COLOR, CALENDAR_COLOR])

    act(shown.click)
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith('Undone.')
    })
    expect(writes()[1]).toMatchObject({ request: 'POST /api/v1/todos/t2/undo', body: { token: 'tok' } })
  })

  it('draws the reach of a move it is given', async () => {
    const success = vi.spyOn(toast, 'success')
    const { result } = setup([{ ...series, etag: '"2"', due: '2026-10-07T00:00:00Z', undoToken: 'tok' }])

    act(() => {
      result.current.mutate({
        todo: series,
        input: todoToInput(series, { due: '2026-10-07T00:00:00.000Z' }),
        look: { slots: taskGlyphSlots('all', 'current') },
      })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'Moved to Wed, Oct 7. Then: Thu, Oct 8')
    expect(marksOf(shown.icon)).toEqual(['✓', '✓', CALENDAR_COLOR, CALENDAR_COLOR, CALENDAR_COLOR])
  })

  // The last repeat acts as a single task, which asks nothing and says nothing about an edit.
  it('says nothing about other edits of the last repeat', async () => {
    const success = vi.spyOn(toast, 'success')
    const last = { ...series, next: null }
    const { result } = setup([{ ...last, etag: '"2"', title: 'Water the garden', undoToken: 'tok' }], { from: last })

    act(() => {
      result.current.mutate({ todo: last, input: todoToInput(last, { title: 'Water the garden' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(success).not.toHaveBeenCalled()
  })

  it('undoes a series change with its token', async () => {
    const success = vi.spyOn(toast, 'success')
    const { result, cached, writes } = setup([{ ...rolled, completedCopy: copy }, { ...series, etag: '"3"' }])

    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(cached()?.map((x) => x.id)).toEqual(['t2', 'copy1'])

    act(toastOf(success.mock.calls, 'Done. Next up: Thu, Oct 8').click)
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith('Undone.')
    })
    const undoWrites = writes().filter((w) => w.request.includes('/undo'))
    expect(undoWrites).toHaveLength(1)
    expect(undoWrites[0]?.request).toBe('POST /api/v1/todos/t2/undo')
    expect(undoWrites[0]?.body).toEqual({ token: 'tok' })
    // The completed copy is gone, undone by the server's restore itself.
    expect(cached()?.map((x) => x.id)).toEqual(['t2'])
  })

  it('offers no undo without a token', async () => {
    const success = vi.spyOn(toast, 'success')
    const { result } = setup([{ ...rolled, completedCopy: copy, undoToken: undefined }])

    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const shown = toastOf(success.mock.calls, 'Done. Next up: Thu, Oct 8')
    expect(shown.duration).toBe(8000)
    expect(shown.action).toBeUndefined()
  })

  it('replaces the undo toast of an earlier change', async () => {
    const { result, writes } = setup([
      { ...series, etag: '"2"', due: '2026-10-07T00:00:00Z', undoToken: 'tok1' },
      { ...series, etag: '"3"', due: '2026-10-09T00:00:00Z', undoToken: 'tok2' },
    ])

    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { due: '2026-10-07T00:00:00.000Z' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const after1 = result.current.data!

    act(() => {
      result.current.mutate({ todo: after1, input: todoToInput(after1, { due: '2026-10-09T00:00:00.000Z' }) })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    await waitFor(() => {
      expect(seriesToastAction('t2')?.label).toBe('Undo')
    })
    expect(toast.getToasts().filter((x) => x.id === 'series:t2')).toHaveLength(1)

    const action = seriesToastAction('t2')
    act(() => {
      action?.onClick({} as MouseEvent<HTMLButtonElement>)
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(3)
    })
    const undo = writes()[2]
    expect(undo?.request).toBe('POST /api/v1/todos/t2/undo')
    expect(undo?.body).toEqual({ token: 'tok2' })
  })

  it('takes the undo of an earlier change away when the next one has none', async () => {
    const { result, writes } = setup([
      { ...series, etag: '"2"', due: '2026-10-07T00:00:00Z', undoToken: 'tok1' },
      { ...series, etag: '"3"', due: '2026-10-09T00:00:00Z' },
    ])

    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { due: '2026-10-07T00:00:00.000Z' }) })
    })
    await waitFor(() => {
      expect(seriesToastAction('t2')?.label).toBe('Undo')
    })
    const after1 = result.current.data!

    act(() => {
      result.current.mutate({ todo: after1, input: todoToInput(after1, { due: '2026-10-09T00:00:00.000Z' }) })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    await waitFor(() => {
      expect(result.current.data?.etag).toBe('"3"')
    })
    // One toast, the second change's, which has no Undo: sonner merges a toast into the one of its ID.
    expect(toast.getToasts().filter((x) => x.id === 'series:t2')).toHaveLength(1)
    expect(seriesToastAction('t2')).toBeUndefined()
  })

  it('takes the undo of an earlier change away once the series changes again', async () => {
    let answerSecond: (a: Answer) => void = () => undefined
    const { result, writes } = setup([
      { ...series, etag: '"2"', due: '2026-10-07T00:00:00Z', undoToken: 'tok1' },
      new Promise<Answer>((resolve) => (answerSecond = resolve)),
      { ...series, etag: '"4"' },
    ])

    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { due: '2026-10-07T00:00:00.000Z' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(seriesToastAction('t2')?.label).toBe('Undo')
    const after1 = result.current.data!

    act(() => {
      result.current.mutate({ todo: after1, input: todoToInput(after1, { due: '2026-10-09T00:00:00.000Z' }) })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    // While the second change is on its way, the first's toast says what it did, without Undo.
    expect(toast.getToasts().some((x) => x.id === 'series:t2')).toBe(true)
    expect(seriesToastAction('t2')).toBeUndefined()

    answerSecond({ ...series, etag: '"3"', due: '2026-10-09T00:00:00Z', undoToken: 'tok2' })
    await waitFor(() => {
      expect(seriesToastAction('t2')?.label).toBe('Undo')
    })
    act(() => {
      seriesToastAction('t2')?.onClick({} as MouseEvent<HTMLButtonElement>)
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(3)
    })
    expect(writes()[2]).toMatchObject({ request: 'POST /api/v1/todos/t2/undo', body: { token: 'tok2' } })
  })

  it('offers no undo for a change overtaken while it was saving', async () => {
    let answerFirst: (a: Answer) => void = () => undefined
    let answerSecond: (a: Answer) => void = () => undefined
    const { result, writes } = setup([
      new Promise<Answer>((resolve) => (answerFirst = resolve)),
      new Promise<Answer>((resolve) => (answerSecond = resolve)),
      { ...series, etag: '"4"' },
    ])

    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { due: '2026-10-07T00:00:00.000Z' }) })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(1)
    })
    // The second change waits for the first, which then answers with a token.
    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { due: '2026-10-09T00:00:00.000Z' }) })
    })
    answerFirst({ ...series, etag: '"2"', due: '2026-10-07T00:00:00Z', undoToken: 'tok1' })
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    expect(toast.getToasts().some((x) => x.id === 'series:t2')).toBe(true)
    expect(seriesToastAction('t2')).toBeUndefined()

    answerSecond({ ...series, etag: '"3"', due: '2026-10-09T00:00:00Z', undoToken: 'tok2' })
    await waitFor(() => {
      expect(seriesToastAction('t2')?.label).toBe('Undo')
    })
    act(() => {
      seriesToastAction('t2')?.onClick({} as MouseEvent<HTMLButtonElement>)
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(3)
    })
    expect(writes()[2]).toMatchObject({ request: 'POST /api/v1/todos/t2/undo', body: { token: 'tok2' } })
  })

  it('reports a gone undo', async () => {
    const success = vi.spyOn(toast, 'success')
    const error = vi.spyOn(toast, 'error')
    const { result, writes } = setup([
      { ...rolled, completedCopy: copy },
      jsonResponse(404, { error: { code: 'not_found', message: 'x' } }),
    ])
    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    act(toastOf(success.mock.calls, 'Done. Next up: Thu, Oct 8').click)
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith('Nothing to undo anymore.')
    })
    expect(writes().map((w) => w.request)).toEqual(['PUT /api/v1/todos/t2', 'POST /api/v1/todos/t2/undo'])
  })

  it('reports an undo conflict', async () => {
    const success = vi.spyOn(toast, 'success')
    const error = vi.spyOn(toast, 'error')
    const { queryClient, result } = setup([
      { ...rolled, completedCopy: copy },
      jsonResponse(409, { error: { code: 'conflict', message: 'x' } }),
    ])
    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    act(toastOf(success.mock.calls, 'Done. Next up: Thu, Oct 8').click)
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Couldn't undo: the task was changed elsewhere in the meantime.")
    })
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.todos('c1') })
    })
  })

  it('keeps a changed completed entry', async () => {
    const success = vi.spyOn(toast, 'success')
    const warning = vi.spyOn(toast, 'warning')
    const { result, cached, writes } = setup([
      { ...rolled, completedCopy: copy },
      { ...series, etag: '"3"', copyKept: true },
    ])
    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    act(toastOf(success.mock.calls, 'Done. Next up: Thu, Oct 8').click)
    await waitFor(() => {
      expect(warning).toHaveBeenCalledWith('Undone. The completed entry was changed in another app and stays.')
    })
    expect(writes().map((w) => w.request)).toEqual(['PUT /api/v1/todos/t2', 'POST /api/v1/todos/t2/undo'])
    // The completed copy was not removed: it stays in the list.
    expect(cached()?.map((x) => x.id)).toEqual(['t2', 'copy1'])
    expect(success).not.toHaveBeenCalledWith('Undone.')
  })

  it('marks the series busy while undoing', async () => {
    const success = vi.spyOn(toast, 'success')
    let answerUndo: (a: Answer) => void = () => undefined
    const { queryClient, result, writes } = setup([
      { ...rolled, completedCopy: copy },
      new Promise<Answer>((resolve) => (answerUndo = resolve)),
    ])
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const pending = renderHook(() => usePendingSeries(), { wrapper: wrap })

    act(() => {
      result.current.mutate({ todo: series, input: todoToInput(series, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(pending.result.current.size).toBe(0)

    act(toastOf(success.mock.calls, 'Done. Next up: Thu, Oct 8').click)
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    expect([...pending.result.current]).toEqual(['t2'])

    answerUndo({ ...series, etag: '"3"' })
    await waitFor(() => {
      expect(pending.result.current.size).toBe(0)
    })
  })
})

describe('usePendingSeries', () => {
  it('holds the recurring tasks with an update on its way', async () => {
    api.setCsrfToken('tok')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const answers: ((r: Response) => void)[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve)
        }),
    )
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const due = '2026-10-05T00:00:00Z'
    const series = todo({ id: 't2', due, dueAllDay: true, rrule: 'FREQ=DAILY', recurring: true })
    const single = todo({ id: 't1' })
    const { result } = renderHook(
      () => ({ series: useUpdateTodo('t2'), single: useUpdateTodo('t1'), pending: usePendingSeries() }),
      { wrapper: wrap },
    )
    expect(result.current.pending.size).toBe(0)

    act(() => {
      result.current.series.mutate({ todo: series, input: todoToInput(series, { title: 'New' }) })
      result.current.single.mutate({ todo: single, input: todoToInput(single, { title: 'New' }) })
    })
    await waitFor(() => {
      expect(answers).toHaveLength(2)
    })
    expect([...result.current.pending]).toEqual(['t2'])

    answers[0]?.(jsonResponse(200, { ...series, title: 'New', etag: '"2"' }))
    answers[1]?.(jsonResponse(200, { ...single, title: 'New', etag: '"2"' }))
    await waitFor(() => {
      expect(result.current.pending.size).toBe(0)
    })
  })
})

describe('useDeleteTodo', () => {
  it('takes the undo of an earlier change of the task away when it starts', async () => {
    api.setCsrfToken('tok')
    const series = todo({ id: 'x', calendarId: 'c1', etag: '"2"', recurring: true })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData<TodoList>(queryKeys.todos('c1'), { todos: [series], corrupted: [] })
    // The answer never comes: the Undo is gone before it.
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined))
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useDeleteTodo('x'), { wrapper: wrap })
    toast.success('Moved to Thu, Oct 8.', { id: 'series:x', action: { label: 'Undo', onClick: () => undefined } })

    act(() => {
      result.current.mutate(series)
    })
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    expect(toast.getToasts().some((x) => x.id === 'series:x')).toBe(true)
    expect(seriesToastAction('x')).toBeUndefined()
  })

  it('deletes a task only after its update in flight, with the ETag that update got', async () => {
    api.setCsrfToken('tok')
    const old = todo({ id: 'x', calendarId: 'c1', etag: '"1"' })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData<TodoList>(queryKeys.todos('c1'), { todos: [old], corrupted: [] })
    const answers: ((r: Response) => void)[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve)
        }),
    )
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    // Like a row: checked, and deleted while the check is still on its way.
    const { result } = renderHook(() => ({ update: useUpdateTodo('x'), del: useDeleteTodo('x') }), { wrapper: wrap })

    act(() => {
      result.current.update.mutate({ todo: old, input: todoToInput(old, { status: 'COMPLETED' }) })
    })
    await waitFor(() => {
      expect(answers).toHaveLength(1)
    })
    const shown = queryClient.getQueryData<TodoList>(queryKeys.todos('c1'))!.todos[0]!
    act(() => {
      result.current.del.mutate(shown)
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(fetch).toHaveBeenCalledTimes(1)

    answers[0]?.(jsonResponse(200, { ...old, status: 'COMPLETED', etag: '"2"' }))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2)
    })
    const [url, init] = fetch.mock.calls[1]!
    expect(urlOf(url)).toBe('/api/v1/todos/x')
    expect(init?.method).toBe('DELETE')
    expect((init?.headers as Record<string, string>)['If-Match']).toBe('"2"')
  })
})

// FR-17, NFR-26: the writes of a task series' repeat besides "all": detach and skip at the
// current repeat, split and end at a later one. None is optimistic; each says what it reached,
// with the reach glyph of its choice and an Undo that goes to the old series.
describe('task scope writes', () => {
  // Mondays and Thursdays, all-day: the current repeat is Mon, Oct 5, the next Thu, Oct 8.
  const series = todo({
    id: 't2',
    calendarId: 'c1',
    uid: 'u2',
    etag: '"1"',
    title: 'Water the flowers',
    due: '2026-10-05T00:00:00Z',
    dueAllDay: true,
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
    recurring: true,
    fixedDays: true,
    recurrenceId: '2026-10-05T00:00:00Z',
    next: { due: '2026-10-08T00:00:00Z' },
  })
  const current = currentRepeat(series)!
  // Mon, Oct 12: a later repeat, from which "this and following" splits the series.
  const later: TaskRepeat = {
    todo: series,
    recurrenceId: '2026-10-12T00:00:00Z',
    at: 'upcoming',
    last: false,
    offRule: false,
    title: series.title,
    shown: { start: null, startAllDay: false, due: '2026-10-12T00:00:00Z', dueAllDay: true },
  }
  /** The series rolled on to Thu, Oct 8, as a detach or a skip of Mon, Oct 5 answers. */
  const rolled = {
    ...series,
    etag: '"2"',
    due: '2026-10-08T00:00:00Z',
    recurrenceId: '2026-10-08T00:00:00Z',
    next: { due: '2026-10-12T00:00:00Z' },
  }
  /** The task a detach made of Mon, Oct 5, moved to Tue, Oct 6. */
  const detached = todo({
    id: 'd1',
    calendarId: 'c1',
    uid: 'u-d1',
    etag: '"d"',
    title: 'Water the flowers',
    due: '2026-10-06T00:00:00Z',
    dueAllDay: true,
    detachedFrom: 'u2',
  })
  /** The new series a split makes from Mon, Oct 12, moved to Tue, Oct 13. */
  const split = todo({
    ...series,
    id: 't9',
    uid: 'u9',
    etag: '"n1"',
    due: '2026-10-13T00:00:00Z',
    rrule: 'FREQ=WEEKLY;BYDAY=TU,FR',
    recurrenceId: '2026-10-13T00:00:00Z',
    next: { due: '2026-10-16T00:00:00Z' },
  })
  /** The old series as a split or an end wrote it, ending before Mon, Oct 12. */
  const ended = { ...series, etag: '"5"', rrule: 'FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20261011' }
  /** Mon, Oct 5 moved to Tue, Oct 6. */
  const toTuesday = todoToInput(series, { due: '2026-10-06T00:00:00.000Z' })
  /** R, Mon, Oct 12, moved to Tue, Oct 13. */
  const toLaterTuesday = todoToInput(series, { due: '2026-10-13T00:00:00.000Z' })
  const red = 'var(--destructive)'

  beforeEach(() => {
    // Only the date, so the toast leaves the year out: fake timers would stall the requests.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 5, 12))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A client holding the series, and a server answering each request with the next of `answers`. */
  function setup(...answers: (Response | Promise<Response>)[]) {
    api.setCsrfToken('tok')
    const queryClient = eventClient()
    queryClient.setQueryData<TodoList>(queryKeys.todos('c1'), { todos: [series], corrupted: [] })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const next = answers.shift()
      return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected request'))
    })
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const writes = () =>
      fetch.mock.calls.map(([url, init]) => ({
        request: `${init?.method} ${urlOf(url)}`,
        etag: (init?.headers as Record<string, string>)['If-Match'],
        body: bodyOf(init),
      }))
    const cached = () => queryClient.getQueryData<TodoList>(queryKeys.todos('c1'))?.todos
    return { queryClient, wrap, writes, cached }
  }

  function useScopeWrites() {
    return {
      detach: useDetachTodo('t2'),
      skip: useSkipTodo('t2'),
      following: useTodoFollowing('t2'),
      end: useEndTodo('t2'),
      update: useUpdateTodo('t2'),
    }
  }
  type ScopeWrites = ReturnType<typeof useScopeWrites>

  describe('only this repeat', () => {
    it('detaches the current repeat, and its undo takes the detached task back', async () => {
      const success = vi.spyOn(toast, 'success')
      const { wrap, writes, cached } = setup(
        jsonResponse(200, { ...rolled, undoToken: 'tok', detachedCopy: detached }),
        jsonResponse(200, { ...series, etag: '"3"' }),
      )
      const { result } = renderHook(() => useDetachTodo('t2'), { wrapper: wrap })
      // The editor's input carries the rule; the repeat it detaches has none of its own.
      const input = { ...toTuesday, rrule: series.rrule }

      act(() => {
        result.current.mutate({ todo: series, repeat: current, input, moved: true })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      expect(writes()).toEqual([
        { request: 'PUT /api/v1/todos/t2/occurrences/2026-10-05T00%3A00%3A00Z', etag: '"1"', body: toTuesday },
      ])
      // The series goes on at its next repeat, next to the task of its own.
      expect(cached()?.map((x) => [x.id, x.due])).toEqual([
        ['t2', '2026-10-08T00:00:00Z'],
        ['d1', '2026-10-06T00:00:00Z'],
      ])
      expect(cached()?.[0]).not.toHaveProperty('detachedCopy')
      const shown = toastOf(
        success.mock.calls,
        'Moved to Tue, Oct 6 as a task of its own. The series goes on Thu, Oct 8.',
      )
      expect(shown).toMatchObject({ id: 'series:t2', duration: 8000, action: 'Undo' })
      expect(marksOf(shown.icon)).toEqual(['✓', '✓', CALENDAR_COLOR, 'none', 'none'])

      act(shown.click)
      await waitFor(() => {
        expect(success).toHaveBeenCalledWith('Undone.')
      })
      expect(writes()[1]).toMatchObject({ request: 'POST /api/v1/todos/t2/undo', body: { token: 'tok' } })
      expect(cached()?.map((x) => [x.id, x.etag, x.due])).toEqual([['t2', '"3"', '2026-10-05T00:00:00Z']])
    })

    it('says a repeat changed on its own, and where the series goes on', async () => {
      const success = vi.spyOn(toast, 'success')
      const renamed = { ...detached, due: series.due, title: 'Water the roses' }
      const { wrap } = setup(jsonResponse(200, { ...rolled, undoToken: 'tok', detachedCopy: renamed }))
      const { result } = renderHook(() => useDetachTodo('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({
          todo: series,
          repeat: current,
          input: todoToInput(series, { title: 'Water the roses' }),
          moved: false,
        })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      expect(
        toastOf(success.mock.calls, 'Changed as a task of its own. The series goes on Thu, Oct 8.'),
      ).toMatchObject({ id: 'series:t2', action: 'Undo' })
      expect(success).toHaveBeenCalledTimes(1)
    })

    // The server hands out no token where it can't tell the detached task's ETag, or with attendees.
    it('offers no undo without a token', async () => {
      const success = vi.spyOn(toast, 'success')
      const { wrap } = setup(jsonResponse(200, { ...rolled, detachedCopy: detached }))
      const { result } = renderHook(() => useDetachTodo('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({ todo: series, repeat: current, input: toTuesday, moved: true })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      const shown = toastOf(
        success.mock.calls,
        'Moved to Tue, Oct 6 as a task of its own. The series goes on Thu, Oct 8.',
      )
      expect(shown).toMatchObject({ id: 'series:t2', duration: 8000 })
      expect(shown.action).toBeUndefined()
    })

    // A write of the series queued ahead of it ended the series after its current repeat: the server
    // changes that last repeat as a single task, which asks nothing.
    it('tells where the last repeat moved when the server detached nothing', async () => {
      const success = vi.spyOn(toast, 'success')
      const moved = { ...series, etag: '"2"', due: '2026-10-06T00:00:00Z', next: null, undoToken: 'tok' }
      const { wrap, cached } = setup(jsonResponse(200, moved))
      const { result } = renderHook(() => useDetachTodo('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({ todo: series, repeat: current, input: toTuesday, moved: true })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      expect(cached()?.map((x) => [x.id, x.due])).toEqual([['t2', '2026-10-06T00:00:00Z']])
      const shown = toastOf(success.mock.calls, 'Moved to Tue, Oct 6.')
      expect(shown).toMatchObject({ id: 'series:t2', action: 'Undo' })
      expect(shown.icon).toBeUndefined()
      expect(success).toHaveBeenCalledTimes(1)
    })

    it('keeps a detached task another app changed while the undo ran', async () => {
      const success = vi.spyOn(toast, 'success')
      const warning = vi.spyOn(toast, 'warning')
      const { wrap, cached } = setup(
        jsonResponse(200, { ...rolled, undoToken: 'tok', detachedCopy: detached }),
        jsonResponse(200, { ...series, etag: '"3"', copyKept: true }),
      )
      const { result } = renderHook(() => useDetachTodo('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({ todo: series, repeat: current, input: toTuesday, moved: true })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      act(
        toastOf(success.mock.calls, 'Moved to Tue, Oct 6 as a task of its own. The series goes on Thu, Oct 8.')
          .click,
      )

      await waitFor(() => {
        expect(warning).toHaveBeenCalledWith('Undone. The detached task was changed in another app and stays.')
      })
      expect(success).not.toHaveBeenCalledWith('Undone.')
      expect(cached()?.map((x) => x.id)).toEqual(['t2', 'd1'])
      expect(cached()?.[0]).not.toHaveProperty('copyKept')
    })

    // FR-17: the server refuses the undo of a detach once the detached task changed, as the series
    // restored would show the repeat twice; a write of the detached task takes the detach's Undo away.
    it("takes the detach's undo away once the detached task changes", async () => {
      const success = vi.spyOn(toast, 'success')
      const { queryClient, wrap, writes } = setup(
        jsonResponse(200, { ...rolled, undoToken: 'tok', detachedCopy: detached }),
        new Promise<Response>(() => undefined),
      )
      const { result } = renderHook(() => ({ detach: useDetachTodo('t2'), ofDetached: useUpdateTodo('d1') }), {
        wrapper: wrap,
      })

      act(() => {
        result.current.detach.mutate({ todo: series, repeat: current, input: toTuesday, moved: true })
      })
      await waitFor(() => {
        expect(seriesToastAction('t2')?.label).toBe('Undo')
      })
      const message = 'Moved to Tue, Oct 6 as a task of its own. The series goes on Thu, Oct 8.'
      expect(toastOf(success.mock.calls, message).action).toBe('Undo')

      // Checked off, as from the task list.
      act(() => {
        result.current.ofDetached.mutate({ todo: detached, input: todoToInput(detached, { status: 'COMPLETED' }) })
      })
      await waitFor(() => {
        expect(writes()).toHaveLength(2)
      })
      // The detach's toast stays, without Undo.
      const shown = toast.getToasts().find((x) => x.id === 'series:t2')
      expect(shown && 'title' in shown ? shown.title : undefined).toBe(message)
      expect(seriesToastAction('t2')).toBeUndefined()
      expect(queryClient.isMutating()).toBe(1)
    })

    it('skips the current repeat, and says what is next up', async () => {
      const success = vi.spyOn(toast, 'success')
      const { wrap, writes, cached } = setup(
        jsonResponse(200, { ...rolled, undoToken: 'tok' }),
        jsonResponse(200, { ...series, etag: '"3"' }),
      )
      const { result } = renderHook(() => useSkipTodo('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({ todo: series, repeat: current })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      expect(writes()).toEqual([
        { request: 'DELETE /api/v1/todos/t2/occurrences/2026-10-05T00%3A00%3A00Z', etag: '"1"', body: {} },
      ])
      expect(cached()?.map((x) => [x.id, x.due])).toEqual([['t2', '2026-10-08T00:00:00Z']])
      const shown = toastOf(success.mock.calls, 'Skipped. Next up: Thu, Oct 8')
      expect(shown).toMatchObject({ id: 'series:t2', duration: 8000, action: 'Undo' })
      // Red, as the repeat is gone; the done ones are never red.
      expect(marksOf(shown.icon)).toEqual(['✓', '✓', red, 'none', 'none'])

      act(shown.click)
      await waitFor(() => {
        expect(success).toHaveBeenCalledWith('Undone.')
      })
      expect(writes()[1]).toMatchObject({ request: 'POST /api/v1/todos/t2/undo', body: { token: 'tok' } })
    })

    it('queues a write behind a pending undo with the ETag the undo answered with', async () => {
      const success = vi.spyOn(toast, 'success')
      let answerUndo: (r: Response) => void = () => undefined
      const { queryClient, wrap, writes } = setup(
        jsonResponse(200, { ...rolled, undoToken: 'tok' }),
        new Promise<Response>((resolve) => (answerUndo = resolve)),
        jsonResponse(200, { ...rolled, etag: '"4"' }),
      )
      const { result } = renderHook(() => useSkipTodo('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({ todo: series, repeat: current })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      act(toastOf(success.mock.calls, 'Skipped. Next up: Thu, Oct 8').click)
      await waitFor(() => {
        expect(writes()).toHaveLength(2)
      })

      // A skip of the repeat as it was loaded, while the undo is on its way: it waits for the undo.
      act(() => {
        result.current.mutate({ todo: series, repeat: current })
      })
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
      expect(writes()).toHaveLength(2)

      answerUndo(jsonResponse(200, { ...series, etag: '"3"' }))
      await waitFor(() => {
        expect(writes()).toHaveLength(3)
      })
      expect(writes()[2]).toMatchObject({
        request: 'DELETE /api/v1/todos/t2/occurrences/2026-10-05T00%3A00%3A00Z',
        etag: '"3"',
      })
      await waitFor(() => {
        expect(queryClient.isMutating()).toBe(0)
      })
    })
  })

  describe('this and following repeats', () => {
    const answer = (undoToken?: string) =>
      jsonResponse(200, { todo: split, series: ended, ...(undoToken ? { undoToken } : {}) })

    it('splits the series at a later repeat, and its undo goes to the old series', async () => {
      const success = vi.spyOn(toast, 'success')
      const { queryClient, wrap, writes, cached } = setup(answer('tok'), jsonResponse(200, { ...series, etag: '"6"' }))
      const { result } = renderHook(() => useTodoFollowing('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({ todo: series, repeat: later, input: toLaterTuesday, moved: true })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      expect(writes()).toEqual([
        { request: 'PUT /api/v1/todos/t2/following/2026-10-12T00%3A00%3A00Z', etag: '"1"', body: toLaterTuesday },
      ])
      // Not optimistic: both series come with the reload.
      expect(cached()).toEqual([series])
      // Named by the day the split starts from, as the question named it.
      const shown = toastOf(success.mock.calls, 'Moved from Mon, Oct 12 on, as a series of its own.')
      expect(shown).toMatchObject({ id: 'series:t2', duration: 8000, action: 'Undo' })
      expect(marksOf(shown.icon)).toEqual(['✓', 'none', CALENDAR_COLOR, CALENDAR_COLOR, CALENDAR_COLOR])

      // As the reload after the split shows them.
      queryClient.setQueryData<TodoList>(queryKeys.todos('c1'), { todos: [ended, split], corrupted: [] })
      act(shown.click)
      await waitFor(() => {
        expect(success).toHaveBeenCalledWith('Undone.')
      })
      expect(writes()[1]).toMatchObject({ request: 'POST /api/v1/todos/t2/undo', body: { token: 'tok' } })
      // The undo took the new series back.
      expect(cached()?.map((x) => [x.id, x.etag])).toEqual([['t2', '"6"']])
    })

    it('says the series changed from when after an edit', async () => {
      const success = vi.spyOn(toast, 'success')
      const { wrap } = setup(answer('tok'))
      const { result } = renderHook(() => useTodoFollowing('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({
          todo: series,
          repeat: later,
          input: todoToInput(series, { title: 'Water the roses', due: later.shown.due ?? null }),
          moved: false,
        })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      expect(toastOf(success.mock.calls, 'Changed from Mon, Oct 12 on, as a series of its own.')).toMatchObject({
        id: 'series:t2',
        action: 'Undo',
      })
      expect(success).toHaveBeenCalledTimes(1)
    })

    it('says the series ends, in red, when the rule is removed from a later repeat on', async () => {
      const success = vi.spyOn(toast, 'success')
      const { wrap } = setup(
        jsonResponse(200, { todo: { ...split, rrule: '', recurring: false, next: null }, series: ended, undoToken: 'tok' }),
      )
      const { result } = renderHook(() => useTodoFollowing('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({ todo: series, repeat: later, input: { ...toLaterTuesday, rrule: '' }, moved: true })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      const shown = toastOf(success.mock.calls, 'The series now ends before Mon, Oct 12.')
      expect(shown).toMatchObject({ id: 'series:t2', action: 'Undo' })
      expect(marksOf(shown.icon)).toEqual(['✓', 'none', red, red, red])
    })

    // The server changes the series from its current repeat when the repeat has become it, as in
    // a view not reloaded since: no new series, so all its repeats changed.
    it('says the whole series changed when the server found the repeat current', async () => {
      const success = vi.spyOn(toast, 'success')
      const moved = { ...series, etag: '"2"', due: '2026-10-13T00:00:00Z' }
      const { wrap, writes, cached } = setup(
        jsonResponse(200, { todo: moved, series: moved, undoToken: 'tok' }),
        jsonResponse(200, { ...series, etag: '"3"' }),
      )
      const { result } = renderHook(() => useTodoFollowing('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({ todo: series, repeat: later, input: toLaterTuesday, moved: true })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      const shown = toastOf(success.mock.calls, 'Series moved. Next up: Tue, Oct 13')
      expect(shown).toMatchObject({ id: 'series:t2', action: 'Undo' })
      expect(marksOf(shown.icon)).toEqual(['✓', '✓', CALENDAR_COLOR, CALENDAR_COLOR, CALENDAR_COLOR])

      act(shown.click)
      await waitFor(() => {
        expect(success).toHaveBeenCalledWith('Undone.')
      })
      expect(writes()[1]).toMatchObject({ request: 'POST /api/v1/todos/t2/undo' })
      // The series is no copy of itself: it stays.
      expect(cached()?.map((x) => [x.id, x.etag])).toEqual([['t2', '"3"']])
    })

    it('tells that the new series stays after an undo', async () => {
      const success = vi.spyOn(toast, 'success')
      const warning = vi.spyOn(toast, 'warning')
      const { queryClient, wrap, cached } = setup(answer('tok'), jsonResponse(200, { ...series, etag: '"6"', copyKept: true }))
      const { result } = renderHook(() => useTodoFollowing('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({ todo: series, repeat: later, input: toLaterTuesday, moved: true })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      queryClient.setQueryData<TodoList>(queryKeys.todos('c1'), { todos: [ended, split], corrupted: [] })
      act(toastOf(success.mock.calls, 'Moved from Mon, Oct 12 on, as a series of its own.').click)

      await waitFor(() => {
        expect(warning).toHaveBeenCalledWith('Undone. The new series was changed in another app and stays.')
      })
      expect(cached()?.map((x) => x.id)).toEqual(['t2', 't9'])
    })

    // With the rule removed, the new series is the repeat alone: a task of its own, not a series.
    it('tells that the task of its own stays after an undo of a split that removed the rule', async () => {
      const success = vi.spyOn(toast, 'success')
      const warning = vi.spyOn(toast, 'warning')
      const single = { ...split, rrule: '', recurring: false, next: null }
      const { queryClient, wrap, cached } = setup(
        jsonResponse(200, { todo: single, series: ended, undoToken: 'tok' }),
        jsonResponse(200, { ...series, etag: '"6"', copyKept: true }),
      )
      const { result } = renderHook(() => useTodoFollowing('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({ todo: series, repeat: later, input: { ...toLaterTuesday, rrule: '' }, moved: true })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      queryClient.setQueryData<TodoList>(queryKeys.todos('c1'), { todos: [ended, single], corrupted: [] })
      act(toastOf(success.mock.calls, 'The series now ends before Mon, Oct 12.').click)

      await waitFor(() => {
        expect(warning).toHaveBeenCalledWith('Undone. The detached task was changed in another app and stays.')
      })
      expect(cached()?.map((x) => x.id)).toEqual(['t2', 't9'])
    })

    // FR-17: the server refuses the undo of a split once the new series changed.
    it("takes the split's undo away once the new series changes", async () => {
      const success = vi.spyOn(toast, 'success')
      const { queryClient, wrap, writes } = setup(answer('tok'), new Promise<Response>(() => undefined))
      const { result } = renderHook(() => ({ split: useTodoFollowing('t2'), ofNew: useUpdateTodo('t9') }), {
        wrapper: wrap,
      })

      act(() => {
        result.current.split.mutate({ todo: series, repeat: later, input: toLaterTuesday, moved: true })
      })
      await waitFor(() => {
        expect(seriesToastAction('t2')?.label).toBe('Undo')
      })
      const message = 'Moved from Mon, Oct 12 on, as a series of its own.'
      expect(toastOf(success.mock.calls, message).action).toBe('Undo')

      act(() => {
        result.current.ofNew.mutate({ todo: split, input: todoToInput(split, { title: 'Water the roses' }) })
      })
      await waitFor(() => {
        expect(writes()).toHaveLength(2)
      })
      // The split's toast stays, without Undo.
      const shown = toast.getToasts().find((x) => x.id === 'series:t2')
      expect(shown && 'title' in shown ? shown.title : undefined).toBe(message)
      expect(seriesToastAction('t2')).toBeUndefined()
      expect(queryClient.isMutating()).toBe(1)
    })

    it('ends the series before a later repeat, with an undo', async () => {
      const success = vi.spyOn(toast, 'success')
      const { wrap, writes } = setup(
        jsonResponse(200, { ...ended, undoToken: 'tok' }),
        jsonResponse(200, { ...series, etag: '"6"' }),
      )
      const { result } = renderHook(() => useEndTodo('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({ todo: series, repeat: later })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      expect(writes()).toEqual([
        { request: 'DELETE /api/v1/todos/t2/following/2026-10-12T00%3A00%3A00Z', etag: '"1"', body: {} },
      ])
      const shown = toastOf(success.mock.calls, 'The series now ends before Mon, Oct 12.')
      expect(shown).toMatchObject({ id: 'series:t2', duration: 8000, action: 'Undo' })
      expect(marksOf(shown.icon)).toEqual(['✓', 'none', red, red, red])

      act(shown.click)
      await waitFor(() => {
        expect(success).toHaveBeenCalledWith('Undone.')
      })
      expect(writes()[1]).toMatchObject({ request: 'POST /api/v1/todos/t2/undo', body: { token: 'tok' } })
    })

    // At what the server found the current repeat, ending the series before it deletes it.
    it('says the task was deleted, without undo, when the end deleted it', async () => {
      const success = vi.spyOn(toast, 'success')
      const { wrap, cached } = setup(new Response(null, { status: 204 }))
      const { result } = renderHook(() => useEndTodo('t2'), { wrapper: wrap })

      act(() => {
        result.current.mutate({ todo: series, repeat: later })
      })
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })
      expect(cached()).toEqual([])
      const shown = toastOf(success.mock.calls, 'Task deleted')
      expect(shown).toMatchObject({ id: 'series:t2' })
      expect(shown.action).toBeUndefined()
      // From the current repeat on, all of them.
      expect(marksOf(shown.icon)).toEqual(['✓', '✓', red, red, red])
      expect(success).toHaveBeenCalledTimes(1)
    })
  })

  it('reads the theme for a toast when it shows, and observes none while the hooks are held', async () => {
    const success = vi.spyOn(toast, 'success')
    const media = vi.spyOn(window, 'matchMedia')
    const { wrap } = setup(jsonResponse(200, { ...rolled, undoToken: 'tok' }))
    const { result } = renderHook(useScopeWrites, { wrapper: wrap })
    expect(media).not.toHaveBeenCalled()

    act(() => {
      result.current.skip.mutate({ todo: series, repeat: current })
    })
    await waitFor(() => {
      expect(result.current.skip.isSuccess).toBe(true)
    })
    expect(media).toHaveBeenCalledWith('(prefers-color-scheme: dark)')
    expect(marksOf(toastOf(success.mock.calls, 'Skipped. Next up: Thu, Oct 8').icon)).toEqual([
      '✓',
      '✓',
      red,
      'none',
      'none',
    ])
  })

  const firsts: [string, (h: ScopeWrites) => void, () => Response, string][] = [
    [
      'detaching',
      (h) => h.detach.mutate({ todo: series, repeat: current, input: toTuesday, moved: true }),
      () => jsonResponse(200, { ...rolled, detachedCopy: detached }),
      '"2"',
    ],
    ['skipping', (h) => h.skip.mutate({ todo: series, repeat: current }), () => jsonResponse(200, rolled), '"2"'],
    [
      'splitting',
      (h) => h.following.mutate({ todo: series, repeat: later, input: toLaterTuesday, moved: true }),
      () => jsonResponse(200, { todo: split, series: ended }),
      '"5"',
    ],
    ['ending', (h) => h.end.mutate({ todo: series, repeat: later }), () => jsonResponse(200, ended), '"5"'],
  ]

  // NFR-26: both from the series as shown, with the ETag it was loaded with.
  it.each(firsts)('runs a write queued behind %s with the ETag its answer gave the series', async (_, first, reply, etag) => {
    let answerFirst: (r: Response) => void = () => undefined
    const { queryClient, wrap, writes } = setup(
      new Promise<Response>((resolve) => (answerFirst = resolve)),
      jsonResponse(200, { ...series, etag: '"9"', title: 'Water the roses' }),
    )
    const { result } = renderHook(useScopeWrites, { wrapper: wrap })

    act(() => {
      first(result.current)
      result.current.update.mutate({ todo: series, input: todoToInput(series, { title: 'Water the roses' }) })
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(1)
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(writes()).toHaveLength(1)

    answerFirst(reply())
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    expect(writes()[1]).toMatchObject({ request: 'PUT /api/v1/todos/t2', etag })
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0)
    })
  })

  const seconds: [string, (h: ScopeWrites) => void, string][] = [
    [
      'detaching',
      (h) => h.detach.mutate({ todo: series, repeat: current, input: toTuesday, moved: true }),
      'PUT /api/v1/todos/t2/occurrences/2026-10-05T00%3A00%3A00Z',
    ],
    ['skipping', (h) => h.skip.mutate({ todo: series, repeat: current }), 'DELETE /api/v1/todos/t2/occurrences/2026-10-05T00%3A00%3A00Z'],
    [
      'splitting',
      (h) => h.following.mutate({ todo: series, repeat: later, input: toLaterTuesday, moved: true }),
      'PUT /api/v1/todos/t2/following/2026-10-12T00%3A00%3A00Z',
    ],
    ['ending', (h) => h.end.mutate({ todo: series, repeat: later }), 'DELETE /api/v1/todos/t2/following/2026-10-12T00%3A00%3A00Z'],
  ]

  it.each(seconds)('runs %s queued behind a write of the series with the ETag that write got', async (_, second, request) => {
    let answerFirst: (r: Response) => void = () => undefined
    const { wrap, writes } = setup(
      new Promise<Response>((resolve) => (answerFirst = resolve)),
      new Promise<Response>(() => undefined),
    )
    const { result } = renderHook(useScopeWrites, { wrapper: wrap })

    act(() => {
      result.current.update.mutate({ todo: series, input: todoToInput(series, { title: 'Water the roses' }) })
      second(result.current)
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(1)
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(writes()).toHaveLength(1)

    answerFirst(jsonResponse(200, { ...series, etag: '"7"', title: 'Water the roses' }))
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    expect(writes()[1]).toMatchObject({ request, etag: '"7"' })
  })

  // FR-17: the server refuses the Undo of a change once a later write changed the series.
  it.each(seconds)('takes the undo of an earlier change away as soon as %s starts', async (_, start) => {
    // The second write's answer never comes: the Undo is gone before it.
    const { wrap, writes } = setup(
      jsonResponse(200, { ...series, etag: '"2"', title: 'Water the roses', undoToken: 'tok' }),
      new Promise<Response>(() => undefined),
    )
    const { result } = renderHook(useScopeWrites, { wrapper: wrap })

    act(() => {
      result.current.update.mutate({
        todo: series,
        input: todoToInput(series, { title: 'Water the roses' }),
        look: { slots: taskGlyphSlots('all', 'current') },
      })
    })
    await waitFor(() => {
      expect(seriesToastAction('t2')?.label).toBe('Undo')
    })

    act(() => {
      start(result.current)
    })
    await waitFor(() => {
      expect(writes()).toHaveLength(2)
    })
    expect(toast.getToasts().some((x) => x.id === 'series:t2')).toBe(true)
    expect(seriesToastAction('t2')).toBeUndefined()
  })

  it.each(firsts)('marks the series busy while %s', async (_, write, reply) => {
    let answer: (r: Response) => void = () => undefined
    const { wrap } = setup(new Promise<Response>((resolve) => (answer = resolve)))
    const { result } = renderHook(() => ({ writes: useScopeWrites(), pending: usePendingSeries() }), { wrapper: wrap })
    expect(result.current.pending.size).toBe(0)

    act(() => {
      write(result.current.writes)
    })
    await waitFor(() => {
      expect([...result.current.pending]).toEqual(['t2'])
    })

    answer(reply())
    await waitFor(() => {
      expect(result.current.pending.size).toBe(0)
    })
  })
})

describe('useDeleteTodos', () => {
  const a = todo({ id: 'a', calendarId: 'c1', etag: '"1"', title: 'A', status: 'COMPLETED' })
  const b = todo({ id: 'b', calendarId: 'c1', etag: '"7"', title: 'B', status: 'COMPLETED' })
  const c = todo({ id: 'c', calendarId: 'c1', etag: '"3"', title: 'C', status: 'COMPLETED' })
  const open = todo({ id: 'o', calendarId: 'c1', title: 'Open' })

  /** A client holding the tasks; `respond` answers each request, in order. */
  function setup(respond: (id: string, call: number) => Response | Promise<Response>) {
    api.setCsrfToken('tok')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData<TodoList>(queryKeys.todos('c1'), { todos: [a, b, c, open], corrupted: [] })
    let calls = 0
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      calls += 1
      return Promise.resolve(respond(urlOf(input).split('/').at(-1) ?? '', calls))
    })
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useDeleteTodos(), { wrapper: wrap })
    const ids = () => queryClient.getQueryData<TodoList>(queryKeys.todos('c1'))?.todos.map((x) => x.id)
    const requested = () => fetch.mock.calls.map(([url, init]) => `${init?.method} ${urlOf(url)}`)
    return { fetch, result, ids, requested }
  }

  const deleted = () => new Response(null, { status: 204 })
  const failure = (status: number, code: string, headers: Record<string, string> = {}) =>
    jsonResponse(status, { error: { code, message: code } }, headers)

  it('deletes the tasks one after another, each with its own ETag', async () => {
    const answers: ((r: Response) => void)[] = []
    const success = vi.spyOn(toast, 'success')
    const { fetch, result, ids } = setup(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve)
        }),
    )

    act(() => {
      result.current.mutate([a, b])
    })
    await waitFor(() => {
      expect(answers).toHaveLength(1)
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(urlOf(url)).toBe('/api/v1/todos/a')
    expect(init?.method).toBe('DELETE')
    expect((init?.headers as Record<string, string>)['If-Match']).toBe('"1"')

    answers[0]?.(deleted())
    await waitFor(() => {
      expect(answers).toHaveLength(2)
    })
    // The list shrinks as the tasks go.
    expect(ids()).toEqual(['b', 'c', 'o'])
    const [url2, init2] = fetch.mock.calls[1]!
    expect(urlOf(url2)).toBe('/api/v1/todos/b')
    expect((init2?.headers as Record<string, string>)['If-Match']).toBe('"7"')

    answers[1]?.(deleted())
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(ids()).toEqual(['c', 'o'])
    expect(success).toHaveBeenCalledWith('2 tasks deleted')
  })

  it('waits out the rate limit and tries the same task again', async () => {
    const sent: number[] = []
    const { result, requested } = setup((_id, call) => {
      sent.push(Date.now())
      return call === 1 ? failure(429, 'rate_limited', { 'Retry-After': '1' }) : deleted()
    })

    act(() => {
      result.current.mutate([a, b])
    })
    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true)
      },
      { timeout: 3000 },
    )
    expect(requested()).toEqual(['DELETE /api/v1/todos/a', 'DELETE /api/v1/todos/a', 'DELETE /api/v1/todos/b'])
    expect(sent[1]! - sent[0]!).toBeGreaterThanOrEqual(1000)
  })

  it('counts a task already gone as deleted, and keeps one changed elsewhere', async () => {
    const success = vi.spyOn(toast, 'success')
    const warning = vi.spyOn(toast, 'warning')
    const { result, ids, requested } = setup((id) => {
      if (id === 'a') return failure(404, 'not_found')
      if (id === 'b') return failure(412, 'conflict')
      return deleted()
    })

    act(() => {
      result.current.mutate([a, b, c])
    })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(requested()).toEqual(['DELETE /api/v1/todos/a', 'DELETE /api/v1/todos/b', 'DELETE /api/v1/todos/c'])
    expect(ids()).toEqual(['b', 'o'])
    expect(success).toHaveBeenCalledWith('2 tasks deleted')
    expect(warning).toHaveBeenCalledTimes(1)
  })

  it('stops at an error that would fail every other task too', async () => {
    const success = vi.spyOn(toast, 'success')
    const error = vi.spyOn(toast, 'error')
    const { result, ids, requested } = setup((id) => (id === 'b' ? failure(502, 'upstream_error') : deleted()))

    act(() => {
      result.current.mutate([a, b, c])
    })
    await waitFor(() => {
      expect(error).toHaveBeenCalledTimes(1)
    })
    expect(requested()).toEqual(['DELETE /api/v1/todos/a', 'DELETE /api/v1/todos/b'])
    expect(ids()).toEqual(['b', 'c', 'o'])
    expect(success).toHaveBeenCalledWith('Task deleted')
  })
})
