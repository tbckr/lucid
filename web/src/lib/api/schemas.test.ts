import { describe, expect, it } from 'vitest'
import { apiEvent, occurrence } from '@/test/fixtures'
import {
  calendarSchema,
  deletedOccurrenceSchema,
  eventRestoreSchema,
  eventSchema,
  followingSchema,
  parseList,
  restoredTodoSchema,
  sessionSchema,
  todoFollowingSchema,
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

  it('parses the flags that decide whether a series can be split, false when left out', () => {
    const { first: _f, hasAttendees: _a, ...unflagged } = apiEvent()
    const left = eventSchema.parse(unflagged)
    expect([left.first, left.hasAttendees]).toEqual([false, false])
    const flagged = eventSchema.parse({ ...apiEvent(), first: true, hasAttendees: true })
    expect([flagged.first, flagged.hasAttendees]).toEqual([true, true])
  })

  it('parses the answer of a split: the new series, the old one\'s ETag and an undo token, each optional but the event', () => {
    const e = apiEvent({ id: 'e2' })
    expect(followingSchema.parse({ event: e }).etag).toBe('')
    expect(followingSchema.parse({ event: e }).undoToken).toBeUndefined()
    const full = followingSchema.parse({ event: e, etag: '"3"', undoToken: 'tok' })
    expect([full.event.id, full.etag, full.undoToken]).toEqual(['e2', '"3"', 'tok'])
    expect(followingSchema.safeParse({ etag: '"3"' }).success).toBe(false)
    expect(followingSchema.safeParse({ event: { id: 'e2' } }).success).toBe(false)
  })

  it('keeps the undo token of a change of an event series, and parses events without one', () => {
    expect(eventSchema.parse(apiEvent()).undoToken).toBeUndefined()
    expect(eventSchema.parse(apiEvent({ undoToken: 'tok' })).undoToken).toBe('tok')
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

  it('parses what a task of the scope question carries, and leaves it out when the server does', () => {
    const base = {
      id: 't',
      calendarId: 'c',
      uid: 'u',
      etag: 'e',
      title: 'x',
      priority: 0,
      status: 'NEEDS-ACTION',
    }
    const left = todoSchema.parse(base)
    expect(left.hasAttendees).toBe(false)
    expect([left.detachedFrom, left.recurrenceId, left.timezone]).toEqual([undefined, undefined, undefined])
    const carried = todoSchema.parse({
      ...base,
      hasAttendees: true,
      detachedFrom: 'series-uid',
      recurrenceId: '2026-09-25T00:00:00Z',
      timezone: 'Europe/Berlin',
    })
    expect(carried.hasAttendees).toBe(true)
    expect([carried.detachedFrom, carried.recurrenceId, carried.timezone]).toEqual([
      'series-uid',
      '2026-09-25T00:00:00Z',
      'Europe/Berlin',
    ])
    expect(todoSchema.safeParse({ ...base, recurrenceId: 'tomorrow' }).success).toBe(false)
  })

  it('updatedTodoSchema keeps the detached copy of a detach, todoSchema strips it', () => {
    const base = {
      id: 't',
      calendarId: 'c',
      uid: 'u',
      etag: 'e',
      title: 'x',
      priority: 0,
      status: 'NEEDS-ACTION',
    }
    expect(updatedTodoSchema.parse(base).detachedCopy).toBeUndefined()
    const withCopy = { ...base, detachedCopy: { ...base, id: 't-copy', detachedFrom: 'u' } }
    const updated = updatedTodoSchema.parse(withCopy)
    expect(updated.detachedCopy?.id).toBe('t-copy')
    expect(updated.detachedCopy?.detachedFrom).toBe('u')
    expect(todoSchema.parse(withCopy)).not.toHaveProperty('detachedCopy')
  })

  it('parses the answer of a split of a task: the new series, the old one and an undo token, which is optional', () => {
    const base = {
      id: 't',
      calendarId: 'c',
      uid: 'u',
      etag: '"1"',
      title: 'x',
      priority: 0,
      status: 'NEEDS-ACTION',
    }
    const answer = { todo: { ...base, id: 't2', uid: 'u2', recurrenceId: '2026-09-28T00:00:00Z' }, series: base }
    const bare = todoFollowingSchema.parse(answer)
    expect([bare.todo.id, bare.series.id, bare.undoToken]).toEqual(['t2', 't', undefined])
    expect(bare.todo.recurrenceId).toBe('2026-09-28T00:00:00Z')
    expect(todoFollowingSchema.parse({ ...answer, undoToken: 'tok' }).undoToken).toBe('tok')
    // The server tells no ETag of the old series that way, which is no reason to refuse the answer.
    expect(todoFollowingSchema.parse({ ...answer, series: { ...base, etag: '' } }).series.etag).toBe('')
    expect(todoFollowingSchema.safeParse({ series: base }).success).toBe(false)
    expect(todoFollowingSchema.safeParse({ todo: answer.todo }).success).toBe(false)
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

  it('eventRestoreSchema accepts an empty answer and keeps what it carries', () => {
    expect(eventRestoreSchema.parse({})).toEqual({ etag: '', copyKept: false })
    expect(eventRestoreSchema.parse({ etag: '"3"', copyKept: true })).toEqual({ etag: '"3"', copyKept: true })
  })

  it('deletedOccurrenceSchema requires the ETag, the undo token is optional', () => {
    expect(deletedOccurrenceSchema.parse({ etag: '"3"' }).undoToken).toBeUndefined()
    expect(deletedOccurrenceSchema.parse({ etag: '"3"', undoToken: 'tok' })).toEqual({ etag: '"3"', undoToken: 'tok' })
    expect(deletedOccurrenceSchema.safeParse({ undoToken: 'tok' }).success).toBe(false)
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

  it('flags a repeat off its rule, false when the server leaves it out', () => {
    const { offRule: _o, ...plain } = occurrence()
    expect(todoOccurrenceSchema.parse(plain).offRule).toBe(false)
    expect(todoOccurrenceSchema.parse({ ...plain, offRule: true }).offRule).toBe(true)
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
