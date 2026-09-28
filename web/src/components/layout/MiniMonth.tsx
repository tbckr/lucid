import { addDays, addMonths, format, isSameDay, isSameMonth, isWithinInterval, startOfMonth } from 'date-fns'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useRef, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { dayKey, monthGrid, type DateRange } from '@/lib/dates'
import { weekdayNames, type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'

const ARROW_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }

/**
 * Small month calendar: navigation in the sidebar, date picker in the event
 * editor. The days form one tab stop; the arrow keys move between them (NFR-27).
 */
export function MiniMonth({
  date,
  now,
  range,
  prefs,
  emphasis = 'today',
  onSelect,
}: {
  /** The chosen day (the view's date in the sidebar). */
  date: Date
  now: Date
  /** Highlighted days (the visible week/day), or null. */
  range: DateRange | null
  prefs: FormatPrefs
  /** Which day gets the solid mark: today (navigation) or the chosen day (picker). */
  emphasis?: 'today' | 'selected'
  onSelect: (day: Date) => void
}) {
  const { t } = useTranslation()
  const [shown, setShown] = useState(date)
  const [active, setActive] = useState(date)
  const [prevDate, setPrevDate] = useState(date)
  const tableRef = useRef<HTMLTableElement>(null)
  // Follow the main view when it navigates (derived state reset).
  if (prevDate !== date) {
    setPrevDate(date)
    setShown(date)
    setActive(date)
  }
  const weeks = monthGrid(shown, prefs.weekStartsOn)
  const names = weekdayNames(prefs, 'narrow')
  const tabStop = weeks.some((w) => w.some((d) => isSameDay(d, active))) ? active : startOfMonth(shown)

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = ARROW_STEPS[e.key]
    if (step === undefined) return
    e.preventDefault()
    const next = addDays(active, step)
    flushSync(() => {
      setActive(next)
      if (!isSameMonth(next, shown)) setShown(next)
    })
    tableRef.current?.querySelector<HTMLButtonElement>(`[data-day="${dayKey(next)}"]`)?.focus()
  }

  return (
    <div>
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
      <table ref={tableRef} className="w-full table-fixed border-collapse text-center text-xs">
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
                const chosen = isSameDay(d, date)
                const solid = emphasis === 'today' ? today : chosen
                const selected = range !== null && isWithinInterval(d, { start: range.start, end: new Date(range.end.getTime() - 1) })
                return (
                  <td key={dayKey(d)} className="p-0">
                    <button
                      type="button"
                      data-day={dayKey(d)}
                      tabIndex={isSameDay(d, tabStop) ? 0 : -1}
                      onKeyDown={onKeyDown}
                      onClick={() => {
                        setActive(d)
                        onSelect(d)
                      }}
                      aria-label={format(d, 'PPPP', { locale: prefs.locale })}
                      aria-current={today ? 'date' : undefined}
                      aria-pressed={chosen}
                      className={cn(
                        'tabular mx-auto flex size-7 items-center justify-center rounded-full outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                        !isSameMonth(d, shown) && 'text-muted-foreground',
                        selected && !solid && 'bg-primary/10 font-medium text-foreground',
                        today && !solid && 'font-semibold text-primary',
                        solid && 'bg-primary font-semibold text-primary-foreground hover:bg-primary/90',
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
    </div>
  )
}
