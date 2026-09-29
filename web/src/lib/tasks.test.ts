import { describe, expect, it } from 'vitest'
import { enUS } from 'date-fns/locale/en-US'
import { calendar, todo } from '@/test/fixtures'
import { type FormatPrefs } from './format'
import {
  addChecklistItem,
  checklistProgress,
  compareTodos,
  formatDue,
  groupTodos,
  isOverdue,
  priorityLevel,
  priorityValue,
  removeChecklistItem,
  selectTaskList,
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
    expect([...list].sort(compareTodos).map((t) => t.id)).toEqual([
      'due-soon',
      'due-late',
      'nodue-high',
      'nodue-low',
      'nodue-none',
      'done',
      'cancel',
    ])
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

  it('leaves the day to the heading when asked', () => {
    const labels = { today: 'Today', tomorrow: 'Tomorrow', yesterday: 'Yesterday' }
    expect(formatDue(todo({ due: '2026-09-25T15:30:00Z' }), now, prefs, labels, { timeOnly: true })).toBe('17:30')
    expect(formatDue(todo({ due: '2026-09-26T00:00:00Z', dueAllDay: true }), now, prefs, labels, { timeOnly: true })).toBeNull()
  })
})

describe('groupTodos', () => {
  // Noon on Fri, 25 Sep 2026 in Europe/Berlin (CEST, UTC+2).
  const now = new Date(2026, 8, 25, 12, 0)
  const kinds = (todos: ReturnType<typeof todo>[]) =>
    groupTodos(todos, now).map((g) => [g.kind, g.todos.map((t) => t.id)])

  it('groups by when the tasks are due, completed last', () => {
    expect(
      kinds([
        todo({ id: 'done', status: 'COMPLETED', due: '2026-09-20T00:00:00Z', dueAllDay: true }),
        todo({ id: 'someday' }),
        todo({ id: 'next-week', due: '2026-10-02T00:00:00Z', dueAllDay: true }),
        todo({ id: 'tomorrow', due: '2026-09-26T08:00:00Z' }),
        todo({ id: 'today', due: '2026-09-25T00:00:00Z', dueAllDay: true }),
        todo({ id: 'yesterday', due: '2026-09-24T00:00:00Z', dueAllDay: true }),
      ]),
    ).toEqual([
      ['overdue', ['yesterday']],
      ['today', ['today']],
      ['tomorrow', ['tomorrow']],
      ['later', ['next-week']],
      ['noDue', ['someday']],
      ['completed', ['done']],
    ])
  })

  it('moves a task due earlier today to overdue', () => {
    expect(
      kinds([todo({ id: 'morning', due: '2026-09-25T07:00:00Z' }), todo({ id: 'evening', due: '2026-09-25T16:00:00Z' })]),
    ).toEqual([
      ['overdue', ['morning']],
      ['today', ['evening']],
    ])
  })

  it('counts cancelled tasks as completed', () => {
    expect(kinds([todo({ id: 'x', status: 'CANCELLED', due: '2026-09-26T00:00:00Z', dueAllDay: true })])).toEqual([
      ['completed', ['x']],
    ])
  })

  it('sorts within a group by due date, priority and title', () => {
    expect(
      kinds([
        todo({ id: 'b', title: 'B' }),
        todo({ id: 'high', title: 'Z', priority: 1 }),
        todo({ id: 'a', title: 'A' }),
      ]),
    ).toEqual([['noDue', ['high', 'a', 'b']]])
  })

  it('returns no groups without tasks', () => {
    expect(groupTodos([], now)).toEqual([])
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
      start: null,
      startAllDay: false,
      due: '2026-09-25T00:00:00Z',
      dueAllDay: true,
      priority: 3,
      status: 'COMPLETED',
    })
    expect(todoToInput(todo()).due).toBeNull()
  })

  it('keeps the start date in the input', () => {
    const t = todo({ start: '2026-09-25T07:00:00Z', startAllDay: false })
    expect(todoToInput(t)).toMatchObject({ start: '2026-09-25T07:00:00Z', startAllDay: false })
  })
})

describe('selectTaskList', () => {
  const groups = [{ calendar: calendar({ id: 'a' }) }, { calendar: calendar({ id: 'b' }) }]

  it('returns the list with the saved ID', () => {
    expect(selectTaskList(groups, 'b')?.calendar.id).toBe('b')
  })

  it.each(['', 'gone'])('falls back to the first list for %j', (id) => {
    expect(selectTaskList(groups, id)?.calendar.id).toBe('a')
  })

  it('returns nothing without lists', () => {
    expect(selectTaskList<(typeof groups)[number]>([], 'a')).toBeUndefined()
  })
})
