import { type ApiEvent, type Calendar, type Todo } from '@/lib/api/schemas'

export function apiEvent(p: Partial<ApiEvent> = {}): ApiEvent {
  return {
    id: 'e1',
    key: 'e1',
    calendarId: 'c1',
    uid: 'u1',
    etag: '"1"',
    title: 'Event',
    description: '',
    location: '',
    start: '2026-09-25T08:00:00Z',
    end: '2026-09-25T09:00:00Z',
    allDay: false,
    timezone: 'Europe/Berlin',
    rrule: '',
    recurring: false,
    ...p,
  }
}

export function todo(p: Partial<Todo> = {}): Todo {
  return {
    id: 't1',
    calendarId: 'c1',
    uid: 'u1',
    etag: '"1"',
    title: 'Task',
    description: '',
    checklist: [],
    start: null,
    startAllDay: false,
    due: null,
    dueAllDay: false,
    priority: 0,
    status: 'NEEDS-ACTION',
    completed: null,
    ...p,
  }
}

export function calendar(p: Partial<Calendar> = {}): Calendar {
  return {
    id: 'c1',
    name: 'Personal',
    description: '',
    color: '#3b82f6',
    readOnly: false,
    supportsEvents: true,
    supportsTodos: true,
    ...p,
  }
}

/** A fetch Response with a JSON body. */
export function jsonResponse(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/** URL of a fetch input (string, URL or Request). */
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** Parsed JSON body of a fetch call. */
export function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
}
