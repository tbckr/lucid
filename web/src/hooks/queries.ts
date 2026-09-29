import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isApiError } from '@/lib/api/client'
import { endpoints, type EventList, type TodoList } from '@/lib/api/endpoints'
import { type Calendar, type CorruptedItem, type EventInput, type Todo, type TodoInput } from '@/lib/api/schemas'
import { toCalTask, type CalTask } from '@/lib/calendarTasks'
import { apiErrorMessage } from '@/lib/errors'
import { fetchRange, type DateRange } from '@/lib/dates'
import { overlapsRange, toCalEvent, type CalEvent } from '@/lib/events'
import { isDone } from '@/lib/tasks'
import { useSettings } from '@/stores/settings'

export const queryKeys = {
  session: ['session'] as const,
  calendars: ['calendars'] as const,
  eventsAll: ['events'] as const,
  eventsOf: (calendarId: string) => ['events', calendarId] as const,
  events: (calendarId: string, start: string, end: string) => ['events', calendarId, start, end] as const,
  todosAll: ['todos'] as const,
  todos: (calendarId: string) => ['todos', calendarId] as const,
}

/* ------------------------------------------------------------------------ */
/* Queries                                                                  */
/* ------------------------------------------------------------------------ */

export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => endpoints.getSession(signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  })
}

export function useCalendars(enabled = true) {
  return useQuery({
    queryKey: queryKeys.calendars,
    queryFn: ({ signal }) => endpoints.listCalendars(signal),
    staleTime: 5 * 60_000,
    enabled,
  })
}

/** Calendars with events that are not hidden in the sidebar. */
export function useVisibleCalendars(): { all: Calendar[]; visible: Calendar[]; byId: Map<string, Calendar> } {
  const { data = [] } = useCalendars()
  const hidden = useSettings((s) => s.hiddenCalendars)
  return useMemo(() => {
    const byId = new Map(data.map((c) => [c.id, c]))
    return { all: data, visible: data.filter((c) => !hidden.includes(c.id)), byId }
  }, [data, hidden])
}

export interface EventsResult {
  events: CalEvent[]
  corrupted: CorruptedItem[]
  isLoading: boolean
  isFetching: boolean
  errors: unknown[]
}

/** Events of all visible event calendars covering `range` (hidden calendars are not fetched). */
export function useEvents(range: DateRange): EventsResult {
  const { visible } = useVisibleCalendars()
  const eventCalendars = visible.filter((c) => c.supportsEvents)
  const padded = fetchRange(range)
  const start = padded.start.toISOString()
  const end = padded.end.toISOString()

  return useQueries({
    queries: eventCalendars.map((c) => ({
      queryKey: queryKeys.events(c.id, start, end),
      queryFn: ({ signal }: { signal: AbortSignal }) => endpoints.listEvents(c.id, padded.start, padded.end, signal),
      placeholderData: keepPreviousData,
    })),
    combine: (results) => {
      const events: CalEvent[] = []
      const corrupted: CorruptedItem[] = []
      const errors: unknown[] = []
      for (const r of results) {
        if (r.data) {
          for (const e of r.data.events) events.push(toCalEvent(e))
          corrupted.push(...r.data.corrupted)
        }
        if (r.error) errors.push(r.error)
      }
      return {
        events,
        corrupted,
        errors,
        isLoading: results.some((r) => r.isLoading),
        isFetching: results.some((r) => r.isFetching),
      }
    },
  })
}

export interface TodosResult {
  groups: { calendar: Calendar; todos: Todo[]; corrupted: CorruptedItem[] }[]
  isLoading: boolean
}

