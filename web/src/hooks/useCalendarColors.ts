import { useMemo } from 'react'
import { eventColors, FALLBACK_COLOR } from '@/lib/color'
import { useIsDark } from './useTheme'
import { useVisibleCalendars } from './queries'

export type EventColors = ReturnType<typeof eventColors>

/** Precomputed, contrast-checked colors per calendar ID. */
export function useCalendarColors(): (calendarId: string) => EventColors {
  const dark = useIsDark()
  const { all } = useVisibleCalendars()
  return useMemo(() => {
    const map = new Map(all.map((c) => [c.id, eventColors(c.color, dark)]))
    const fallback = eventColors(FALLBACK_COLOR, dark)
    return (id: string) => map.get(id) ?? fallback
  }, [all, dark])
}
