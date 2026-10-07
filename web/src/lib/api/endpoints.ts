import { z } from 'zod'
import { api, type ApiClient } from './client'
import {
  calendarSchema,
  deletedOccurrenceSchema,
  eventRestoreSchema,
  eventSchema,
  followingSchema,
  parseList,
  restoredTodoSchema,
  sessionSchema,
  todoOccurrenceSchema,
  todoSchema,
  updatedTodoSchema,
  type ApiEvent,
  type Calendar,
  type CorruptedItem,
  type DeletedOccurrence,
  type EventInput,
  type EventRestore,
  type Following,
  type OccurrenceInput,
  type RestoredTodo,
  type Session,
  type Todo,
  type TodoInput,
  type TodoOccurrence,
  type UpdatedTodo,
} from './schemas'

const enc = encodeURIComponent

export interface Credentials {
  serverUrl: string
  username: string
  password: string
}

export interface EventList {
  events: ApiEvent[]
  corrupted: CorruptedItem[]
}

export interface TodoList {
  todos: Todo[]
  corrupted: CorruptedItem[]
}

export interface TodoOccurrenceList {
  occurrences: TodoOccurrence[]
  corrupted: CorruptedItem[]
}

const eventsEnvelope = z.object({ events: z.array(z.unknown()).nullish().transform((v) => v ?? []) })
const todosEnvelope = z.object({ todos: z.array(z.unknown()).nullish().transform((v) => v ?? []) })
const occurrencesEnvelope = z.object({ occurrences: z.array(z.unknown()).nullish().transform((v) => v ?? []) })
const calendarsEnvelope = z.object({ calendars: z.array(calendarSchema).nullish().transform((v) => v ?? []) })