/** Tasks of all todo calendars: the sidebar toggles only hide events (FR-05), not tasks. */
export function useTodos(): TodosResult {
  const { data: calendars = [] } = useCalendars()
  const todoCalendars = calendars.filter((c) => c.supportsTodos)
  return useQueries({
    queries: todoCalendars.map((c) => ({
      queryKey: queryKeys.todos(c.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => endpoints.listTodos(c.id, signal),
    })),
    combine: (results) => ({
      groups: todoCalendars.map((calendar, i) => ({
        calendar,
        todos: results[i]?.data?.todos ?? [],
        corrupted: results[i]?.data?.corrupted ?? [],
      })),
      isLoading: results.some((r) => r.isLoading),
    }),
  })
}

/**
 * `todo` as the cache holds it now: a reload or an update may have replaced it
 * since it was picked, with a new ETag. Reads the cache only and never fetches.
 */
export function useCachedTodo(todo: Todo): Todo {
  const { data } = useQuery({
    queryKey: queryKeys.todos(todo.calendarId),
    queryFn: ({ signal }) => endpoints.listTodos(todo.calendarId, signal),
    enabled: false,
    select: (list) => list.todos.find((x) => x.id === todo.id),
  })
  return data ?? todo
}

/** Calendar entries of the loaded todos; module-level so `useQueries` reruns it only on new data. */
function combineCalendarTasks(results: { data?: TodoList | undefined }[]): CalTask[] {
  return results.flatMap((r) => (r.data?.todos ?? []).map(toCalTask).filter((t) => t !== null))
}

/**
 * Tasks of visible todo calendars as calendar entries within `range` (FR-05,
 * FR-16), without done ones if the user hides them there. Shares its queries
 * with `useTodos`, so the task list and the views update together.
 */
export function useCalendarTasks(range: DateRange): CalTask[] {
  const { visible } = useVisibleCalendars()
  const hideCompleted = useSettings((s) => s.hideCompletedInCalendar)
  const todoCalendars = visible.filter((c) => c.supportsTodos)
  const tasks = useQueries({
    queries: todoCalendars.map((c) => ({
      queryKey: queryKeys.todos(c.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => endpoints.listTodos(c.id, signal),
    })),
    combine: combineCalendarTasks,
  })
  return useMemo(
    () => tasks.filter((t) => (!hideCompleted || !isDone(t.todo)) && overlapsRange(t, range)),
    [tasks, range, hideCompleted],
  )
}

/* ------------------------------------------------------------------------ */
/* Error feedback                                                           */
/* ------------------------------------------------------------------------ */

type TFn = ReturnType<typeof useTranslation>['t']

/** Toast for a failed mutation; on conflict/not found the affected data is reloaded. */
export function reportMutationError(err: unknown, t: TFn, qc: QueryClient, invalidate: readonly unknown[]): void {
  if (isApiError(err, 'conflict') || isApiError(err, 'not_found')) {
    toast.warning(apiErrorMessage(t, err))
    void qc.invalidateQueries({ queryKey: invalidate })
    return
  }
  toast.error(apiErrorMessage(t, err))
}

/* ------------------------------------------------------------------------ */
/* Event mutations                                                          */
/* ------------------------------------------------------------------------ */

export function useCreateEvent() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  return useMutation({
    mutationFn: ({ calendarId, input }: { calendarId: string; input: EventInput }) =>
      endpoints.createEvent(calendarId, input),
    onSuccess: (_e, { calendarId }) => {
      toast.success(t('event.created'))
      return qc.invalidateQueries({ queryKey: queryKeys.eventsOf(calendarId) })
    },
    onError: (err, { calendarId }) => {
      reportMutationError(err, t, qc, queryKeys.eventsOf(calendarId))
    },
  })
}

export function useUpdateEvent() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  return useMutation({
    mutationFn: ({ event, input }: { event: CalEvent; input: EventInput }) =>
      endpoints.updateEvent(event.id, event.etag, input),
    onSuccess: (_e, { event }) => {
      toast.success(t('event.saved'))
      return qc.invalidateQueries({ queryKey: queryKeys.eventsOf(event.calendarId) })
    },
    onError: (err, { event }) => {
      reportMutationError(err, t, qc, queryKeys.eventsOf(event.calendarId))
    },
  })
}

