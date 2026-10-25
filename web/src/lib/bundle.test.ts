import { describe, expect, it } from 'vitest'
import { ringColors } from './bundle'
import { toCalTask } from './calendarTasks'
import { todo } from '@/test/fixtures'

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
