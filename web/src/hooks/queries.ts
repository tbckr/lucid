import {
  keepPreviousData,
  useMutation,
  useMutationState,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { usePrefs } from '@/hooks/usePrefs'
import { isApiError } from '@/lib/api/client'
import { endpoints, type EventList, type TodoList, type TodoOccurrenceList } from '@/lib/api/endpoints'
import {
  type Calendar,
  type CorruptedItem,
  type EventInput,
  type Todo,
  type TodoInput,
  type TodoOccurrence,
  type UpdatedTodo,
} from '@/lib/api/schemas'
import { anchorOf, occurrenceTask, toCalTask, type CalTask } from '@/lib/calendarTasks'
import { apiErrorMessage } from '@/lib/errors'
import { fetchRange, type DateRange } from '@/lib/dates'
import { overlapsRange, toCalEvent, type CalEvent } from '@/lib/events'
import { formatPickerDate, type FormatPrefs } from '@/lib/format'
import { datesChanged, isDone, isSeriesCompletion, ruleChanged, todoToInput } from '@/lib/tasks'
import { useSettings } from '@/stores/settings'

export const queryKeys = {
  session: ['session'] as const,
  calendars: ['calendars'] as const,
  eventsAll: ['events'] as const,
  eventsOf: (calendarId: string) => ['events', calendarId] as const,
  events: (calendarId: string, start: string, end: string) => ['events', calendarId, start, end] as const,
  todosAll: ['todos'] as const,
  todos: (calendarId: string) => ['todos', calendarId] as const,
  /** Under `todos(calendarId)`, so whatever reloads a task list reloads its occurrences too (FR-17). */
  todoOccurrences: (calendarId: string, start: string, end: string) =>
    ['todos', calendarId, 'occurrences', start, end] as const,
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

/** The loaded todos; module-level so `useQueries` reruns it only on new data. */
function combineTodos(results: { data?: TodoList | undefined }[]): Todo[] {
  return results.flatMap((r) => r.data?.todos ?? [])
}

interface OccurrencesResult {
  occurrences: TodoOccurrence[]
  corrupted: CorruptedItem[]
  errors: unknown[]
}

/** The loaded occurrences, broken ones and failed loads; module-level like `combineTodos`. */
function combineOccurrences(results: { data?: TodoOccurrenceList | undefined; error: unknown }[]): OccurrencesResult {
  const occurrences: TodoOccurrence[] = []
  const corrupted: CorruptedItem[] = []
  const errors: unknown[] = []
  for (const r of results) {
    if (r.data) {
      occurrences.push(...r.data.occurrences)
      corrupted.push(...r.data.corrupted)
    }
    if (r.error) errors.push(r.error)
  }
  return { occurrences, corrupted, errors }
}

/** Whether the views show `todo` by its occurrences instead of by its own dates (FR-17). */
function placedByOccurrences(todo: Todo): boolean {
  return todo.recurring && !todo.ruleUnsupported && !isDone(todo)
}

/**
 * The calendar entries of `todos` (FR-16, FR-17): a task by its own dates, an
 * open series Lucid can read by its occurrences, each carrying the series.
 * Occurrences of a series the list doesn't hold (yet) are left out, so no
 * task shows both ways.
 */
function joinCalendarTasks(todos: Todo[], occurrences: TodoOccurrence[]): CalTask[] {
  const series = new Map<string, Todo>()
  const tasks: CalTask[] = []
  for (const todo of todos) {
    if (placedByOccurrences(todo)) {
      series.set(todo.id, todo)
      continue
    }
    const task = toCalTask(todo)
    if (task) tasks.push(task)
  }
  for (const occ of occurrences) {
    const todo = series.get(occ.todoId)
    const task = todo ? occurrenceTask(occ, todo) : null
    if (task) tasks.push(task)
  }
  return tasks
}

/** Whether an entry counts as completed: a done task, or an occurrence another app completed (FR-17). */
function isDoneTask(task: CalTask): boolean {
  return isDone(task.todo) || task.occurrence?.state === 'done'
}

export interface CalendarTasksResult {
  /** In order of their start. */
  tasks: CalTask[]
  /** Occurrences that failed validation, shown as placeholders like events. */
  corrupted: CorruptedItem[]
  /** Failed loads of occurrences; the tasks list reports its own. */
  errors: unknown[]
}

/**
 * Tasks of visible todo calendars as calendar entries within `range` (FR-05,
 * FR-16, FR-17), without done ones if the user hides them there. Shares its
 * list queries with `useTodos`, so the task list and the views update
 * together; recurring tasks come from their occurrences in the range, padded
 * like events so an all-day occurrence on an edge day isn't lost to the
 * UTC offset.
 */
export function useCalendarTasks(range: DateRange): CalendarTasksResult {
  const { visible } = useVisibleCalendars()
  const hideCompleted = useSettings((s) => s.hideCompletedInCalendar)
  const todoCalendars = visible.filter((c) => c.supportsTodos)
  const padded = fetchRange(range)
  const start = padded.start.toISOString()
  const end = padded.end.toISOString()
  const todos = useQueries({
    queries: todoCalendars.map((c) => ({
      queryKey: queryKeys.todos(c.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => endpoints.listTodos(c.id, signal),
    })),
    combine: combineTodos,
  })
  const occurrences = useQueries({
    queries: todoCalendars.map((c) => ({
      queryKey: queryKeys.todoOccurrences(c.id, start, end),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        endpoints.listTodoOccurrences(c.id, padded.start, padded.end, signal),
      placeholderData: keepPreviousData,
    })),
    combine: combineOccurrences,
  })
  const all = useMemo(() => joinCalendarTasks(todos, occurrences.occurrences), [todos, occurrences.occurrences])
  return useMemo(
    () => ({
      tasks: all
        .filter((t) => (!hideCompleted || !isDoneTask(t)) && overlapsRange(t, range))
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
      corrupted: occurrences.corrupted,
      errors: occurrences.errors,
    }),
    [all, occurrences.corrupted, occurrences.errors, range, hideCompleted],
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

/** Notes that the client's own update of task `id` replaced ETag `from` with `to`. */
function replaceEtag(qc: QueryClient, id: string, from: string, to: string): void {
  const map = ownEtagsOf(qc)
  map.set(`${id} ${from}`, to)
  map.delete(`${id} ${to}`)
}

/**
 * Puts a task as the API answered an update into its list in the cache. A
 * completed series brings the copy of the occurrence it completed (FR-17).
 */
function putTodo(qc: QueryClient, calendarId: string, { completedCopy, ...todo }: UpdatedTodo): void {
  qc.setQueryData<TodoList>(queryKeys.todos(calendarId), (old) => {
    if (!old) return old
    const todos = old.todos.filter((x) => x.id !== completedCopy?.id).map((x) => (x.id === todo.id ? todo : x))
    return { ...old, todos: completedCopy ? [...todos, completedCopy] : todos }
  })
}

/** Takes a deleted task out of its list in the cache. */
function removeTodo(qc: QueryClient, todo: Todo): void {
  qc.setQueryData<TodoList>(queryKeys.todos(todo.calendarId), (old) =>
    old ? { ...old, todos: old.todos.filter((x) => x.id !== todo.id) } : old,
  )
}

export const UPDATE_TODO_KEY = ['updateTodo'] as const

/** How long a toast with an action stays, so there is time to reach the action. */
const ACTION_TOAST_MS = 8000

interface UpdateTodoVars {
  todo: Todo
  input: TodoInput
}

/**
 * What the toast after an update of a series says, or null for an update that
 * neither completes nor moves one (FR-17): the day the series goes on with,
 * and after a move also the one after it.
 */
function seriesMessage(
  { todo, input }: UpdateTodoVars,
  updated: UpdatedTodo,
  t: TFn,
  prefs: FormatPrefs,
  now: Date,
): string | null {
  const day = (d: Date) => formatPickerDate(d, prefs, now)
  if (isSeriesCompletion(todo, input)) {
    const next = updated.completedCopy ? anchorOf(updated) : null
    return next ? t('tasks.nextUp', { date: day(next) }) : t('tasks.lastRepeat')
  }
  // A new or removed rule starts the series over from its dates: undo could not bring the old rule back.
  if (!todo.recurring || !datesChanged(todo, input) || ruleChanged(todo, input)) return null
  const moved = anchorOf(input)
  if (!moved) return null
  const next =
    updated.next &&
    anchorOf({
      start: updated.next.start,
      startAllDay: updated.startAllDay,
      due: updated.next.due,
      dueAllDay: updated.dueAllDay,
    })
  return next
    ? t('tasks.movedTo', { date: day(moved), next: day(next) })
    : t('tasks.movedToLast', { date: day(moved) })
}

/**
 * Takes back the completion or move of a series (FR-17). There is no undo
 * endpoint: the series gets its dates, status and checklist from `before`
 * again, without `rrule`, which keeps the rule. The undo of a `completion`
 * says so, since the completion moved nothing that refers to later repeats
 * and the series' end, and moving back must not shift them either; a move
 * is undone by moving back, which shifts them back. Only then the completed
 * copy goes, so a failure never loses the completion; one already gone
 * counts as deleted. `after` is the update's answer, whose ETag the client
 * may have replaced since.
 */
async function undoSeriesChange(
  qc: QueryClient,
  t: TFn,
  before: Todo,
  after: UpdatedTodo,
  completion: boolean,
): Promise<void> {
  const key = queryKeys.todos(before.calendarId)
  try {
    const etag = currentEtag(qc, after)
    const input = todoToInput(before, completion ? { undoCompletion: true } : {})
    const restored = await endpoints.updateTodo(before.id, etag, input)
    replaceEtag(qc, before.id, etag, restored.etag)
    putTodo(qc, before.calendarId, restored)
    const copy = after.completedCopy
    if (copy) {
      try {
        await endpoints.deleteTodo(copy.id, currentEtag(qc, copy))
      } catch (err) {
        if (!isApiError(err, 'not_found')) throw err
      }
      removeTodo(qc, copy)
    }
    toast.success(t('tasks.undone'))
  } catch (err) {
    reportMutationError(err, t, qc, key)
  } finally {
    await qc.invalidateQueries({ queryKey: key })
  }
}

/**
 * Updates a task and shows the change at once (NFR-26). With the task's `id`,
 * its updates run one after another, so the title field, the check and the
 * due date of one row never conflict with each other.
 *
 * Completing a series moves it on to its next occurrence instead (FR-17):
 * the list keeps it until the server answers with the moved series and the
 * completed copy. Completing or moving a series says where it goes on, with
 * an Undo, for every caller alike.
 */
export function useUpdateTodo(id?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const prefs = usePrefs()
  return useMutation({
    mutationKey: UPDATE_TODO_KEY,
    ...(id ? { scope: { id: `todo:${id}` } } : {}),
    mutationFn: async ({ todo, input }: UpdateTodoVars) => {
      const etag = currentEtag(qc, todo)
      const updated = await endpoints.updateTodo(todo.id, etag, input)
      replaceEtag(qc, todo.id, etag, updated.etag)
      return updated
    },
    onMutate: async ({ todo, input }) => {
      const key = queryKeys.todos(todo.calendarId)
      await qc.cancelQueries({ queryKey: key })
      if (isSeriesCompletion(todo, input)) return { snapshot: undefined }
      const snapshot = qc.getQueryData<TodoList>(key)
      qc.setQueryData<TodoList>(key, (old) =>
        old ? { ...old, todos: old.todos.map((x) => (x.id === todo.id ? { ...x, ...input } : x)) } : old,
      )
      return { snapshot }
    },
    onSuccess: (updated, vars) => {
      const { todo, input } = vars
      putTodo(qc, todo.calendarId, updated)
      // `now` only decides whether the date needs its year.
      const message = seriesMessage(vars, updated, t, prefs, new Date())
      if (!message) return
      const completion = isSeriesCompletion(todo, input)
      toast.success(message, {
        duration: ACTION_TOAST_MS,
        action: {
          label: t('common.undo'),
          onClick: () => {
            void undoSeriesChange(qc, t, todo, updated, completion)
          },
        },
      })
    },
    onError: (err, { todo }, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(queryKeys.todos(todo.calendarId), ctx.snapshot)
      reportMutationError(err, t, qc, queryKeys.todos(todo.calendarId))
    },
    onSettled: (_d, _e, { todo }) => qc.invalidateQueries({ queryKey: queryKeys.todos(todo.calendarId) }),
  })
}

/**
 * IDs of the recurring tasks with an update on its way (FR-17): their
 * occurrences only move once the server has answered and they are reloaded.
 */
export function usePendingSeries(): ReadonlySet<string> {
  const ids = useMutationState({
    filters: { mutationKey: UPDATE_TODO_KEY, status: 'pending' },
    select: (m) => {
      const todo = (m.state.variables as UpdateTodoVars | undefined)?.todo
      return todo?.recurring ? todo.id : null
    },
  })
  return useMemo(() => new Set(ids.filter((x) => x !== null)), [ids])
}

/**
 * Deletes a task. With the task's `id`, it waits for the updates of that task
 * still on their way, so a task checked and deleted at once does not conflict
 * with its own check.
 */
export function useDeleteTodo(id?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  return useMutation({
    ...(id ? { scope: { id: `todo:${id}` } } : {}),
    mutationFn: (todo: Todo) => endpoints.deleteTodo(todo.id, currentEtag(qc, todo)),
    onSuccess: (_d, todo) => {
      toast.success(t('tasks.deleted'))
      removeTodo(qc, todo)
    },
    onError: (err, todo) => {
      reportMutationError(err, t, qc, queryKeys.todos(todo.calendarId))
    },
    onSettled: (_d, _e, todo) => qc.invalidateQueries({ queryKey: queryKeys.todos(todo.calendarId) }),
  })
}

/** How often a task is tried while the API keeps limiting the rate. */
const RATE_LIMITED_TRIES = 3

/** Deletes a task, waiting out the API's rate limit as its Retry-After asks. */
async function deleteWithinRateLimit(todo: Todo, etag: string): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      await endpoints.deleteTodo(todo.id, etag)
      return
    } catch (err) {
      if (!isApiError(err, 'rate_limited') || tries === RATE_LIMITED_TRIES) throw err
      const wait = (err.retryAfter ?? 1) * 1000
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

/**
 * Deletes tasks one after another, like the completed ones of a list (FR-15):
 * sent all at once, a long list would run into the API's rate limit. Each task
 * leaves the list as it goes. A task already gone counts as deleted, one
 * changed elsewhere stays; any other error stops, as it would fail the rest too.
 */
export function useDeleteTodos() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  return useMutation({
    mutationFn: async (todos: Todo[]) => {
      let deleted = 0
      let failure: unknown = null
      for (const todo of todos) {
        try {
          await deleteWithinRateLimit(todo, currentEtag(qc, todo))
        } catch (err) {
          if (!isApiError(err, 'not_found')) {
            failure ??= err
            if (isApiError(err, 'conflict')) continue
            break
          }
        }
        deleted += 1
        removeTodo(qc, todo)
      }
      return { deleted, failure }
    },
    onSuccess: ({ deleted, failure }) => {
      if (deleted > 0) toast.success(t('tasks.deletedCount', { count: deleted }))
      if (failure !== null) reportMutationError(failure, t, qc, queryKeys.todosAll)
    },
    onSettled: (_d, _e, todos) =>
      Promise.all(
        [...new Set(todos.map((x) => x.calendarId))].map((id) => qc.invalidateQueries({ queryKey: queryKeys.todos(id) })),
      ),
  })
}