export function useDeleteEvent() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  return useMutation({
    mutationFn: (event: CalEvent) => endpoints.deleteEvent(event.id, event.etag),
    onMutate: async (event) => {
      if (event.recurring) return { snapshot: [] as [readonly unknown[], EventList | undefined][] }
      const key = queryKeys.eventsOf(event.calendarId)
      await qc.cancelQueries({ queryKey: key })
      const snapshot = qc.getQueriesData<EventList>({ queryKey: key })
      qc.setQueriesData<EventList>({ queryKey: key }, (old) =>
        old ? { ...old, events: old.events.filter((e) => e.id !== event.id) } : old,
      )
      return { snapshot }
    },
    onSuccess: () => {
      toast.success(t('event.deleted'))
    },
    onError: (err, event, ctx) => {
      ctx?.snapshot.forEach(([k, data]) => qc.setQueryData(k, data))
      reportMutationError(err, t, qc, queryKeys.eventsOf(event.calendarId))
    },
    onSettled: (_d, _e, event) => qc.invalidateQueries({ queryKey: queryKeys.eventsOf(event.calendarId) }),
  })
}

export const MOVE_EVENT_KEY = ['moveEvent'] as const

export interface MoveVars {
  event: CalEvent
  start: string
  end: string
}

/** Build the PUT payload for a moved/resized event. */
export function moveInput(event: CalEvent, start: string, end: string): EventInput {
  return {
    title: event.title,
    description: event.description,
    location: event.location,
    start,
    end,
    allDay: event.allDay,
    timezone: event.timezone,
    rrule: event.rrule,
    ...(event.recurring && event.recurrenceId ? { instanceStart: event.recurrenceId } : {}),
  }
}

/**
 * Drag & drop move/resize (FR-10, NFR-26). Single events are updated
 * optimistically in every cached range and rolled back on error; recurring
 * occurrences only show a pending state and are refetched afterwards because
 * the whole series shifts.
 */
export function useMoveEvent() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  return useMutation({
    mutationKey: MOVE_EVENT_KEY,
    mutationFn: ({ event, start, end }: MoveVars) =>
      endpoints.updateEvent(event.id, event.etag, moveInput(event, start, end)),
    onMutate: async ({ event, start, end }) => {
      if (event.recurring) return { snapshot: [] as [readonly unknown[], EventList | undefined][] }
      const key = queryKeys.eventsOf(event.calendarId)
      await qc.cancelQueries({ queryKey: key })
      const snapshot = qc.getQueriesData<EventList>({ queryKey: key })
      qc.setQueriesData<EventList>({ queryKey: key }, (old) =>
        old
          ? { ...old, events: old.events.map((e) => (e.key === event.key ? { ...e, start, end } : e)) }
          : old,
      )
      return { snapshot }
    },
    onSuccess: (updated, { event }) => {
      if (!event.recurring) {
        // Keep the new ETag so a follow-up drag does not conflict.
        qc.setQueriesData<EventList>({ queryKey: queryKeys.eventsOf(event.calendarId) }, (old) =>
          old ? { ...old, events: old.events.map((e) => (e.key === event.key ? updated : e)) } : old,
        )
      }
    },
    onError: (err, { event }, ctx) => {
      ctx?.snapshot.forEach(([k, data]) => qc.setQueryData(k, data))
      reportMutationError(err, t, qc, queryKeys.eventsOf(event.calendarId))
    },
    onSettled: (_d, _e, { event }) => qc.invalidateQueries({ queryKey: queryKeys.eventsOf(event.calendarId) }),
  })
}

/* ------------------------------------------------------------------------ */
/* Todo mutations                                                           */
/* ------------------------------------------------------------------------ */

