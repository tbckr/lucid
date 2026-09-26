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
  })
  .refine((e) => Date.parse(e.end) >= Date.parse(e.start), {
    message: 'end must not be before start',
    path: ['end'],
  })
export type ApiEvent = z.infer<typeof eventSchema>

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
  due: isoDateTime.nullish(),
  dueAllDay: z.boolean().optional().default(false),
  priority: z.number().int().min(0).max(9),
  status: todoStatusSchema.catch('NEEDS-ACTION'),
  completed: isoDateTime.nullish(),
})
export type Todo = z.infer<typeof todoSchema>

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

/** Payload for POST/PUT of todos (domain.TodoInput). */
export interface TodoInput {
  title: string
  description: string
  checklist: ChecklistItem[]
  due: string | null
  dueAllDay: boolean
  priority: number
  status: TodoStatus
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
