import { addMonths, format, isSameDay, isSameMonth, isWithinInterval } from 'date-fns'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { dayKey, monthGrid, type DateRange } from '@/lib/dates'
import { weekdayNames, type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Small month calendar for navigation in the sidebar. */
export function MiniMonth({
  date,
  now,
  range,
  prefs,
  onSelect,
}: {
  date: Date
  now: Date
  /** Highlighted days (the visible week/day), or null. */
  range: DateRange | null
  prefs: FormatPrefs
  onSelect: (day: Date) => void
}) {
  const { t } = useTranslation()
  const [shown, setShown] = useState(date)
  const [prevDate, setPrevDate] = useState(date)
  // Follow the main view when it navigates (derived state reset).
  if (prevDate !== date) {
    setPrevDate(date)
    setShown(date)
  }
  const weeks = monthGrid(shown, prefs.weekStartsOn)
  const names = weekdayNames(prefs, 'narrow')

  return (
    <nav aria-label={t('sidebar.miniCalendar')} className="px-3">
      <div className="flex items-center justify-between pb-1 pl-2">
        <span className="font-display text-sm font-semibold" aria-live="polite">
          {format(shown, 'LLLL yyyy', { locale: prefs.locale })}
        </span>
        <div className="flex">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('nav.previousMonth')}
            onClick={() => {
              setShown((d) => addMonths(d, -1))
            }}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('nav.nextMonth')}
            onClick={() => {
              setShown((d) => addMonths(d, 1))
            }}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
        </div>
      </div>
      <table className="w-full table-fixed border-collapse text-center text-xs">
        <thead>
          <tr>
            {names.map((n, i) => (
              <th key={i} scope="col" className="h-7 font-medium text-muted-foreground">
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0] ? dayKey(week[0]) : 'w'}>
              {week.map((d) => {
                const today = isSameDay(d, now)
                const selected = range !== null && isWithinInterval(d, { start: range.start, end: new Date(range.end.getTime() - 1) })
                return (
                  <td key={dayKey(d)} className="p-0">
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(d)
                      }}
                      aria-label={format(d, 'PPPP', { locale: prefs.locale })}
                      aria-current={today ? 'date' : undefined}
                      aria-pressed={isSameDay(d, date)}
                      className={cn(
                        'tabular mx-auto flex size-7 items-center justify-center rounded-full outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                        !isSameMonth(d, shown) && 'text-muted-foreground',
                        selected && !today && 'bg-primary/10 font-medium text-foreground',
                        today && 'bg-primary font-semibold text-primary-foreground hover:bg-primary/90',
                      )}
                    >
                      {format(d, 'd')}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </nav>
  )
}
