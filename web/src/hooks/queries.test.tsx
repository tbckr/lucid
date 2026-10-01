import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { type MouseEvent, type ReactNode } from 'react'
import { toast, type Action } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api/client'
import { endpoints, type TodoList } from '@/lib/api/endpoints'
import { type RestoredTodo, type Todo, type UpdatedTodo } from '@/lib/api/schemas'
import { todoToInput } from '@/lib/tasks'
import { bodyOf, calendar, jsonResponse, occurrence, todo, urlOf } from '@/test/fixtures'
import { defaultSettings, useSettings } from '@/stores/settings'
import {
  queryKeys,
  useCalendarTasks,
  useDeleteTodo,
  useDeleteTodos,
  usePendingSeries,
  useTodos,
  useUpdateTodo,
} from './queries'

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

afterEach(() => {
  useSettings.setState(defaultSettings)
})

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
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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

  /** The toast `toast.success` showed with `message`: how long it stays, and its action. */
  function toastOf(calls: Parameters<typeof toast.success>[], message: string) {
    const options = calls.find(([m]) => m === message)?.[1]
    const action = options?.action as Action | undefined
    return {
      duration: options?.duration,
      action: action?.label,
      click: () => {
        action?.onClick({} as MouseEvent<HTMLButtonElement>)
      },
    }
  }

  /** The current `Undo` action of the live toast `series:<todoId>`, sonner's own state (A-26 dedup). */
  function seriesToastAction(todoId: string): Action | undefined {
    const entry = toast.getToasts().find((x) => x.id === `series:${todoId}`)
    if (!entry || !('action' in entry)) return undefined
    return entry.action as Action | undefined
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
    expect(toastOf(success.mock.calls, 'Moved to Wed, Oct 7. Then: Thu, Oct 8')).toMatchObject({
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

  it('says nothing about other edits of a series', async () => {
    const success = vi.spyOn(toast, 'success')
    const { result } = setup([{ ...series, etag: '"2"', title: 'Water the garden' }])

    act(() => {
      // The editor writes the same dates in its own way.
      result.current.mutate({
        todo: series,
        input: todoToInput(series, { title: 'Water the garden', due: '2026-10-05T00:00:00.000Z' }),
      })
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
