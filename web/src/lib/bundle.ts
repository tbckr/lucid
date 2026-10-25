import { type CalItem } from './events'

/**
 * The colors of a task bundle's rings (FR-07): the distinct calendar colors of `tasks` (`solidOf` maps a calendar to
 * its color), the most frequent first and the earlier one first among equals. Fewer colors than rings repeat the
 * first, so a bundle of one calendar shows a stack of one color; there are never more rings than tasks or than `max`.
 */
export function ringColors(tasks: CalItem[], solidOf: (calendarId: string) => string, max: number): string[] {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    const color = solidOf(task.calendarId)
    counts.set(color, (counts.get(color) ?? 0) + 1)
  }
  // Array.prototype.sort is stable, and a Map iterates in insertion order: ties keep their first appearance.
  const colors = [...counts].sort((a, b) => b[1] - a[1]).map(([color]) => color)
  const rings = Math.min(max, tasks.length)
  const [first] = colors
  if (first === undefined) return []
  return Array.from({ length: rings }, (_, i) => colors[i] ?? first)
}
