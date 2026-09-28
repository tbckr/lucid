import { format } from 'date-fns'
import { ChevronDownIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { MiniMonth } from '@/components/layout/MiniMonth'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { parseDayKey } from '@/lib/dates'
import { formatPickerDate, type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'

const dateRe = /^\d{4}-\d{2}-\d{2}$/

/**
 * Date input of the event editor: a button with the date in the user's
 * format ("Wed, Mar 11") that opens a month to pick from. The button is named
 * by `labelledBy` plus its own text, e.g. "Start Wed, Mar 11".
 */
export function DateField({
  id,
  value,
  onChange,
  label,
  labelledBy,
  prefs,
  now,
  quiet,
  invalid,
  describedBy,
}: {
  id: string
  /** "yyyy-MM-dd". */
  value: string
  onChange: (value: string) => void
  /** Name of the month popover, e.g. "Start date". */
  label: string
  labelledBy: string
  prefs: FormatPrefs
  now: Date
  /** Dimmed text, for an end date that repeats the start date. */
  quiet?: boolean
  invalid?: boolean
  describedBy?: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const day = dateRe.test(value) ? parseDayKey(value) : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          aria-labelledby={`${labelledBy} ${id}`}
          aria-describedby={describedBy}
          className={cn(
            'tabular flex h-9 items-center gap-2 rounded-md border border-input bg-surface px-3 text-sm whitespace-nowrap transition-[color,box-shadow] outline-none hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
            quiet && 'text-muted-foreground',
            // A button cannot be aria-invalid; the message it describes carries the error.
            invalid && 'border-destructive',
          )}
        >
          {day ? formatPickerDate(day, prefs, now) : value}
          <ChevronDownIcon className="size-4 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        className="w-64 p-2"
        aria-label={label}
        onOpenAutoFocus={(e) => {
          // Start on the chosen day, not on the month buttons.
          e.preventDefault()
          contentRef.current?.querySelector<HTMLElement>('[data-day][tabindex="0"]')?.focus()
        }}
      >
        <MiniMonth
          date={day ?? now}
          now={now}
          range={null}
          prefs={prefs}
          emphasis="selected"
          onSelect={(d) => {
            onChange(format(d, 'yyyy-MM-dd'))
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
