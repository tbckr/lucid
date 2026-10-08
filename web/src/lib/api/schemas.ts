import { z } from 'zod'

/**
 * Zod schemas mirroring internal/domain/domain.go. API responses are
 * validated at the boundary: list endpoints validate item by item so a single
 * malformed event or todo becomes a placeholder instead of breaking the view
 * (FR-19).
 */

const isoDateTime = z.iso.datetime({ offset: true })

export const sessionSchema = z.object({
  authenticated: z.boolean(),
  username: z.string().optional(),
  serverUrl: z.string().optional(),
  csrfToken: z.string().min(1),
  // Version of the running binary; optional so it can never block the login.
  version: z.string().optional(),
})
export type Session = z.infer<typeof sessionSchema>

export const calendarSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional().default(''),
  // The backend normalizes to #rrggbb; be lenient with #rgb / #rrggbbaa anyway.
  color: z
    .string()
    .transform((c, ctx) => {
      const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim())
      if (!m?.[1]) {
        ctx.addIssue({ code: 'custom', message: 'invalid color' })
        return z.NEVER
      }
      const hex = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1].slice(0, 6)
      return `#${hex.toLowerCase()}`
    })
    .catch('#4a45d6'),
  readOnly: z.boolean(),
  supportsEvents: z.boolean(),
  supportsTodos: z.boolean(),
})
export type Calendar = z.infer<typeof calendarSchema>

export const eventSchema = z
  .object({
    id: z.string().min(1),
    key: z.string().min(1),
    calendarId: z.string().min(1),
    uid: z.string(),
    etag: z.string(),
    title: z.string(),
    description: z.string().optional().default(''),
    location: z.string().optional().default(''),
    start: isoDateTime,
    end: isoDateTime,
    allDay: z.boolean(),
    timezone: z.string().optional().default(''),
    rrule: z.string().optional().default(''),
    recurring: z.boolean(),
    recurrenceId: isoDateTime.nullish(),
    // FR-17: true for an occurrence of a series an override visibly changed.
    modified: z.boolean().optional().default(false),
    // FR-17: true if the series or any override has an ORGANIZER or ATTENDEE, which the server refuses to split.
    hasAttendees: z.boolean().optional().default(false),
    // FR-17: true for the first occurrence of its series that the server shows, which has nothing before it to keep.
    first: z.boolean().optional().default(false),
    // FR-17: set on the answer of a change of a recurring series that can be undone (POST /events/{id}/undo).
    undoToken: z.string().nullish(),
  })
  .refine((e) => Date.parse(e.end) >= Date.parse(e.start), {
    message: 'end must not be before start',
    path: ['end'],
  })
export type ApiEvent = z.infer<typeof eventSchema>

/**
 * DELETE /api/v1/events/{eventId}/occurrences/{recurrenceId} response while
 * the series is kept: its new ETag, and an undo token when the delete can be
 * undone (FR-17, NFR-26).
 */
export const deletedOccurrenceSchema = z.object({ etag: z.string(), undoToken: z.string().nullish() })
export type DeletedOccurrence = z.infer<typeof deletedOccurrenceSchema>

/**
 * PUT /api/v1/events/{eventId}/following/{recurrenceId} response: the edited
 * occurrence in the new series, the old series' new ETag (empty when the
 * server told none), and an undo token when the split can be undone (FR-17,
 * NFR-26).
 */
export const followingSchema = z.object({
  event: eventSchema,
  etag: z.string().optional().default(''),
  undoToken: z.string().nullish(),
})
export type Following = z.infer<typeof followingSchema>

/**
 * POST /api/v1/events/{eventId}/undo response: the series' ETag after the
 * restore, and whether a resource the change created stayed because it was
 * changed since (FR-17). Both are left out when empty.
 */
export const eventRestoreSchema = z.object({
  etag: z.string().optional().default(''),
  copyKept: z.boolean().optional().default(false),
})
export type EventRestore = z.infer<typeof eventRestoreSchema>

