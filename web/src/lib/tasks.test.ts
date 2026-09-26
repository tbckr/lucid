import { describe, expect, it } from 'vitest'
import { enUS } from 'date-fns/locale/en-US'
import { todo } from '@/test/fixtures'
import { type FormatPrefs } from './format'
import {
  addChecklistItem,
  checklistProgress,
  compareTodos,
  formatDue,
  isDone,
  isOverdue,
  priorityLevel,
  priorityValue,
  removeChecklistItem,
  sortTodos,
  todoToInput,
  toggleChecklistItem,
  toggledStatus,
} from './tasks'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '24h', weekStartsOn: 0 }

describe('priority', () => {
  it.each([
    [0, 'none'],
    [1, 'high'],
    [4, 'high'],
    [5, 'medium'],
    [6, 'low'],
    [9, 'low'],
    [10, 'none'],
  ])('%i → %s', (p, level) => {
    expect(priorityLevel(p)).toBe(level)
  })

  it('maps levels back to RFC 5545 values', () => {
    expect(['none', 'high', 'medium', 'low'].map((l) => priorityValue(l as 'none'))).toEqual([0, 1, 5, 9])
  })
})

describe('sorting', () => {
  const list = [
    todo({ id: 'done', title: 'A', status: 'COMPLETED' }),
    todo({ id: 'nodue-low', title: 'B', priority: 9 }),
    todo({ id: 'nodue-none', title: 'C', priority: 0 }),
    todo({ id: 'due-late', title: 'D', due: '2026-10-01T00:00:00Z' }),
    todo({ id: 'due-soon', title: 'E', due: '2026-09-26T00:00:00Z' }),
    todo({ id: 'nodue-high', title: 'F', priority: 1 }),
    todo({ id: 'cancel', title: 'G', status: 'CANCELLED' }),
  ]

  it('puts incomplete first, then due date, then priority, then title', () => {
    expect(sortTodos(list, false).map((t) => t.id)).toEqual([
      'due-soon',
      'due-late',
      'nodue-high',
      'nodue-low',
      'nodue-none',
      'done',
      'cancel',
    ])
  })

  it('filters completed when requested', () => {
    expect(sortTodos(list, true).some(isDone)).toBe(false)
  })

  it('is a stable comparator for equal items', () => {
    expect(compareTodos(todo(), todo())).toBe(0)
  })
})

describe('due dates', () => {
  const now = new Date(2026, 8, 25, 12, 0)

  it('computes overdue for all-day and timed due dates', () => {
    expect(isOverdue(todo({ due: '2026-09-25T00:00:00Z', dueAllDay: true }), now)).toBe(false)
    expect(isOverdue(todo({ due: '2026-09-24T00:00:00Z', dueAllDay: true }), now)).toBe(true)
    expect(isOverdue(todo({ due: '2026-09-25T09:00:00Z' }), now)).toBe(true)
    expect(isOverdue(todo({ due: '2026-09-25T11:00:00Z' }), now)).toBe(false)
    expect(isOverdue(todo({ due: '2026-09-20T00:00:00Z', status: 'COMPLETED' }), now)).toBe(false)
    expect(isOverdue(todo(), now)).toBe(false)
  })

  it('formats relative labels', () => {
    const labels = { today: 'Today', tomorrow: 'Tomorrow', yesterday: 'Yesterday' }
    expect(formatDue(todo(), now, prefs, labels)).toBeNull()
    expect(formatDue(todo({ due: '2026-09-25T00:00:00Z', dueAllDay: true }), now, prefs, labels)).toBe('Today')
    expect(formatDue(todo({ due: '2026-09-26T00:00:00Z', dueAllDay: true }), now, prefs, labels)).toBe('Tomorrow')
    expect(formatDue(todo({ due: '2026-09-24T00:00:00Z', dueAllDay: true }), now, prefs, labels)).toBe('Yesterday')
    expect(formatDue(todo({ due: '2026-09-25T15:30:00Z' }), now, prefs, labels)).toBe('Today, 17:30')
    expect(formatDue(todo({ due: '2026-10-02T00:00:00Z', dueAllDay: true }), now, prefs, labels)).toBe('Fri, 2 Oct')
    expect(formatDue(todo({ due: '2027-12-02T00:00:00Z', dueAllDay: true }), now, prefs, labels)).toBe('Dec 2, 2027')
  })
})

describe('checklist', () => {
  const items = [
    { text: 'a', done: false },
    { text: 'b', done: true },
  ]

  it('adds trimmed items and ignores blanks', () => {
    expect(addChecklistItem(items, '  c ')).toEqual([...items, { text: 'c', done: false }])
    expect(addChecklistItem(items, '   ')).toBe(items)
  })

  it('toggles and removes immutably', () => {
    const toggled = toggleChecklistItem(items, 0)
    expect(toggled[0]?.done).toBe(true)
    expect(items[0]?.done).toBe(false)
    expect(removeChecklistItem(items, 1)).toEqual([{ text: 'a', done: false }])
    expect(checklistProgress(items)).toEqual({ done: 1, total: 2 })
  })
})

describe('status', () => {
  it('toggles completion and builds inputs', () => {
    expect(toggledStatus({ status: 'COMPLETED' })).toBe('NEEDS-ACTION')
    expect(toggledStatus({ status: 'IN-PROCESS' })).toBe('COMPLETED')
    const t = todo({ due: '2026-09-25T00:00:00Z', dueAllDay: true, priority: 3 })
    expect(todoToInput(t, { status: 'COMPLETED' })).toEqual({
      title: 'Task',
      description: '',
      checklist: [],
      due: '2026-09-25T00:00:00Z',
      dueAllDay: true,
      priority: 3,
      status: 'COMPLETED',
    })
    expect(todoToInput(todo()).due).toBeNull()
  })
})
