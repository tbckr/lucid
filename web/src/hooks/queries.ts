import {
  keepPreviousData,
  MutationObserver,
  useMutation,
  useMutationState,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { createElement, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ScopeGlyph } from '@/components/scope/ScopeGlyph'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { usePrefs } from '@/hooks/usePrefs'
import { isDarkNow } from '@/hooks/useTheme'
import { isApiError } from '@/lib/api/client'
import { endpoints, type EventList, type TodoList, type TodoOccurrenceList } from '@/lib/api/endpoints'
import {
  type ApiEvent,
  type Calendar,
  type CorruptedItem,
  type EventInput,
  type EventRestore,
  type Following,
  type OccurrenceInput,
  type RestoredTodo,
  type Todo,
  type TodoInput,
  type TodoOccurrence,
  type UpdatedTodo,
} from '@/lib/api/schemas'
import { anchorOf, occurrenceTask, toCalTask, type CalTask, type TaskRepeat } from '@/lib/calendarTasks'
import { eventColors, FALLBACK_COLOR } from '@/lib/color'
import { apiErrorMessage } from '@/lib/errors'
import { fetchRange, type DateRange } from '@/lib/dates'
import { overlapsRange, toCalEvent, type CalEvent } from '@/lib/events'
import { formatPickerDate, type FormatPrefs } from '@/lib/format'
import {
  followingStart,
  glyphSlots,
  taskFollowingStart,
  taskGlyphSlots,
  type GlyphSlot,
  type Scope,
} from '@/lib/scope'
import { datesChanged, isDone, isSeriesCompletion, ruleChanged } from '@/lib/tasks'
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

/**
 * The series `todo` was detached from (FR-17), by its UID among the todos of the
 * same calendar as the cache holds them, or `undefined` for a task that was never
 * a repeat, or whose series is not loaded. Reads the cache only and never fetches.
 */
export function useSeriesDetachedFrom(todo: Todo): Todo | undefined {
  const { detachedFrom } = todo
  const { data } = useQuery({
    queryKey: queryKeys.todos(todo.calendarId),
    queryFn: ({ signal }) => endpoints.listTodos(todo.calendarId, signal),
    enabled: false,
    select: (list) => (detachedFrom ? list.todos.find((x) => x.uid === detachedFrom) : undefined),
  })
  return data
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
/* Own ETags                                                                */
/* ------------------------------------------------------------------------ */

/**
 * ETags a client's own updates replaced, per resource (a task, or an event
 * with all the events of its series): an update computed while an earlier one
 * of the same resource was in flight still carries the old ETag, and must not
 * conflict with its own predecessor. Servers may derive ETags from the
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

/** The ETag `item` has now, after the client's own updates since it was read. */
function currentEtag(qc: QueryClient, item: { id: string; etag: string }): string {
  const map = ownEtagsOf(qc)
  let etag = item.etag
  for (let next = map.get(`${item.id} ${etag}`); next !== undefined; next = map.get(`${item.id} ${etag}`)) etag = next
  return etag
}

/** Notes that the client's own update of resource `id` replaced ETag `from` with `to`. */
function replaceEtag(qc: QueryClient, id: string, from: string, to: string): void {
  const map = ownEtagsOf(qc)
  map.set(`${id} ${from}`, to)
  map.delete(`${id} ${to}`)
}

/* ------------------------------------------------------------------------ */
/* The latest change of a series                                            */
/* ------------------------------------------------------------------------ */

/**
 * How many writes of each resource (a series, a task) the client started
 * (FR-17): the server refuses the Undo of a change once a later write
 * changed the resource again, so only the latest change offers one.
 */
const seriesWrites = new WeakMap<QueryClient, Map<string, number>>()

function seriesWritesOf(qc: QueryClient): Map<string, number> {
  let map = seriesWrites.get(qc)
  if (!map) {
    map = new Map()
    seriesWrites.set(qc, map)
  }
  return map
}

/** The ID of the toast about the latest change of the series or task `id`, so a later change replaces it. */
function seriesToastId(id: string): string {
  return `series:${id}`
}

/**
 * The write `generation` (`startSeriesWrite`) of the old series `series` that
 * created a resource which may not stay when the write is undone.
 */
interface SplitOf {
  series: string
  generation: number
}

/**
 * The write that created each resource which may not stay when the write is
 * undone, by the resource's ID (FR-17): the new series of a split, or the
 * task a detach made of a series' current repeat. The server refuses the
 * Undo of the write once that resource changed, which the restored old series
 * would otherwise list a second time.
 */
const splits = new WeakMap<QueryClient, Map<string, SplitOf>>()

function splitsOf(qc: QueryClient): Map<string, SplitOf> {
  let map = splits.get(qc)
  if (!map) {
    map = new Map()
    splits.set(qc, map)
  }
  return map
}

/**
 * Notes that the write `generation` of the series `seriesId`, an event's or a
 * task's, created `newId`, a resource that may not stay when the write is
 * undone (FR-17): the new series of a split, or the task a detach made of the
 * current repeat. A write of it takes the Undo of the write away
 * (`startSeriesWrite`), as the server would refuse that Undo. An answer of
 * the same series is no split: the server changed the whole series, at what
 * is its first event or current repeat by now.
 */
function noteSplit(qc: QueryClient, seriesId: string, newId: string, generation: number): void {
  if (newId !== seriesId) splitsOf(qc).set(newId, { series: seriesId, generation })
}

/**
 * Notes that a write of the series or task `id` starts, in `onMutate`, and
 * returns its generation (FR-17). A toast of an earlier change still shown
 * stays, but loses its Undo in place: dismissed, sonner 2.0.8 would also
 * remove a toast of the same ID shown within its next two animation frames,
 * as this write's own toast is when the server answers fast. A write of the
 * new series of a split, or of the task a detach made, counts as one of the
 * old series too while the split or the detach is the old series' latest
 * write, as it makes that write's Undo fail (`noteSplit`); a later change of
 * the old series keeps its own Undo.
 */
function startSeriesWrite(qc: QueryClient, id: string): number {
  const split = splitsOf(qc).get(id)
  if (split && isLatestWrite(qc, split.series, split.generation)) startSeriesWrite(qc, split.series)
  const map = seriesWritesOf(qc)
  const generation = (map.get(id) ?? 0) + 1
  map.set(id, generation)
  const toastId = seriesToastId(id)
  const shown = toast.getToasts().find((x) => x.id === toastId)
  // Merged into the toast shown, which keeps its icon and duration; sonner 2.0.8 starts its countdown over.
  if (shown && 'title' in shown) toast.success(shown.title, { id: toastId, action: undefined })
  return generation
}

/** Whether `generation` is the latest write of the series or task `id` the client started (FR-17). */
function isLatestWrite(qc: QueryClient, id: string, generation: number): boolean {
  return generation === (seriesWritesOf(qc).get(id) ?? 0)
}

/**
 * The undo token of the answer to the write `generation` of `id`, while it is
 * still the latest one (FR-17): a write started since, even one still on its
 * way, makes the Undo fail, so it offers none.
 */
function latestUndoToken(
  qc: QueryClient,
  id: string,
  generation: number,
  token: string | null | undefined,
): string | undefined {
  return isLatestWrite(qc, id, generation) ? (token ?? undefined) : undefined
}

/* ------------------------------------------------------------------------ */
/* Event mutations                                                          */
/* ------------------------------------------------------------------------ */

/**
 * The mutation scope of the series `id` (FR-17, NFR-26): its events share
 * one resource and so one ETag, and "Only this event" is optimistic without
 * holding the others back, so its writes run one after another, each with
 * the ETag the one before got (`currentEtag`). A single event passes none.
 */
function seriesScope(id: string | undefined) {
  return id ? { scope: { id: `event:${id}` } } : {}
}

/**
 * Writes `event`'s resource with `etag`, by default the one it has now, and notes the one the
 * write gave it.
 */
async function writeEvent(
  qc: QueryClient,
  event: CalEvent,
  write: (etag: string) => Promise<ApiEvent>,
  etag = currentEtag(qc, event),
): Promise<ApiEvent> {
  const updated = await write(etag)
  replaceEtag(qc, event.id, etag, updated.etag)
  return updated
}

/**
 * The rule of the series of `event` as the newest list in the cache that holds the series has it,
 * `undefined` where none does. Lists of ranges not shown since keep what they were loaded with.
 */
function cachedRule(qc: QueryClient, event: CalEvent): string | undefined {
  let rule: string | undefined
  let loadedAt = Number.NEGATIVE_INFINITY
  for (const query of qc.getQueryCache().findAll({ queryKey: queryKeys.eventsOf(event.calendarId) })) {
    const held = (query.state.data as EventList | undefined)?.events.find((e) => e.id === event.id)
    if (held && query.state.dataUpdatedAt > loadedAt) {
      rule = held.rrule
      loadedAt = query.state.dataUpdatedAt
    }
  }
  return rule
}

/**
 * The ETag for a write that sends the rule of the series of `event` (FR-17, NFR-26), called when
 * the write runs, after the writes of the series queued before it: the one the series has now
 * (`currentEtag`), unless the cache holds the series with another rule than `event` was read
 * with. The series then has left the view the write was made from, as after a split or an end
 * before an event queued ahead of it: the write would send the rule back as the view had it, and
 * the server would take that for a new rule, undoing the end. It goes with the ETag `event` was
 * read with instead, which the series no longer has, so the server refuses it as a conflict and
 * the calendar reloads.
 */
function ruleWriteEtag(qc: QueryClient, event: CalEvent): string {
  const rule = cachedRule(qc, event)
  return rule !== undefined && rule !== event.rrule ? event.etag : currentEtag(qc, event)
}

/** How long a toast with an action stays, so there is time to reach the action. */
const ACTION_TOAST_MS = 8000

export const UNDO_EVENT_KEY = ['undoEvent'] as const

/**
 * Takes back a change of a series using the server's undo token (FR-17): an
 * exact restore of the snapshot the change had read. Run through a
 * `MutationObserver` sharing `UNDO_EVENT_KEY` and the series' scope, so the
 * series shows busy meanwhile, and the undo waits for the writes ahead of it
 * and holds back the ones after it (NFR-26). `after` is the change's answer:
 * the series' ETag it gave, and the token. The restore's own ETag is noted
 * within the mutation, so the write queued behind it already uses it. The
 * undo of a split goes to the old series and takes the new one back too; the
 * server refuses it once the new series changed, and keeps the new series only
 * when another app changed it while the undo ran (`copyKept`).
 */
async function undoEventChange(
  qc: QueryClient,
  t: TFn,
  event: CalEvent,
  after: { etag: string; undoToken: string },
): Promise<void> {
  const key = queryKeys.eventsOf(event.calendarId)
  const observer = new MutationObserver<EventRestore, unknown, { event: CalEvent }>(qc, {
    mutationKey: UNDO_EVENT_KEY,
    ...seriesScope(event.id),
    mutationFn: async ({ event: e }) => {
      const restored = await endpoints.undoEvent(e.id, after.undoToken)
      if (restored.etag) replaceEtag(qc, e.id, currentEtag(qc, { id: e.id, etag: after.etag }), restored.etag)
      return restored
    },
  })
  try {
    const restored = await observer.mutate({ event })
    // The new series of a split stays when another app changed it while the undo ran; the old one is restored anyway.
    if (restored.copyKept) {
      toast.warning(t('scope.undoneSeriesKept'))
    } else {
      toast.success(t('scope.undone'))
    }
  } catch (err) {
    if (isApiError(err, 'not_found')) {
      toast.error(t('scope.undoGone'))
    } else if (isApiError(err, 'conflict')) {
      toast.error(t('event.undoConflict'))
    } else {
      reportMutationError(err, t, qc, key)
    }
  } finally {
    await qc.invalidateQueries({ queryKey: key })
  }
}

/**
 * Says what a change of a series did, with an Undo while the answer carries a
 * token (FR-17). `after` is this change's answer: the series' ETag it gave,
 * its undo token, and the `generation` of the write (`startSeriesWrite`). The
 * token is dropped by `latestUndoToken` once a later write started; a token on
 * `event`, or one cached with it, is from an earlier answer and never offered.
 * The ID is the series', so a later change replaces this toast and its Undo.
 * Its icon shows the events the change reached, `look.slots` (`glyphSlots`
 * of the option chosen), in the series' calendar color, or in red
 * (`look.tone`) for events deleted, as the question or the hint before the
 * change drew them.
 */
function eventToast(
  qc: QueryClient,
  t: TFn,
  event: CalEvent,
  message: string,
  after: { etag: string; undoToken?: string | null; generation: number },
  look: { slots: GlyphSlot[]; color: string; tone?: 'default' | 'destructive' },
): void {
  const { etag, generation } = after
  const undoToken = latestUndoToken(qc, event.id, generation, after.undoToken)
  toast.success(message, {
    id: seriesToastId(event.id),
    duration: ACTION_TOAST_MS,
    icon: createElement(ScopeGlyph, { slots: look.slots, color: look.color, tone: look.tone }),
    // Sonner's icon box is 16px wide; the glyph is 44px.
    classNames: { icon: 'w-auto!' },
    // Always given: sonner merges a toast into the one of its ID, which would keep the earlier Undo.
    action: undoToken
      ? {
          label: t('common.undo'),
          onClick: () => {
            void undoEventChange(qc, t, event, { etag, undoToken })
          },
        }
      : undefined,
  })
}

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

/**
 * Whether saving `input` makes the series of `event` this one event, deleting
 * the others, as the server decides (FR-17): saved without a rule, one that
 * had a rule, or whose all-day flag changed. A series of dates alone (RDATE)
 * saved as it was keeps them.
 */
function removesRule(event: CalEvent, input: EventInput): boolean {
  return !input.rrule && (event.rrule !== '' || input.allDay !== event.allDay)
}

/** Saves an event; with the `id` of its series, after the series' other writes (`seriesScope`). */
export function useUpdateEvent(series?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const colorsOf = useCalendarColors()
  return useMutation({
    ...seriesScope(series),
    mutationFn: ({ event, input }: { event: CalEvent; input: EventInput }) =>
      writeEvent(qc, event, (etag) => endpoints.updateEvent(event.id, etag, input), ruleWriteEtag(qc, event)),
    onMutate: ({ event }) => ({ generation: startSeriesWrite(qc, event.id) }),
    onSuccess: (updated, { event, input }, ctx) => {
      if (event.recurring) {
        eventToast(
          qc,
          t,
          event,
          t('scope.toast.allChanged'),
          { etag: updated.etag, undoToken: updated.undoToken, generation: ctx.generation },
          {
            slots: glyphSlots('all'),
            color: colorsOf(event.calendarId).solid,
            // Red where the series became this one event, deleting all the others.
            tone: removesRule(event, input) ? 'destructive' : 'default',
          },
        )
      } else {
        toast.success(t('event.saved'))
      }
      return qc.invalidateQueries({ queryKey: queryKeys.eventsOf(event.calendarId) })
    },
    onError: (err, { event }) => {
      reportMutationError(err, t, qc, queryKeys.eventsOf(event.calendarId))
    },
  })
}

/** Deletes an event, a series as a whole; with the `id` of its series, after the series' other writes. */
export function useDeleteEvent(series?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  return useMutation({
    ...seriesScope(series),
    mutationFn: (event: CalEvent) => endpoints.deleteEvent(event.id, currentEtag(qc, event)),
    onMutate: async (event) => {
      startSeriesWrite(qc, event.id)
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
  /** Its length was changed rather than the event moved, which the toast of a series says. */
  change?: boolean
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
 * the whole series shifts. With the `id` of a series, after its other writes.
 */
export function useMoveEvent(series?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const colorsOf = useCalendarColors()
  return useMutation({
    mutationKey: MOVE_EVENT_KEY,
    ...seriesScope(series),
    mutationFn: ({ event, start, end }: MoveVars) =>
      writeEvent(
        qc,
        event,
        (etag) => endpoints.updateEvent(event.id, etag, moveInput(event, start, end)),
        ruleWriteEtag(qc, event),
      ),
    onMutate: async ({ event, start, end }) => {
      const generation = startSeriesWrite(qc, event.id)
      if (event.recurring) return { generation, snapshot: [] as [readonly unknown[], EventList | undefined][] }
      const key = queryKeys.eventsOf(event.calendarId)
      await qc.cancelQueries({ queryKey: key })
      const snapshot = qc.getQueriesData<EventList>({ queryKey: key })
      qc.setQueriesData<EventList>({ queryKey: key }, (old) =>
        old
          ? { ...old, events: old.events.map((e) => (e.key === event.key ? { ...e, start, end } : e)) }
          : old,
      )
      return { generation, snapshot }
    },
    onSuccess: (updated, { event, change }, ctx) => {
      if (event.recurring) {
        eventToast(
          qc,
          t,
          event,
          t(change ? 'scope.toast.allChanged' : 'scope.toast.allMoved'),
          { etag: updated.etag, undoToken: updated.undoToken, generation: ctx.generation },
          { slots: glyphSlots('all'), color: colorsOf(event.calendarId).solid },
        )
      } else {
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

/** Build the PUT payload for one moved/resized occurrence of a series ("Only this event", FR-17). */
export function moveOccurrenceInput(event: CalEvent, start: string, end: string): OccurrenceInput {
  return {
    title: event.title,
    description: event.description,
    location: event.location,
    start,
    end,
    allDay: event.allDay,
    timezone: event.timezone,
  }
}

/**
 * Puts the server's answer for a changed occurrence into the cache (FR-17):
 * the edited occurrence's own `key` entry becomes the answer; every other
 * cached event sharing its `id` only gets the new ETag, since all occurrences
 * of a series share one CalDAV resource and so one ETag.
 */
function putOccurrence(qc: QueryClient, event: CalEvent, updated: ApiEvent): void {
  qc.setQueriesData<EventList>({ queryKey: queryKeys.eventsOf(event.calendarId) }, (old) =>
    old
      ? {
          ...old,
          events: old.events.map((e) =>
            e.key === event.key ? updated : e.id === event.id ? { ...e, etag: updated.etag } : e,
          ),
        }
      : old,
  )
}

/** Gives every cached event of the series of `event` the series' new ETag (FR-17), as `putOccurrence` does. */
function setSeriesEtag(qc: QueryClient, event: CalEvent, etag: string): void {
  qc.setQueriesData<EventList>({ queryKey: queryKeys.eventsOf(event.calendarId) }, (old) =>
    old ? { ...old, events: old.events.map((e) => (e.id === event.id ? { ...e, etag } : e)) } : old,
  )
}

export const MOVE_OCCURRENCE_KEY = ['moveOccurrence'] as const

/**
 * Drag & drop move/resize of a single occurrence of a series ("Only this
 * event", FR-10, FR-17, NFR-26). Updated optimistically, like a single
 * event's move, and rolled back on error; the server's new ETag is then
 * synced to every cached occurrence of the same series. With the `id` of
 * the series, after its other writes.
 */
export function useMoveOccurrence(series?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const colorsOf = useCalendarColors()
  return useMutation({
    mutationKey: MOVE_OCCURRENCE_KEY,
    ...seriesScope(series),
    mutationFn: ({ event, start, end }: MoveVars) =>
      writeEvent(qc, event, (etag) =>
        endpoints.updateOccurrence(event.id, event.recurrenceId ?? '', etag, moveOccurrenceInput(event, start, end)),
      ),
    onMutate: async ({ event, start, end }) => {
      const generation = startSeriesWrite(qc, event.id)
      const key = queryKeys.eventsOf(event.calendarId)
      await qc.cancelQueries({ queryKey: key })
      const snapshot = qc.getQueriesData<EventList>({ queryKey: key })
      qc.setQueriesData<EventList>({ queryKey: key }, (old) =>
        old ? { ...old, events: old.events.map((e) => (e.key === event.key ? { ...e, start, end } : e)) } : old,
      )
      return { generation, snapshot }
    },
    onSuccess: (updated, { event, change }, ctx) => {
      putOccurrence(qc, event, updated)
      eventToast(
        qc,
        t,
        event,
        t(change ? 'scope.toast.thisChanged' : 'scope.toast.thisMoved'),
        { etag: updated.etag, undoToken: updated.undoToken, generation: ctx.generation },
        { slots: glyphSlots('this'), color: colorsOf(event.calendarId).solid },
      )
    },
    onError: (err, { event }, ctx) => {
      ctx?.snapshot.forEach(([k, data]) => qc.setQueryData(k, data))
      reportMutationError(err, t, qc, queryKeys.eventsOf(event.calendarId))
    },
    onSettled: (_d, _e, { event }) => qc.invalidateQueries({ queryKey: queryKeys.eventsOf(event.calendarId) }),
  })
}

/**
 * Edits a single occurrence of a series ("Only this event", FR-17), with the
 * series' ETag synced like a move; with the `id` of the series, after its
 * other writes.
 */
export function useUpdateOccurrence(series?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const colorsOf = useCalendarColors()
  return useMutation({
    ...seriesScope(series),
    mutationFn: ({ event, input }: { event: CalEvent; input: OccurrenceInput }) =>
      writeEvent(qc, event, (etag) => endpoints.updateOccurrence(event.id, event.recurrenceId ?? '', etag, input)),
    onMutate: ({ event }) => ({ generation: startSeriesWrite(qc, event.id) }),
    onSuccess: (updated, { event }, ctx) => {
      putOccurrence(qc, event, updated)
      eventToast(
        qc,
        t,
        event,
        t('scope.toast.thisChanged'),
        { etag: updated.etag, undoToken: updated.undoToken, generation: ctx.generation },
        { slots: glyphSlots('this'), color: colorsOf(event.calendarId).solid },
      )
    },
    onError: (err, { event }) => {
      reportMutationError(err, t, qc, queryKeys.eventsOf(event.calendarId))
    },
    onSettled: (_d, _e, { event }) => qc.invalidateQueries({ queryKey: queryKeys.eventsOf(event.calendarId) }),
  })
}

/**
 * Excludes a single occurrence of a series ("Only this event", FR-17):
 * removed optimistically by its own `key` (NFR-26), unlike deleting a whole
 * series, which the other occurrences of the series survive. The series'
 * new ETag, which the answer carries while the series is kept, is synced
 * like a change's. With the `id` of the series, after its other writes.
 */
export function useDeleteOccurrence(series?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const colorsOf = useCalendarColors()
  return useMutation({
    ...seriesScope(series),
    mutationFn: async (event: CalEvent) => {
      const etag = currentEtag(qc, event)
      const res = await endpoints.deleteOccurrence(event.id, event.recurrenceId ?? '', etag)
      if (res) replaceEtag(qc, event.id, etag, res.etag)
      return res
    },
    onMutate: async (event) => {
      const generation = startSeriesWrite(qc, event.id)
      const key = queryKeys.eventsOf(event.calendarId)
      await qc.cancelQueries({ queryKey: key })
      const snapshot = qc.getQueriesData<EventList>({ queryKey: key })
      qc.setQueriesData<EventList>({ queryKey: key }, (old) =>
        old ? { ...old, events: old.events.filter((e) => e.key !== event.key) } : old,
      )
      return { generation, snapshot }
    },
    onSuccess: (res, event, ctx) => {
      // No answer: the series went with its last event, so there is nothing to undo.
      eventToast(
        qc,
        t,
        event,
        t('scope.toast.thisDeleted'),
        { etag: res?.etag ?? '', undoToken: res?.undoToken, generation: ctx.generation },
        { slots: glyphSlots('this'), color: colorsOf(event.calendarId).solid, tone: 'destructive' },
      )
      if (res) setSeriesEtag(qc, event, res.etag)
    },
    onError: (err, event, ctx) => {
      ctx?.snapshot.forEach(([k, data]) => qc.setQueryData(k, data))
      reportMutationError(err, t, qc, queryKeys.eventsOf(event.calendarId))
    },
    onSettled: (_d, _e, event) => qc.invalidateQueries({ queryKey: queryKeys.eventsOf(event.calendarId) }),
  })
}

/**
 * The day "this and following events" from `event` starts, as its toast names it, like the scope
 * question (`followingStart`); `now` only decides whether it needs its year.
 */
function followingDay(event: CalEvent, prefs: FormatPrefs): string {
  return formatPickerDate(followingStart(event), prefs, new Date())
}

/**
 * Splits the series of `event` at it ("This and following events", FR-17):
 * the series ends before it, and one of its own goes on from it with `input`.
 * Sent with the ETag the series has now, unless the series has left the view
 * since (`ruleWriteEtag`); the old series' new ETag, when the server told
 * one, is noted within the mutation, so a write queued behind it in the
 * series' scope already uses it (NFR-26). The event is named in the path, so
 * `instanceStart` stays out of the body.
 */
async function writeFollowing(qc: QueryClient, event: CalEvent, input: EventInput): Promise<Following> {
  const { instanceStart: _instanceStart, ...body } = input
  const etag = ruleWriteEtag(qc, event)
  const answer = await endpoints.updateFollowing(event.id, event.recurrenceId ?? '', etag, body)
  if (answer.etag) replaceEtag(qc, event.id, etag, answer.etag)
  return answer
}

/**
 * The events a split of the series of `event` reached (FR-17): the following
 * ones, or all of them when the answer's event is still of the same resource,
 * as the server changes the whole series at what is its first event by now
 * (a view not reloaded since).
 */
function splitReach(event: CalEvent, answer: Following): Scope {
  return answer.event.id === event.id ? 'all' : 'following'
}

export const MOVE_FOLLOWING_KEY = [...MOVE_EVENT_KEY, 'following'] as const

/**
 * Drag & drop move/resize of an event and the following ones of its series
 * as a series of their own (FR-10, FR-17). Not optimistic, as the series
 * splits in two: the event shows busy until both series are reloaded, since
 * `CalendarDnd` finds pending moves by `MOVE_EVENT_KEY`, which
 * `MOVE_FOLLOWING_KEY` starts with (NFR-26). The toast's Undo is the old
 * series', which takes the new one back too. With the `id` of the series,
 * after its other writes.
 */
export function useMoveFollowing(series?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const colorsOf = useCalendarColors()
  const prefs = usePrefs()
  return useMutation({
    mutationKey: MOVE_FOLLOWING_KEY,
    ...seriesScope(series),
    mutationFn: ({ event, start, end }: MoveVars) => writeFollowing(qc, event, moveInput(event, start, end)),
    onMutate: ({ event }) => ({ generation: startSeriesWrite(qc, event.id) }),
    onSuccess: (answer, { event, change }, ctx) => {
      noteSplit(qc, event.id, answer.event.id, ctx.generation)
      const reach = splitReach(event, answer)
      const date = followingDay(event, prefs)
      eventToast(
        qc,
        t,
        event,
        reach === 'all'
          ? t(change ? 'scope.toast.allChanged' : 'scope.toast.allMoved')
          : t(change ? 'scope.toast.followingChanged' : 'scope.toast.followingMoved', { date }),
        { etag: answer.etag, undoToken: answer.undoToken, generation: ctx.generation },
        { slots: glyphSlots(reach), color: colorsOf(event.calendarId).solid },
      )
    },
    onError: (err, { event }) => {
      reportMutationError(err, t, qc, queryKeys.eventsOf(event.calendarId))
    },
    onSettled: (_d, _e, { event }) => qc.invalidateQueries({ queryKey: queryKeys.eventsOf(event.calendarId) }),
  })
}

/**
 * Saves an event and the following ones of its series as a series of their
 * own (FR-17), not optimistic, like a split by a move. Saved without a rule,
 * the new series is this one event, so the toast says, in red, that the
 * series now ends before it. With the `id` of the series, after its other
 * writes.
 */
export function useUpdateFollowing(series?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const colorsOf = useCalendarColors()
  const prefs = usePrefs()
  return useMutation({
    ...seriesScope(series),
    mutationFn: ({ event, input }: { event: CalEvent; input: EventInput }) => writeFollowing(qc, event, input),
    onMutate: ({ event }) => ({ generation: startSeriesWrite(qc, event.id) }),
    onSuccess: (answer, { event, input }, ctx) => {
      noteSplit(qc, event.id, answer.event.id, ctx.generation)
      const reach = splitReach(event, answer)
      const removed = removesRule(event, input)
      const date = followingDay(event, prefs)
      eventToast(
        qc,
        t,
        event,
        reach === 'all'
          ? t('scope.toast.allChanged')
          : t(removed ? 'scope.toast.ended' : 'scope.toast.followingChanged', { date }),
        { etag: answer.etag, undoToken: answer.undoToken, generation: ctx.generation },
        { slots: glyphSlots(reach), color: colorsOf(event.calendarId).solid, tone: removed ? 'destructive' : 'default' },
      )
    },
    onError: (err, { event }) => {
      reportMutationError(err, t, qc, queryKeys.eventsOf(event.calendarId))
    },
    onSettled: (_d, _e, { event }) => qc.invalidateQueries({ queryKey: queryKeys.eventsOf(event.calendarId) }),
  })
}

/**
 * Ends the series of `event` before it ("This and following events", FR-17),
 * not optimistic, like a split. While the series is kept, the answer carries
 * its new ETag, noted within the mutation like a split's (NFR-26), and the
 * undo token. A `204` tells neither: the series went, as the event was its
 * first by now, or the server told no ETag. Either way the toast says the
 * series ends, without an Undo. With the `id` of the series, after its other
 * writes.
 */
export function useDeleteFollowing(series?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const colorsOf = useCalendarColors()
  const prefs = usePrefs()
  return useMutation({
    ...seriesScope(series),
    mutationFn: async (event: CalEvent) => {
      const etag = currentEtag(qc, event)
      const res = await endpoints.deleteFollowing(event.id, event.recurrenceId ?? '', etag)
      if (res?.etag) replaceEtag(qc, event.id, etag, res.etag)
      return res
    },
    onMutate: (event) => ({ generation: startSeriesWrite(qc, event.id) }),
    onSuccess: (res, event, ctx) => {
      eventToast(
        qc,
        t,
        event,
        t('scope.toast.ended', { date: followingDay(event, prefs) }),
        { etag: res?.etag ?? '', undoToken: res?.undoToken, generation: ctx.generation },
        { slots: glyphSlots('following'), color: colorsOf(event.calendarId).solid, tone: 'destructive' },
      )
    },
    onError: (err, event) => {
      reportMutationError(err, t, qc, queryKeys.eventsOf(event.calendarId))
    },
    onSettled: (_d, _e, event) => qc.invalidateQueries({ queryKey: queryKeys.eventsOf(event.calendarId) }),
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
 * Puts a task as the API answered a write into its list in the cache. A
 * completed series brings the copy of the occurrence it completed, a detach
 * the task it made of the current repeat (FR-17).
 */
function putTodo(qc: QueryClient, calendarId: string, { completedCopy, detachedCopy, ...todo }: UpdatedTodo): void {
  const copies = [completedCopy, detachedCopy].filter((c) => c != null)
  qc.setQueryData<TodoList>(queryKeys.todos(calendarId), (old) => {
    if (!old) return old
    const todos = old.todos
      .filter((x) => !copies.some((c) => c.id === x.id))
      .map((x) => (x.id === todo.id ? todo : x))
    return { ...old, todos: [...todos, ...copies] }
  })
}

/** Takes a deleted task out of its list in the cache. */
function removeTodo(qc: QueryClient, todo: Todo): void {
  qc.setQueryData<TodoList>(queryKeys.todos(todo.calendarId), (old) =>
    old ? { ...old, todos: old.todos.filter((x) => x.id !== todo.id) } : old,
  )
}

/**
 * The mutation scope of the task `id` (FR-17, NFR-26): the repeats of a
 * series share one resource and so one ETag, so its writes run one after
 * another, each with the ETag the one before got (`currentEtag`), and so do
 * the title field, the check and the due date of one task in the list.
 * Without an `id`, a write runs at once.
 */
function todoScope(id: string | undefined) {
  return id ? { scope: { id: `todo:${id}` } } : {}
}

/**
 * The color of the calendar `calendarId` for a task's toast (FR-17), the
 * solid one `useCalendarColors` gives, read as the toast shows: from the
 * calendars as the cache holds them, as a task is written from a view that
 * loaded them, in the theme shown then. A task hook observes neither, so the
 * many task rows that hold task hooks don't each observe, or load, them.
 */
function todoColor(qc: QueryClient, calendarId: string): string {
  const color = qc.getQueryData<Calendar[]>(queryKeys.calendars)?.find((c) => c.id === calendarId)?.color
  return eventColors(color ?? FALLBACK_COLOR, isDarkNow()).solid
}

/** A day a task toast names; `now` only decides whether it needs its year. */
function toastDay(at: Date | null, prefs: FormatPrefs): string {
  return at ? formatPickerDate(at, prefs, new Date()) : ''
}

export const UPDATE_TODO_KEY = ['updateTodo'] as const

interface UpdateTodoVars {
  todo: Todo
  input: TodoInput
  /** Set by a drag of an upcoming occurrence, which moves the series as a whole (FR-17). */
  byUpcoming?: boolean
  /**
   * The repeats "all repeats" reaches from the repeat it was chosen at
   * (`taskGlyphSlots`), drawn in the toast, in red where the change removes
   * the rule; left out for a task that asks nothing, a single one or the
   * last repeat, whose toast has no icon.
   */
  look?: { slots: GlyphSlot[] }
}

/**
 * Whether a change of the series `todo` asks which repeats it reaches (FR-17):
 * an open series Lucid can read, before its last repeat. Any other task acts
 * as a single one (`scopeOptions`).
 */
function asksScope(todo: Todo): boolean {
  return placedByOccurrences(todo) && todo.next != null
}

/**
 * What the toast after an update of a series says, or null for an update that
 * says nothing (FR-17): the day the series goes on with after a completion,
 * and after a move also the one after it. A move by an upcoming occurrence
 * says that the series moved, since the day it goes on with isn't the one
 * dragged. A new or removed rule, and a change of other fields alone, say
 * that it reached all repeats, where the user chose them or the hint said so
 * (spec §1, rule 1); a task that asked nothing says nothing.
 */
function seriesMessage(
  { todo, input, byUpcoming }: UpdateTodoVars,
  updated: UpdatedTodo,
  t: TFn,
  prefs: FormatPrefs,
): string | null {
  const day = (d: Date | null) => toastDay(d, prefs)
  if (isSeriesCompletion(todo, input)) {
    const next = updated.completedCopy ? anchorOf(updated) : null
    return next ? t('tasks.nextUp', { date: day(next) }) : t('tasks.lastRepeat')
  }
  if (!todo.recurring) return null
  // A rule reaches every repeat, whatever the dates do; the undo restores the old one from the server's snapshot.
  if (ruleChanged(todo, input) || !datesChanged(todo, input)) {
    return asksScope(todo) ? t('scope.toast.allRepeatsChanged') : null
  }
  const moved = anchorOf(input)
  if (!moved) return null
  if (byUpcoming) return t('tasks.seriesMoved', { date: day(moved) })
  const next =
    updated.next &&
    anchorOf({
      start: updated.next.start,
      startAllDay: updated.next.startAllDay ?? updated.startAllDay,
      due: updated.next.due,
      dueAllDay: updated.next.dueAllDay ?? updated.dueAllDay,
    })
  return next
    ? t('tasks.movedTo', { date: day(moved), next: day(next) })
    : t('tasks.movedToLast', { date: day(moved) })
}

/**
 * A task a change of a series created, which its undo takes back (FR-17), and
 * what it is: the `completed` copy of a repeat, a task `detached` from the
 * series, made of a repeat by a detach or by a split that removed the rule,
 * or the new `series` of a split.
 */
interface CreatedTodo {
  todo: Todo
  kind: 'completed' | 'detached' | 'series'
}

/** `todo` as what a change created, `kind`, or null where it created none. */
function created(todo: Todo | null | undefined, kind: CreatedTodo['kind']): CreatedTodo | null {
  return todo ? { todo, kind } : null
}

/**
 * What an undo says when the server kept the task the change had created
 * (FR-17), as another app changed it while the undo ran.
 */
function copyKeptMessage(t: TFn, kind: CreatedTodo['kind'] | undefined): string {
  switch (kind) {
    case 'detached':
      return t('tasks.undoneDetachedKept')
    case 'series':
      return t('scope.undoneSeriesKept')
    case 'completed':
    case undefined:
      return t('tasks.undoneCopyKept')
  }
}

/**
 * Takes back a change of the task series `series` using the server's undo
 * token (FR-17): an exact restore of the snapshot the change had read, rather
 * than a reconstruction. Run through a `MutationObserver` sharing
 * `UPDATE_TODO_KEY` and the series' scope, so `usePendingSeries` marks the
 * series busy, and the undo waits for the writes ahead of it and holds back
 * the ones after it (NFR-26). `after` is the change's answer: the series' ETag
 * it gave, the token, and the task the change `created`, which the undo takes
 * back too: the completed copy, the task a detach made, or the new series of
 * a split, whose undo goes to the old series. The restore's own ETag is noted
 * within the mutation, so the write queued behind it already uses it. What the
 * change created leaves the cache, unless the server kept it (`copyKept`).
 */
async function undoTodoChange(
  qc: QueryClient,
  t: TFn,
  series: Todo,
  after: { etag: string; undoToken: string; created?: CreatedTodo | null },
): Promise<void> {
  const key = queryKeys.todos(series.calendarId)
  const observer = new MutationObserver<RestoredTodo, unknown, { todo: Todo }>(qc, {
    mutationKey: UPDATE_TODO_KEY,
    ...todoScope(series.id),
    mutationFn: async ({ todo }) => {
      const restored = await endpoints.undoTodo(todo.id, after.undoToken)
      if (restored.etag) replaceEtag(qc, todo.id, currentEtag(qc, { id: todo.id, etag: after.etag }), restored.etag)
      return restored
    },
  })
  try {
    const { copyKept, ...restored } = await observer.mutate({ todo: series })
    putTodo(qc, series.calendarId, restored)
    if (copyKept) {
      toast.warning(copyKeptMessage(t, after.created?.kind))
    } else {
      if (after.created) removeTodo(qc, after.created.todo)
      toast.success(t('scope.undone'))
    }
  } catch (err) {
    if (isApiError(err, 'not_found')) {
      toast.error(t('scope.undoGone'))
    } else if (isApiError(err, 'conflict')) {
      toast.error(t('tasks.undoConflict'))
    } else {
      reportMutationError(err, t, qc, key)
    }
  } finally {
    await qc.invalidateQueries({ queryKey: key })
  }
}

/**
 * Says what a change of the task series `series` did, as `eventToast` says it
 * for events, with an Undo while the answer carries a token (FR-17). `after`
 * is this change's answer: the series' ETag it gave, its undo token, the
 * `generation` of the write (`startSeriesWrite`), and the task the change
 * `created`, which the Undo takes back (`undoTodoChange`). The token is dropped
 * by `latestUndoToken` once a later write started. The ID is the series', so a
 * later change replaces this toast and its Undo. Its icon shows the repeats
 * the change reached, `look.slots` (`taskGlyphSlots` of the option chosen), in
 * the series' calendar color, or in red (`look.tone`) for repeats deleted,
 * also by a removed rule; a task that asked nothing gets no `look` and no
 * icon.
 */
function todoToast(
  qc: QueryClient,
  t: TFn,
  series: Todo,
  message: string,
  after: { etag: string; undoToken?: string | null; generation: number; created?: CreatedTodo | null },
  look?: { slots: GlyphSlot[]; color: string; tone?: 'default' | 'destructive' },
): void {
  const { etag, generation } = after
  const undoToken = latestUndoToken(qc, series.id, generation, after.undoToken)
  toast.success(message, {
    id: seriesToastId(series.id),
    duration: ACTION_TOAST_MS,
    // Always given, like the action: sonner merges a toast into the one of its ID, which would keep an earlier icon.
    icon: look ? createElement(ScopeGlyph, { slots: look.slots, color: look.color, tone: look.tone }) : undefined,
    // Sonner's icon box is 16px wide; the glyph is 44px.
    classNames: look ? { icon: 'w-auto!' } : undefined,
    action: undoToken
      ? {
          label: t('common.undo'),
          onClick: () => {
            void undoTodoChange(qc, t, series, { etag, undoToken, created: after.created })
          },
        }
      : undefined,
  })
}

/**
 * Updates a task and shows the change at once (NFR-26). With the task's `id`,
 * its updates run one after another (`todoScope`), so the title field, the
 * check and the due date of one row never conflict with each other.
 *
 * Completing a series moves it on to its next occurrence instead (FR-17):
 * the list keeps it until the server answers with the moved series and the
 * completed copy. Completing, moving or otherwise changing a series that asks
 * which repeats a change reaches says what happened, with an Undo, for every
 * caller alike; "all repeats" chosen at a repeat draws its reach (`look`).
 */
export function useUpdateTodo(id?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const prefs = usePrefs()
  return useMutation({
    mutationKey: UPDATE_TODO_KEY,
    ...todoScope(id),
    mutationFn: async ({ todo, input }: UpdateTodoVars) => {
      const etag = currentEtag(qc, todo)
      const updated = await endpoints.updateTodo(todo.id, etag, input)
      replaceEtag(qc, todo.id, etag, updated.etag)
      return updated
    },
    onMutate: async ({ todo, input }) => {
      const generation = startSeriesWrite(qc, todo.id)
      const key = queryKeys.todos(todo.calendarId)
      await qc.cancelQueries({ queryKey: key })
      if (isSeriesCompletion(todo, input)) return { generation, snapshot: undefined }
      const snapshot = qc.getQueryData<TodoList>(key)
      qc.setQueryData<TodoList>(key, (old) =>
        old ? { ...old, todos: old.todos.map((x) => (x.id === todo.id ? { ...x, ...input } : x)) } : old,
      )
      return { generation, snapshot }
    },
    onSuccess: (updated, vars, ctx) => {
      const { todo, input, look } = vars
      putTodo(qc, todo.calendarId, updated)
      const message = seriesMessage(vars, updated, t, prefs)
      if (!message) return
      todoToast(
        qc,
        t,
        todo,
        message,
        {
          etag: updated.etag,
          undoToken: updated.undoToken,
          generation: ctx.generation,
          created: created(updated.completedCopy, 'completed'),
        },
        look && {
          slots: look.slots,
          color: todoColor(qc, todo.calendarId),
          // Red where the series became this one task, removing the upcoming repeats, as the hint was.
          tone: input.rrule?.trim() === '' ? 'destructive' : 'default',
        },
      )
    },
    onError: (err, { todo }, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(queryKeys.todos(todo.calendarId), ctx.snapshot)
      reportMutationError(err, t, qc, queryKeys.todos(todo.calendarId))
    },
    onSettled: (_d, _e, { todo }) => qc.invalidateQueries({ queryKey: queryKeys.todos(todo.calendarId) }),
  })
}

/**
 * A write to the open repeat `repeat` of the task series `todo` (FR-17),
 * which names it by its RECURRENCE-ID: skipping it, or ending the series
 * before it.
 */
export interface RepeatVars {
  todo: Todo
  repeat: TaskRepeat
}

/**
 * A change of a repeat (FR-17): detaching it, or splitting the series at it,
 * with `input`, the series' values with the user's edits and the repeat's new
 * dates. `moved` says that the dates changed, which the toast tells.
 */
export interface RepeatChangeVars extends RepeatVars {
  input: TodoInput
  moved: boolean
}

/*
 * The writes to a repeat, each under `UPDATE_TODO_KEY` with the series as
 * `todo`, so `usePendingSeries` marks the series busy while one is on its way
 * (FR-17, NFR-26). None is optimistic: the list shows the stored state, from
 * the answer or the reload after it.
 */
export const DETACH_TODO_KEY = [...UPDATE_TODO_KEY, 'detach'] as const
export const SKIP_TODO_KEY = [...UPDATE_TODO_KEY, 'skip'] as const
export const TODO_FOLLOWING_KEY = [...UPDATE_TODO_KEY, 'following'] as const
export const END_TODO_KEY = [...UPDATE_TODO_KEY, 'end'] as const

/**
 * Makes the current repeat of a task series a task of its own, changed by
 * `input` ("Only this repeat", FR-17); the series goes on at its next repeat.
 * The rule belongs to the series, so `rrule` stays out of the body. The
 * answer is the rolled series with the detached task, both put into the list
 * at once; its new ETag is noted within the mutation, so a write queued
 * behind it in the series' scope already uses it (NFR-26). The toast says
 * where the series goes on, its current repeat now, and the day the repeat
 * moved to; one that moved to no date at all, its due date removed, is said
 * to have changed. Its Undo takes the detached task back, until a write of
 * that task, which makes the server refuse the Undo, takes it away
 * (`noteSplit`). With the `id` of the series, after its other writes.
 */
export function useDetachTodo(id?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const prefs = usePrefs()
  return useMutation({
    mutationKey: DETACH_TODO_KEY,
    ...todoScope(id),
    mutationFn: async ({ todo, repeat, input }: RepeatChangeVars) => {
      const { rrule: _rrule, ...body } = input
      const etag = currentEtag(qc, todo)
      const answer = await endpoints.detachTodo(todo.id, etag, repeat.recurrenceId, body)
      if (answer.etag) replaceEtag(qc, todo.id, etag, answer.etag)
      return answer
    },
    onMutate: ({ todo }) => ({ generation: startSeriesWrite(qc, todo.id) }),
    onSuccess: (answer, { todo, repeat, input, moved }, ctx) => {
      putTodo(qc, todo.calendarId, answer)
      // The server refuses the Undo once the detached task changed, as the series restored would show the repeat twice.
      if (answer.detachedCopy) noteSplit(qc, todo.id, answer.detachedCopy.id, ctx.generation)
      // The day it moved to; none where its dates were removed, which is said like a change.
      const to = moved ? anchorOf(input) : null
      const after = {
        etag: answer.etag,
        undoToken: answer.undoToken,
        generation: ctx.generation,
        created: created(answer.detachedCopy, 'detached'),
      }
      if (!answer.detachedCopy) {
        // The series had no next repeat by now, so the server changed its last one as a single task, which asks
        // nothing: said like such a change, and only where it moved to a day.
        if (to) todoToast(qc, t, todo, t('tasks.movedToLast', { date: toastDay(to, prefs) }), after)
        return
      }
      const next = toastDay(anchorOf(answer), prefs)
      todoToast(
        qc,
        t,
        todo,
        to
          ? t('scope.toast.detachedMoved', { date: toastDay(to, prefs), next })
          : t('scope.toast.detachedChanged', { next }),
        after,
        { slots: taskGlyphSlots('this', repeat.at), color: todoColor(qc, todo.calendarId) },
      )
    },
    onError: (err, { todo }) => {
      reportMutationError(err, t, qc, queryKeys.todos(todo.calendarId))
    },
    onSettled: (_d, _e, { todo }) => qc.invalidateQueries({ queryKey: queryKeys.todos(todo.calendarId) }),
  })
}

/**
 * Skips the current repeat of a task series ("Only this repeat" of a delete,
 * FR-17): the series goes on at its next repeat. The answer is the rolled
 * series, put into the list at once, with its ETag noted like a detach's
 * (NFR-26). The toast says, in red, what is next up, with an Undo. With the
 * `id` of the series, after its other writes.
 */
export function useSkipTodo(id?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const prefs = usePrefs()
  return useMutation({
    mutationKey: SKIP_TODO_KEY,
    ...todoScope(id),
    mutationFn: async ({ todo, repeat }: RepeatVars) => {
      const etag = currentEtag(qc, todo)
      const answer = await endpoints.skipTodo(todo.id, etag, repeat.recurrenceId)
      if (answer.etag) replaceEtag(qc, todo.id, etag, answer.etag)
      return answer
    },
    onMutate: ({ todo }) => ({ generation: startSeriesWrite(qc, todo.id) }),
    onSuccess: (answer, { todo, repeat }, ctx) => {
      putTodo(qc, todo.calendarId, answer)
      todoToast(
        qc,
        t,
        todo,
        t('scope.toast.skipped', { next: toastDay(anchorOf(answer), prefs) }),
        { etag: answer.etag, undoToken: answer.undoToken, generation: ctx.generation },
        { slots: taskGlyphSlots('this', repeat.at), color: todoColor(qc, todo.calendarId), tone: 'destructive' },
      )
    },
    onError: (err, { todo }) => {
      reportMutationError(err, t, qc, queryKeys.todos(todo.calendarId))
    },
    onSettled: (_d, _e, { todo }) => qc.invalidateQueries({ queryKey: queryKeys.todos(todo.calendarId) }),
  })
}

/**
 * Splits a task series at a later repeat ("This and following repeats",
 * FR-17): the series ends before it, and one of its own goes on from it,
 * changed by `input` with the repeat's new dates. Not optimistic: both series
 * come with the reload. The old series' new ETag, when the server told one,
 * is noted within the mutation (NFR-26), and the split is noted for the new
 * series (`noteSplit`), whose first write takes the split's Undo away. The
 * toast names the day the split starts from, as the question did, and its
 * Undo goes to the old series and takes the new one back too. With the rule
 * removed, the new series is the repeat alone, and the toast says, in red,
 * that the series ends. Where the server found the repeat current, as in a
 * view not reloaded since, it changed the whole series instead, which the
 * toast says. With the `id` of the series, after its other writes.
 */
export function useTodoFollowing(id?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const prefs = usePrefs()
  return useMutation({
    mutationKey: TODO_FOLLOWING_KEY,
    ...todoScope(id),
    mutationFn: async ({ todo, repeat, input }: RepeatChangeVars) => {
      const etag = currentEtag(qc, todo)
      const answer = await endpoints.updateTodoFollowing(todo.id, etag, repeat.recurrenceId, input)
      if (answer.series.etag) replaceEtag(qc, todo.id, etag, answer.series.etag)
      return answer
    },
    onMutate: ({ todo }) => ({ generation: startSeriesWrite(qc, todo.id) }),
    onSuccess: (answer, { todo, repeat, input, moved }, ctx) => {
      noteSplit(qc, todo.id, answer.todo.id, ctx.generation)
      const color = todoColor(qc, todo.calendarId)
      const after = { etag: answer.series.etag, undoToken: answer.undoToken, generation: ctx.generation }
      if (answer.todo.id === todo.id) {
        const message = moved
          ? t('tasks.seriesMoved', { date: toastDay(anchorOf(answer.series), prefs) })
          : t('scope.toast.allRepeatsChanged')
        todoToast(qc, t, todo, message, after, { slots: taskGlyphSlots('all', 'current'), color })
        return
      }
      const date = toastDay(taskFollowingStart(repeat), prefs)
      const removed = input.rrule?.trim() === ''
      todoToast(
        qc,
        t,
        todo,
        removed
          ? t('scope.toast.ended', { date })
          : t(moved ? 'scope.toast.followingMoved' : 'scope.toast.followingChanged', { date }),
        // With the rule removed, the new series is the repeat alone, a task of its own.
        { ...after, created: created(answer.todo, removed ? 'detached' : 'series') },
        { slots: taskGlyphSlots('following', repeat.at), color, tone: removed ? 'destructive' : 'default' },
      )
    },
    onError: (err, { todo }) => {
      reportMutationError(err, t, qc, queryKeys.todos(todo.calendarId))
    },
    onSettled: (_d, _e, { todo }) => qc.invalidateQueries({ queryKey: queryKeys.todos(todo.calendarId) }),
  })
}

/**
 * Ends a task series before a later repeat ("This and following repeats" of a
 * delete, FR-17), not optimistic, like a split. While the series is kept, the
 * answer carries its new ETag, noted within the mutation (NFR-26), and the
 * undo token; the toast says, in red, before which day the series ends. A
 * `204` means the server found the repeat current, as in a view not reloaded
 * since, and deleted the task: it leaves the list, and the toast says so,
 * without Undo. With the `id` of the series, after its other writes.
 */
export function useEndTodo(id?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const prefs = usePrefs()
  return useMutation({
    mutationKey: END_TODO_KEY,
    ...todoScope(id),
    mutationFn: async ({ todo, repeat }: RepeatVars) => {
      const etag = currentEtag(qc, todo)
      const res = await endpoints.endTodo(todo.id, etag, repeat.recurrenceId)
      if (res?.etag) replaceEtag(qc, todo.id, etag, res.etag)
      return res
    },
    onMutate: ({ todo }) => ({ generation: startSeriesWrite(qc, todo.id) }),
    onSuccess: (res, { todo, repeat }, ctx) => {
      const color = todoColor(qc, todo.calendarId)
      if (!res) {
        removeTodo(qc, todo)
        todoToast(
          qc,
          t,
          todo,
          t('tasks.deleted'),
          { etag: '', generation: ctx.generation },
          { slots: taskGlyphSlots('all', 'current'), color, tone: 'destructive' },
        )
        return
      }
      todoToast(
        qc,
        t,
        todo,
        t('scope.toast.ended', { date: toastDay(taskFollowingStart(repeat), prefs) }),
        { etag: res.etag, undoToken: res.undoToken, generation: ctx.generation },
        { slots: taskGlyphSlots('following', repeat.at), color, tone: 'destructive' },
      )
    },
    onError: (err, { todo }) => {
      reportMutationError(err, t, qc, queryKeys.todos(todo.calendarId))
    },
    onSettled: (_d, _e, { todo }) => qc.invalidateQueries({ queryKey: queryKeys.todos(todo.calendarId) }),
  })
}

/**
 * IDs of the recurring tasks with a write on its way (FR-17): an update, a
 * detach, skip, split or end of a repeat, whose keys start with
 * `UPDATE_TODO_KEY`, or an undo. Their occurrences only move once the server
 * has answered and they are reloaded.
 */
export function usePendingSeries(): ReadonlySet<string> {
  const ids = useMutationState({
    filters: { mutationKey: UPDATE_TODO_KEY, status: 'pending' },
    select: (m) => {
      const todo = (m.state.variables as { todo?: Todo } | undefined)?.todo
      return todo?.recurring ? todo.id : null
    },
  })
  return useMemo(() => new Set(ids.filter((x) => x !== null)), [ids])
}

/**
 * Deletes a task. With the task's `id`, it waits for the updates of that task
 * still on their way (`todoScope`), so a task checked and deleted at once does
 * not conflict with its own check.
 */
export function useDeleteTodo(id?: string) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  return useMutation({
    ...todoScope(id),
    mutationFn: (todo: Todo) => endpoints.deleteTodo(todo.id, currentEtag(qc, todo)),
    onMutate: (todo) => {
      startSeriesWrite(qc, todo.id)
    },
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
