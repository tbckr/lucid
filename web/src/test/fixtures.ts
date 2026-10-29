import {
  type ApiEvent,
  type Calendar,
  type DiagnosticsReport,
  type Todo,
  type TodoOccurrence,
} from '@/lib/api/schemas'

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
    endTimezone: 'Europe/Berlin',
    rrule: '',
    recurring: false,
    modified: false,
    override: false,
    hasAttendees: false,
    first: false,
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
    rrule: '',
    recurring: false,
    fixedDays: false,
    ruleUnsupported: false,
    next: null,
    hasAttendees: false,
    ...p,
  }
}

export function occurrence(p: Partial<TodoOccurrence> = {}): TodoOccurrence {
  return {
    key: 't1@2026-09-25T00:00:00Z',
    todoId: 't1',
    calendarId: 'c1',
    recurrenceId: '2026-09-25T00:00:00Z',
    title: 'Task',
    start: null,
    startAllDay: false,
    due: '2026-09-25T00:00:00Z',
    dueAllDay: true,
    state: 'current',
    offRule: false,
    ...p,
  }
}

/** `stableId` follows `id` (as `stable-<id>`), so a test that mixes the two up fails. */
export function calendar(p: Partial<Calendar> = {}): Calendar {
  return {
    id: 'c1',
    stableId: `stable-${p.id ?? 'c1'}`,
    name: 'Personal',
    description: '',
    color: '#3b82f6',
    readOnly: false,
    supportsEvents: true,
    supportsTodos: true,
    ...p,
  }
}

/** A problem report as `GET /api/v1/diagnostics` returns it (docs/API.md), with the problem of one unreadable object. */
export function diagnosticsReport(p: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    format: 1,
    createdAt: '2026-10-20T08:09:10Z',
    lucid: { version: '1.2.3', mode: 'server', os: 'linux', arch: 'amd64' },
    authenticated: true,
    server: { host: 'dav.example.com', product: 'Nextcloud', dav: '1, 3, calendar-access' },
    account: { endpoint: 'https://dav.example.com/remote.php/dav/', principal: '/p/{user}/', home: '/c/{user}/' },
    calendars: [{ path: '{home}/cal-1a2b3c4d/', readOnly: false, events: true, todos: false, objects: 12 }],
    exchanges: [
      { at: '2026-10-20T08:09:00Z', method: 'PROPFIND', host: 'dav.example.com', path: '{home}/', status: 207 },
    ],
    problems: [
      {
        at: '2026-10-20T08:09:01Z',
        requestId: '4f9c0a7e2b1d3c58',
        kind: 'unparsable_object',
        path: '{home}/cal-1a2b3c4d/obj-5e6f7a8b.ics',
        objectId: 'obj-id-1',
        reason: 'missing END:VCALENDAR',
        skeleton: { text: 'BEGIN:VCALENDAR\nVERSION:2.0\n' },
      },
    ],
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
