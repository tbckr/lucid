import { addDays, addMonths, format, isSameDay, isSameMonth, startOfMonth } from 'date-fns'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { dayKey, monthGrid, type DateRange } from '@/lib/dates'
import { weekdayNames, type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'

const ARROW_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }

type BandPart = 'start' | 'middle' | 'end' | 'single'

/** A day's part of the band that marks the visible range in its week row, or undefined outside it. */
function bandPart(week: Date[], i: number, range: DateRange | null): BandPart | undefined {
  const inRange = (d: Date | undefined) => d !== undefined && range !== null && d >= range.start && d < range.end
  if (!inRange(week[i])) return undefined
  const first = !inRange(week[i - 1])
  const last = !inRange(week[i + 1])
  return first && last ? 'single' : first ? 'start' : last ? 'end' : 'middle'
}

// The band's caps wrap the circle of its first and last day (size-7, centered in the cell), so it starts and ends there.
const BAND =
  'flex justify-center data-[range]:bg-primary/12 data-[range=start]:justify-start data-[range=end]:justify-end data-[range=start]:ml-[calc(50%-0.875rem)] data-[range=start]:rounded-l-full data-[range=end]:mr-[calc(50%-0.875rem)] data-[range=end]:rounded-r-full data-[range=single]:mx-auto data-[range=single]:w-7 data-[range=single]:rounded-full'

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
  isDisabled,
  footer,
}: {
  /** The chosen day (the view's date in the sidebar). */
  date: Date
  now: Date
  /** The visible week or day, drawn as one band like an event across its days; or null. */
  range: DateRange | null
  prefs: FormatPrefs
  /** Which day gets the solid mark: today (navigation) or the chosen day (picker). */
  emphasis?: 'today' | 'selected'
  onSelect: (day: Date) => void
  /** A day a bounded series (FR-17) may not move to: a real disabled button, kept in the arrow-key traversal. */
  isDisabled?: (day: Date) => boolean
  /** Extra content below the month grid, e.g. the window's last day. */
  footer?: ReactNode
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
              {week.map((d, i) => {
                const today = isSameDay(d, now)
                const chosen = isSameDay(d, date)
                const solid = emphasis === 'today' ? today : chosen
                const blocked = isDisabled?.(d) ?? false
                return (
                  <td key={dayKey(d)} className="p-0">
                    <div data-range={bandPart(week, i, range)} className={BAND}>
                      <button
                        type="button"
                        data-day={dayKey(d)}
                        disabled={blocked}
                        aria-disabled={blocked}
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
                          'tabular flex size-7 items-center justify-center rounded-full outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
                          !isSameMonth(d, shown) && 'text-muted-foreground',
                          today && !solid && 'font-semibold text-primary',
                          solid && 'bg-primary font-semibold text-primary-foreground hover:bg-primary/90',
                        )}
                      >
                        {format(d, 'd')}
                      </button>
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </div>
  )
}
