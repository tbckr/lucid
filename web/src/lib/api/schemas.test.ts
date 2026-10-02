import { describe, expect, it } from 'vitest'
import { apiEvent, occurrence } from '@/test/fixtures'
import {
  calendarSchema,
  eventSchema,
  parseList,
  restoredTodoSchema,
  sessionSchema,
  todoOccurrenceSchema,
  todoSchema,
  toCorrupted,
  updatedTodoSchema,
} from './schemas'

describe('schemas', () => {
  it('accepts a documented event and fills optional fields', () => {
    const { description: _d, location: _l, timezone: _t, rrule: _r, modified: _m, ...minimal } = apiEvent()
    const e = eventSchema.parse(minimal)
    expect(e.description).toBe('')
    expect(e.rrule).toBe('')
    expect(e.modified).toBe(false)
  })

  it('parses modified', () => {
    expect(eventSchema.parse(apiEvent({ modified: true })).modified).toBe(true)
  })

  it('rejects events whose end is before start or with bad dates', () => {
    expect(eventSchema.safeParse(apiEvent({ end: '2026-09-25T07:00:00Z' })).success).toBe(false)
    expect(eventSchema.safeParse(apiEvent({ start: 'tomorrow' })).success).toBe(false)
    expect(eventSchema.safeParse(apiEvent({ recurrenceId: '2026-09-25T08:00:00Z' })).success).toBe(true)
  })

  it('normalises calendar colors', () => {
    const c = calendarSchema.parse({
      id: 'a',
      name: 'A',
      color: 'red',
      readOnly: false,
      supportsEvents: true,
      supportsTodos: false,
    })
    expect(c.color).toBe('#4a45d6')
    expect(c.description).toBe('')
    const base = { id: 'a', name: 'A', readOnly: false, supportsEvents: true, supportsTodos: false }
    expect(calendarSchema.parse({ ...base, color: '#3B82F6FF' }).color).toBe('#3b82f6')
    expect(calendarSchema.parse({ ...base, color: 'abc' }).color).toBe('#aabbcc')
  })

  it('parses todos with null checklist and unknown status', () => {
    const t = todoSchema.parse({
      id: 't',
      calendarId: 'c',
      uid: 'u',
      etag: 'e',
      title: 'x',
      checklist: null,
      priority: 3,
      status: 'WHATEVER',
    })
    expect(t.checklist).toEqual([])
    expect(t.status).toBe('NEEDS-ACTION')
    expect(t.dueAllDay).toBe(false)
    expect(todoSchema.safeParse({ ...t, priority: 12 }).success).toBe(false)
  })

  it('defaults the recurrence fields when a todo omits them', () => {
    const t = todoSchema.parse({
      id: 't',
      calendarId: 'c',
      uid: 'u',
      etag: 'e',
      title: 'x',
      priority: 0,
      status: 'NEEDS-ACTION',
    })
    expect(t.rrule).toBe('')
    expect(t.recurring).toBe(false)
    expect(t.fixedDays).toBe(false)
    expect(t.ruleUnsupported).toBe(false)
    expect(t.next).toBeUndefined()
  })

  it('updatedTodoSchema keeps completedCopy, todoSchema strips it', () => {
    const base = {
      id: 't',
      calendarId: 'c',
      uid: 'u',
      etag: 'e',
      title: 'x',
      priority: 0,
      status: 'NEEDS-ACTION',
    }
    const withCopy = { ...base, completedCopy: { ...base, id: 't-copy' } }
    const updated = updatedTodoSchema.parse(withCopy)
    expect(updated.completedCopy?.id).toBe('t-copy')
    const plain = todoSchema.parse(withCopy)
    expect(plain).not.toHaveProperty('completedCopy')
  })

  it('updatedTodoSchema carries an undo token, absent by default', () => {
    const base = {
      id: 't',
      calendarId: 'c',
      uid: 'u',
      etag: 'e',
      title: 'x',
      priority: 0,
      status: 'NEEDS-ACTION',
    }
    expect(updatedTodoSchema.parse(base).undoToken).toBeUndefined()
    expect(updatedTodoSchema.parse({ ...base, undoToken: 'tok' }).undoToken).toBe('tok')
  })

  it('restoredTodoSchema defaults copyKept to false', () => {
    const base = {
      id: 't',
      calendarId: 'c',
      uid: 'u',
      etag: 'e',
      title: 'x',
      priority: 0,
      status: 'NEEDS-ACTION',
    }
    expect(restoredTodoSchema.parse(base).copyKept).toBe(false)
    expect(restoredTodoSchema.parse({ ...base, copyKept: true }).copyKept).toBe(true)
  })

  it('requires a CSRF token in sessions', () => {
    expect(sessionSchema.safeParse({ authenticated: false }).success).toBe(false)
    expect(sessionSchema.parse({ authenticated: true, username: 'u', csrfToken: 't' }).username).toBe('u')
  })

  it('keeps the server version and tolerates its absence', () => {
    expect(sessionSchema.parse({ authenticated: false, csrfToken: 't', version: '1.2.3' }).version).toBe('1.2.3')
    expect(sessionSchema.parse({ authenticated: false, csrfToken: 't' }).version).toBeUndefined()
  })
})

describe('todoOccurrenceSchema', () => {
  it('accepts a documented occurrence', () => {
    expect(todoOccurrenceSchema.safeParse(occurrence()).success).toBe(true)
  })

  it('rejects an occurrence with an unknown state', () => {
    expect(todoOccurrenceSchema.safeParse(occurrence({ state: 'later' as never })).success).toBe(false)
  })
})

describe('parseList', () => {
  it('turns invalid items into corrupted placeholders', () => {
    const good = apiEvent({ key: 'good' })
    const bad = { key: 'bad', id: 'bad', start: '2026-09-26T10:00:00Z', title: 5 }
    const res = parseList(eventSchema, [good, bad, 'garbage'], 'cal')
    expect(res.items.map((e) => e.key)).toEqual(['good'])
    expect(res.corrupted).toHaveLength(2)
    expect(res.corrupted[0]).toMatchObject({ kind: 'corrupted', key: 'bad', calendarId: 'cal' })
    expect(res.corrupted[0]?.start?.toISOString()).toBe('2026-09-26T10:00:00.000Z')
    expect(res.corrupted[0]?.reason).toContain('title')
    expect(res.corrupted[1]).toMatchObject({ key: 'corrupted:cal:2', start: null })
  })

  it('throws for non-arrays', () => {
    expect(() => parseList(eventSchema, { nope: true }, 'c')).toThrow(TypeError)
  })

  it('toCorrupted falls back to id and handles unparsable start', () => {
    const r = eventSchema.safeParse({ id: 'x', start: 'nope' })
    if (r.success) throw new Error('expected failure')
    expect(toCorrupted({ id: 'x', start: 'nope' }, 'c', 0, r.error)).toMatchObject({ key: 'x', start: null })
  })
})
