import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api/client'
import { type TodoList } from '@/lib/api/endpoints'
import { type Todo } from '@/lib/api/schemas'
import { todoToInput } from '@/lib/tasks'
import { bodyOf, calendar, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { defaultSettings, useSettings } from '@/stores/settings'
import { queryKeys, useCalendarTasks, useTodos, useUpdateTodo } from './queries'

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
      expect(result.current.map((x) => x.key)).toEqual(['task:t-a'])
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
      expect(result.current.map((x) => x.key)).toEqual(['task:in'])
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
        expect(result.current.map((x) => x.key)).toEqual(['task:open', 'task:done', 'task:cancelled'])
      })
    })

    it('are hidden, like cancelled ones, when the setting is on', async () => {
      serveTodos()
      useSettings.setState({ hideCompletedInCalendar: true })

      const { result } = renderHook(() => useCalendarTasks(range), { wrapper })

      await waitFor(() => {
        expect(result.current.map((x) => x.key)).toEqual(['task:open'])
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
