import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { moreLabel, ringColors } from './bundle'
import { toCalTask } from './calendarTasks'
import { toCalEvent } from './events'
import { apiEvent, todo } from '@/test/fixtures'

const ORANGE = '#f97316'
const BLUE = '#3b82f6'
const GREEN = '#22c55e'
const RED = '#ef4444'
const VIOLET = '#8b5cf6'
const COLORS = new Map([
  ['orange', ORANGE],
  ['blue', BLUE],
  ['green', GREEN],
  ['red', RED],
  ['violet', VIOLET],
])
const solidOf = (calendarId: string) => COLORS.get(calendarId) ?? '#000000'

function tasksOf(...calendarIds: string[]) {
  return calendarIds.map((calendarId, i) =>
    toCalTask(todo({ id: `t${i}`, calendarId, due: '2026-09-25T00:00:00Z', dueAllDay: true })),
  ).filter((t) => t !== null)
}

describe('ringColors', () => {
  it('lists the colors most frequent first and pads with the first to the number of rings', () => {
    expect(ringColors(tasksOf('orange', 'blue', 'orange', 'orange'), solidOf, 3)).toEqual([ORANGE, BLUE, ORANGE])
  })

  it('does not pad past the number of tasks', () => {
    expect(ringColors(tasksOf('orange'), solidOf, 3)).toEqual([ORANGE])
    expect(ringColors([], solidOf, 3)).toEqual([])
  })

  it('repeats the first color when there are fewer colors than rings', () => {
    expect(ringColors(tasksOf('orange', 'orange'), solidOf, 2)).toEqual([ORANGE, ORANGE])
  })

  it('keeps only the most frequent colors when there are more than rings', () => {
    const tasks = tasksOf('green', 'red', 'red', 'violet', 'blue', 'blue', 'blue', 'orange', 'orange')
    expect(ringColors(tasks, solidOf, 2)).toEqual([BLUE, RED])
  })

  it('breaks a tie by first appearance', () => {
    expect(ringColors(tasksOf('green', 'red', 'blue'), solidOf, 3)).toEqual([GREEN, RED, BLUE])
    expect(ringColors(tasksOf('blue', 'red', 'red', 'blue'), solidOf, 2)).toEqual([BLUE, RED])
  })

  it('counts calendars of the same color as one color', () => {
    const sameColor = (id: string) => (id === 'a' || id === 'b' ? ORANGE : BLUE)
    expect(ringColors(tasksOf('a', 'c', 'b'), sameColor, 3)).toEqual([ORANGE, BLUE, ORANGE])
  })
})

describe('moreLabel', () => {
  const events = [1, 2, 3].map((i) => toCalEvent(apiEvent({ id: `e${i}`, key: `e${i}` })))
  const [task] = tasksOf('orange')
  const date = 'Friday, September 25th, 2026'
  const en = i18n.getFixedT('en')
  const de = i18n.getFixedT('de')

  it('names the events behind it when it holds nothing else', () => {
    expect(moreLabel(en, events, date)).toBe('3 more events, Friday, September 25th, 2026')
    expect(moreLabel(en, events.slice(0, 1), date)).toBe('1 more event, Friday, September 25th, 2026')
    expect(moreLabel(de, events, 'Freitag')).toBe('3 weitere Termine, Freitag')
    expect(moreLabel(de, events.slice(0, 1), 'Freitag')).toBe('1 weiterer Termin, Freitag')
  })

  it('names no kind when tasks are behind it too', () => {
    expect(moreLabel(en, [...events, task!], date)).toBe('4 more, Friday, September 25th, 2026')
    expect(moreLabel(en, [task!], date)).toBe('1 more, Friday, September 25th, 2026')
    expect(moreLabel(de, [...events, task!], 'Freitag')).toBe('4 weitere, Freitag')
  })
})