export const checklistItemSchema = z.object({
  text: z.string(),
  done: z.boolean(),
})
export type ChecklistItem = z.infer<typeof checklistItemSchema>

export const todoStatusSchema = z.enum(['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED'])
export type TodoStatus = z.infer<typeof todoStatusSchema>

export const todoSchema = z.object({
  id: z.string().min(1),
  calendarId: z.string().min(1),
  uid: z.string(),
  etag: z.string(),
  title: z.string(),
  description: z.string().optional().default(''),
  checklist: z.array(checklistItemSchema).nullish().transform((v) => v ?? []),
  start: isoDateTime.nullish(),
  startAllDay: z.boolean().optional().default(false),
  due: isoDateTime.nullish(),
  dueAllDay: z.boolean().optional().default(false),
  priority: z.number().int().min(0).max(9),
  status: todoStatusSchema.catch('NEEDS-ACTION'),
  completed: isoDateTime.nullish(),
  // FR-17: the fields describing a recurring todo (VTODO with RRULE/RDATE).
  rrule: z.string().optional().default(''),
  recurring: z.boolean().optional().default(false),
  fixedDays: z.boolean().optional().default(false),
  ruleUnsupported: z.boolean().optional().default(false),
  next: z
    .object({
      start: isoDateTime.nullish(),
      startAllDay: z.boolean().optional(),
      due: isoDateTime.nullish(),
      dueAllDay: z.boolean().optional(),
    })
    .nullish(),
  // FR-17: the RECURRENCE-ID of the current occurrence of an open series, by which the writes to one repeat name it.
  recurrenceId: isoDateTime.nullish(),
  // FR-17: the IANA zone of the todo's anchor, which a series recurs in; left out for a date, UTC or floating time.
  timezone: z.string().nullish(),
  // FR-17: true if the series or any override has an ORGANIZER or ATTENDEE, which the server refuses to split or
  // detach from.
  hasAttendees: z.boolean().optional().default(false),
  // FR-17: the UID of the series a todo was detached from ("only this repeat"); left out for any other todo.
  detachedFrom: z.string().nullish(),
  // FR-17: where a move of the current occurrence must keep its anchor, [from, until), by the rule's days in the
  // series' zone; from null for a repeat off the rule, until null for the last repeat. Null where a move is free.
  // The server no longer sends it, so it parses as absent; it stays until the window code that reads it goes.
  moveWindow: z.object({ from: isoDateTime.nullable(), until: isoDateTime.nullable() }).nullish(),
})
export type Todo = z.infer<typeof todoSchema>

/**
 * Response of a write to a todo: PUT /api/v1/todos/{todoId}, PUT and DELETE
 * .../occurrences/{recurrenceId}, DELETE .../following/{recurrenceId}. A
 * completed occurrence's copy, when the master rolled to its next one, the
 * todo a detach made of the current repeat (FR-17), and an undo token when
 * the change can be undone (recurring todos only).
 */
export const updatedTodoSchema = todoSchema.extend({
  completedCopy: todoSchema.nullish(),
  detachedCopy: todoSchema.nullish(),
  undoToken: z.string().nullish(),
})
export type UpdatedTodo = z.infer<typeof updatedTodoSchema>

/**
 * PUT /api/v1/todos/{todoId}/following/{recurrenceId} response: the new
 * series from the repeat on, the old series as written, whose ETag is empty
 * when the server told none, and an undo token when the split can be undone
 * (FR-17, NFR-26).
 */
export const todoFollowingSchema = z.object({
  todo: todoSchema,
  series: todoSchema,
  undoToken: z.string().nullish(),
})
export type TodoFollowing = z.infer<typeof todoFollowingSchema>

/** POST /api/v1/todos/{todoId}/undo response: the restored series (FR-17). */
export const restoredTodoSchema = todoSchema.extend({ copyKept: z.boolean().optional().default(false) })
export type RestoredTodo = z.infer<typeof restoredTodoSchema>