export function useCreateTodo() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  return useMutation({
    mutationFn: ({ calendarId, input }: { calendarId: string; input: TodoInput }) =>
      endpoints.createTodo(calendarId, input),
    onSuccess: (todo, { calendarId }) => {
      qc.setQueryData<TodoList>(queryKeys.todos(calendarId), (old) =>
        old ? { ...old, todos: [...old.todos, todo] } : old,
      )
      return qc.invalidateQueries({ queryKey: queryKeys.todos(calendarId) })
    },
    onError: (err, { calendarId }) => {
      reportMutationError(err, t, qc, queryKeys.todos(calendarId))
    },
  })
}

/**
 * ETags a client's own updates replaced, per task: an update computed while an
 * earlier one of the same task was in flight still carries the old ETag, and
 * must not conflict with its own predecessor. Servers may derive ETags from the
 * content, so an ETag can come back; the current one never maps anywhere.
 */
const ownEtags = new WeakMap<QueryClient, Map<string, string>>()

function ownEtagsOf(qc: QueryClient): Map<string, string> {
  let map = ownEtags.get(qc)
  if (!map) {
    map = new Map()
    ownEtags.set(qc, map)
  }
  return map
}

/** The ETag `todo` has now, after the client's own updates since it was read. */
function currentEtag(qc: QueryClient, todo: Todo): string {
  const map = ownEtagsOf(qc)
  let etag = todo.etag
  for (let next = map.get(`${todo.id} ${etag}`); next !== undefined; next = map.get(`${todo.id} ${etag}`)) etag = next
  return etag
}

/**
 * Updates a task and shows the change at once (NFR-26). With the task's `id`,
 * its updates run one after another, so the title field, the check and the
 * due date of one row never conflict with each other.
 */
export function useUpdateTodo(id?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  return useMutation({
    ...(id ? { scope: { id: `todo:${id}` } } : {}),
    mutationFn: async ({ todo, input }: { todo: Todo; input: TodoInput }) => {
      const etag = currentEtag(qc, todo)
      const updated = await endpoints.updateTodo(todo.id, etag, input)
      const map = ownEtagsOf(qc)
      map.set(`${todo.id} ${etag}`, updated.etag)
      map.delete(`${todo.id} ${updated.etag}`)
      return updated
    },
    onMutate: async ({ todo, input }) => {
      const key = queryKeys.todos(todo.calendarId)
      await qc.cancelQueries({ queryKey: key })
      const snapshot = qc.getQueryData<TodoList>(key)
      qc.setQueryData<TodoList>(key, (old) =>
        old ? { ...old, todos: old.todos.map((x) => (x.id === todo.id ? { ...x, ...input } : x)) } : old,
      )
      return { snapshot }
    },
    onSuccess: (updated, { todo }) => {
      qc.setQueryData<TodoList>(queryKeys.todos(todo.calendarId), (old) =>
        old ? { ...old, todos: old.todos.map((x) => (x.id === todo.id ? updated : x)) } : old,
      )
    },
    onError: (err, { todo }, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(queryKeys.todos(todo.calendarId), ctx.snapshot)
      reportMutationError(err, t, qc, queryKeys.todos(todo.calendarId))
    },
    onSettled: (_d, _e, { todo }) => qc.invalidateQueries({ queryKey: queryKeys.todos(todo.calendarId) }),
  })
}

export function useDeleteTodo() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  return useMutation({
    mutationFn: (todo: Todo) => endpoints.deleteTodo(todo.id, todo.etag),
    onSuccess: (_d, todo) => {
      toast.success(t('tasks.deleted'))
      qc.setQueryData<TodoList>(queryKeys.todos(todo.calendarId), (old) =>
        old ? { ...old, todos: old.todos.filter((x) => x.id !== todo.id) } : old,
      )
    },
    onError: (err, todo) => {
      reportMutationError(err, t, qc, queryKeys.todos(todo.calendarId))
    },
    onSettled: (_d, _e, todo) => qc.invalidateQueries({ queryKey: queryKeys.todos(todo.calendarId) }),
  })
}
