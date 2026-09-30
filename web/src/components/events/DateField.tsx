import { format } from 'date-fns'
import { ChevronDownIcon, XIcon } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { MiniMonth } from '@/components/layout/MiniMonth'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { parseDayKey } from '@/lib/dates'
import { formatPickerDate, type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'
import { onTint } from './EditorRow'

const dateRe = /^\d{4}-\d{2}-\d{2}$/

/**
 * Date input of the event and task editors: a button with the date in the
 * user's format ("Wed, Mar 11") that opens a month to pick from. The button is
 * named by `labelledBy` plus its own text, e.g. "Start Wed, Mar 11". Without a
 * value it reads as `placeholder`, as quiet as the other optional fields; with
 * `onClear`, the month offers to remove the date.
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
  placeholder,
  month,
  onClear,
  tone,
  isDisabled,
  footer,
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
  /** Text without a value, e.g. "Add a date". */
  placeholder?: string
  /** Month the picker opens on without a value; defaults to `now`. */
  month?: Date | undefined
  /** Removes the date; shown below the month as `onClear.label`. */
  onClear?: { label: string; clear: () => void } | undefined
  /** On a calendar's tint: reads as text until hovered or focused. */
  tone?: 'tint'
  /** A day a bounded series (FR-17) may not move to; passed through to `MiniMonth`. */
  isDisabled?: (day: Date) => boolean
  /** Extra content below the month, e.g. the window's last day; passed through to `MiniMonth`. */
  footer?: ReactNode
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
            !day && 'border-transparent bg-transparent text-muted-foreground hover:border-input hover:bg-transparent',
            // A button cannot be aria-invalid; the message it describes carries the error.
            invalid && 'border-destructive',
            tone === 'tint' && onTint,
          )}
        >
          {day ? formatPickerDate(day, prefs, now) : (placeholder ?? value)}
          {day && tone !== 'tint' && <ChevronDownIcon className="size-4 opacity-60" aria-hidden />}
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
          date={day ?? month ?? now}
          now={now}
          range={null}
          prefs={prefs}
          emphasis="selected"
          onSelect={(d) => {
            onChange(format(d, 'yyyy-MM-dd'))
            setOpen(false)
          }}
          isDisabled={isDisabled}
          footer={footer}
        />
        {onClear && day && (
          <div className="mt-2 border-t pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start text-muted-foreground"
              onClick={() => {
                onClear.clear()
                setOpen(false)
              }}
            >
              <XIcon aria-hidden />
              {onClear.label}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