/** Typed endpoint functions for docs/API.md. */
export function createEndpoints(client: ApiClient) {
  return {
    getSession: (signal?: AbortSignal): Promise<Session> => client.fetchSession(signal),

    async login(creds: Credentials): Promise<Session> {
      const s = await client.request('/auth/login', { method: 'POST', body: creds, schema: sessionSchema })
      client.setCsrfToken(s.csrfToken)
      return s
    },

    async logout(): Promise<void> {
      await client.request('/auth/logout', { method: 'POST' })
      client.setCsrfToken(null)
    },

    async listCalendars(signal?: AbortSignal): Promise<Calendar[]> {
      const res = await client.request('/calendars', { schema: calendarsEnvelope, ...(signal ? { signal } : {}) })
      return res.calendars
    },

    async listEvents(calendarId: string, start: Date, end: Date, signal?: AbortSignal): Promise<EventList> {
      const qs = `start=${enc(start.toISOString())}&end=${enc(end.toISOString())}`
      const res = await client.request(`/calendars/${enc(calendarId)}/events?${qs}`, {
        schema: eventsEnvelope,
        ...(signal ? { signal } : {}),
      })
      const { items, corrupted } = parseList(eventSchema, res.events, calendarId)
      return { events: items, corrupted }
    },

    createEvent: (calendarId: string, input: EventInput): Promise<ApiEvent> =>
      client.request(`/calendars/${enc(calendarId)}/events`, { method: 'POST', body: input, schema: eventSchema }),

    updateEvent: (eventId: string, etag: string, input: EventInput): Promise<ApiEvent> =>
      client.request(`/events/${enc(eventId)}`, { method: 'PUT', body: input, etag, schema: eventSchema }),

    deleteEvent: (eventId: string, etag: string): Promise<undefined> =>
      client.request(`/events/${enc(eventId)}`, { method: 'DELETE', etag }),

    // FR-17: "Only this event" of a recurring series, an override living in the same resource as the series.
    updateOccurrence: (eventId: string, recurrenceId: string, etag: string, input: OccurrenceInput): Promise<ApiEvent> =>
      client.request(`/events/${enc(eventId)}/occurrences/${enc(recurrenceId)}`, {
        method: 'PUT',
        body: input,
        etag,
        schema: eventSchema,
      }),

    /**
     * Resolves with the series' new ETag and undo token, or with nothing once its resource is deleted with its last
     * event, or when the server told no new ETag for the series it kept.
     */
    deleteOccurrence: (eventId: string, recurrenceId: string, etag: string): Promise<DeletedOccurrence | undefined> =>
      client.request(`/events/${enc(eventId)}/occurrences/${enc(recurrenceId)}`, {
        method: 'DELETE',
        etag,
        schema: deletedOccurrenceSchema.optional(),
      }),

    /**
     * FR-17: "This and following events". The series ends before `recurrenceId` and a new series of its own goes
     * on from it. Resolves with the edited occurrence in the new series and the old series' new ETag (empty when
     * the server told none).
     */
    updateFollowing: (eventId: string, recurrenceId: string, etag: string, input: EventInput): Promise<Following> =>
      client.request(`/events/${enc(eventId)}/following/${enc(recurrenceId)}`, {
        method: 'PUT',
        body: input,
        etag,
        schema: followingSchema,
      }),

    /**
     * As `deleteOccurrence`: the series' new ETag and undo token, or nothing once its resource is deleted, at what is
     * its first event by now, or when the server told no new ETag for the series it kept.
     */
    deleteFollowing: (eventId: string, recurrenceId: string, etag: string): Promise<DeletedOccurrence | undefined> =>
      client.request(`/events/${enc(eventId)}/following/${enc(recurrenceId)}`, {
        method: 'DELETE',
        etag,
        schema: deletedOccurrenceSchema.optional(),
      }),

    /** Undoes the change that returned `token` as `undoToken` (FR-17); no `If-Match`, the token is the concurrency control. */
    undoEvent: (eventId: string, token: string): Promise<EventRestore> =>
      client.request(`/events/${enc(eventId)}/undo`, { method: 'POST', body: { token }, schema: eventRestoreSchema }),

    async listTodos(calendarId: string, signal?: AbortSignal): Promise<TodoList> {
      const res = await client.request(`/calendars/${enc(calendarId)}/todos`, {
        schema: todosEnvelope,
        ...(signal ? { signal } : {}),
      })
      const { items, corrupted } = parseList(todoSchema, res.todos, calendarId)
      return { todos: items, corrupted }
    },

    createTodo: (calendarId: string, input: TodoInput): Promise<Todo> =>
      client.request(`/calendars/${enc(calendarId)}/todos`, { method: 'POST', body: input, schema: todoSchema }),

    updateTodo: (todoId: string, etag: string, input: TodoInput): Promise<UpdatedTodo> =>
      client.request(`/todos/${enc(todoId)}`, { method: 'PUT', body: input, etag, schema: updatedTodoSchema }),

    deleteTodo: (todoId: string, etag: string): Promise<undefined> =>
      client.request(`/todos/${enc(todoId)}`, { method: 'DELETE', etag }),

    /** Undoes the change that returned `token` as `undoToken` (FR-17); no `If-Match`, the token is the concurrency control. */
    undoTodo: (todoId: string, token: string): Promise<RestoredTodo> =>
      client.request(`/todos/${enc(todoId)}/undo`, { method: 'POST', body: { token }, schema: restoredTodoSchema }),

    async listTodoOccurrences(
      calendarId: string,
      start: Date,
      end: Date,
      signal?: AbortSignal,
    ): Promise<TodoOccurrenceList> {
      const qs = `start=${enc(start.toISOString())}&end=${enc(end.toISOString())}`
      const res = await client.request(`/calendars/${enc(calendarId)}/todos/occurrences?${qs}`, {
        schema: occurrencesEnvelope,
        ...(signal ? { signal } : {}),
      })
      const { items, corrupted } = parseList(todoOccurrenceSchema, res.occurrences, calendarId)
      return { occurrences: items, corrupted }
    },
  }
}

export type Endpoints = ReturnType<typeof createEndpoints>

export const endpoints = createEndpoints(api)