export const occurrenceStateSchema = z.enum(['current', 'upcoming', 'done'])
export type OccurrenceState = z.infer<typeof occurrenceStateSchema>

/** An occurrence of a recurring todo, as returned by GET .../todos/occurrences (FR-17). */
export const todoOccurrenceSchema = z.object({
  key: z.string().min(1),
  todoId: z.string().min(1),
  calendarId: z.string().min(1),
  recurrenceId: isoDateTime,
  title: z.string(),
  start: isoDateTime.nullish(),
  startAllDay: z.boolean().optional().default(false),
  due: isoDateTime.nullish(),
  dueAllDay: z.boolean().optional().default(false),
  state: occurrenceStateSchema,
  // FR-17: true for a repeat that lies on none of the rule's instances, from which no series can go on.
  offRule: z.boolean().optional().default(false),
})
export type TodoOccurrence = z.infer<typeof todoOccurrenceSchema>

export const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string().optional().default('') }),
})

/** Payload for POST/PUT of events (domain.EventInput). */
export interface EventInput {
  title: string
  description: string
  location: string
  start: string
  end: string
  allDay: boolean
  timezone: string
  rrule: string
  /** RecurrenceID of the edited occurrence; only for recurring series. */
  instanceStart?: string
}

/**
 * Payload for PUT of a single occurrence of a series (domain.OccurrenceInput,
 * FR-17): like `EventInput`, but without `rrule` (the rule belongs to the
 * series) and without `instanceStart` (the occurrence is given in the path).
 */
export interface OccurrenceInput {
  title: string
  description: string
  location: string
  start: string
  end: string
  allDay: boolean
  timezone: string
}

/** Payload for POST/PUT of todos (domain.TodoInput). */
export interface TodoInput {
  title: string
  description: string
  checklist: ChecklistItem[]
  start: string | null
  startAllDay: boolean
  due: string | null
  dueAllDay: boolean
  priority: number
  status: TodoStatus
  /** RFC 5545 RRULE; absent keeps the stored rule, "" removes it (FR-17). */
  rrule?: string
  /** IANA zone timed start/due recur in; without it, a series uses UTC. */
  timezone?: string
}

/** A list item that failed validation, rendered as "Corrupted" placeholder. */
export interface CorruptedItem {
  kind: 'corrupted'
  key: string
  calendarId: string
  /** Best-effort start, used to position the placeholder in views. */
  start: Date | null
  reason: string
}

function readString(raw: unknown, field: string): string | undefined {
  if (raw !== null && typeof raw === 'object' && field in raw) {
    const v = (raw as Record<string, unknown>)[field]
    return typeof v === 'string' ? v : undefined
  }
  return undefined
}

/** Build a placeholder for an item that failed schema validation. */
export function toCorrupted(raw: unknown, calendarId: string, index: number, error: z.ZodError): CorruptedItem {
  const startRaw = readString(raw, 'start')
  const startMs = startRaw === undefined ? Number.NaN : Date.parse(startRaw)
  return {
    kind: 'corrupted',
    key: readString(raw, 'key') ?? readString(raw, 'id') ?? `corrupted:${calendarId}:${index}`,
    calendarId,
    start: Number.isNaN(startMs) ? null : new Date(startMs),
    reason: error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
  }
}

/** Validate a list item by item; invalid entries become placeholders. */
export function parseList<T>(
  schema: z.ZodType<T>,
  items: unknown,
  calendarId: string,
): { items: T[]; corrupted: CorruptedItem[] } {
  if (!Array.isArray(items)) {
    throw new TypeError('expected an array')
  }
  const ok: T[] = []
  const corrupted: CorruptedItem[] = []
  items.forEach((raw: unknown, index) => {
    const res = schema.safeParse(raw)
    if (res.success) ok.push(res.data)
    else corrupted.push(toCorrupted(raw, calendarId, index, res.error))
  })
  return { items: ok, corrupted }
}
