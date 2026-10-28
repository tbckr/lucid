import { useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { MiniMonth } from '@/components/layout/MiniMonth'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { dayKey, isFormDate, parseDayKey } from '@/lib/dates'
import { formatPickerDate, type FormatPrefs } from '@/lib/format'
import { formatTypedDate, readDate } from '@/lib/typedDate'
import { cn } from '@/lib/utils'
import { FieldEnd, FieldSizer, onTint } from './EditorRow'
import { useTypedField, type CommitVia } from './useTypedField'

/**
 * Date field of the editors, the create popover and the repeat editor
 * (FR-09): the date in the user's format at rest ("Wed, Mar 11"), its numbers
 * while focused ("3/11/2026"), typed and read on Enter or when left
 * (`readDate`, numbers only), or picked from the month below it. The month
 * follows the typing: a readable date shows there, marked, before it is
 * committed. Parts left out come from the date in the field, else from the
 * month the picker opens on (`month`), else from today.
 *
 * Without a value it reads as `placeholder`, as quiet as the other optional
 * fields. With `onClear` the date can be left out: the ✕ in the field removes
 * it, and emptying the text clears it. Text it can't read goes up as typed
 * through `onChange` and marks the field; a day `isDisabled` refuses is read
 * all the same, for the form to say why.
 *
 * A combobox with a dialog popup (NFR-27), named by its row (`labelledBy`):
 * ArrowDown moves into the month on the typed or chosen day, Escape there
 * returns to the text; Escape restores the last value and closes the month,
 * not the dialog around it.
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
  /** "yyyy-MM-dd", "", or text the field couldn't read. */
  value: string
  onChange: (value: string, via: CommitVia) => void
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
  /** Month the picker opens on without a value, and where a typed date takes the parts left out; defaults to `now`. */
  month?: Date | undefined
  /** Removes the date, by the ✕ in the field named `onClear.label`, or when the text is emptied. */
  onClear?: { label: string; clear: () => void } | undefined
  /** On a calendar's tint: reads as text until hovered or focused. */
  tone?: 'tint'
  /** A day that can't be picked; passed through to `MiniMonth`. */
  isDisabled?: (day: Date) => boolean
  /** Extra content below the month, e.g. a note on what picking a day does; passed through to `MiniMonth`. */
  footer?: ReactNode
}) {
  const day = isFormDate(value) ? parseDayKey(value) : null
  const field = useTypedField({
    value,
    canonical: isFormDate,
    restText: (v) => formatPickerDate(parseDayKey(v), prefs, now),
    editText: (v) => formatTypedDate(parseDayKey(v), prefs),
    read: (text) => readDate(text, { prefs, base: day ?? month ?? now }),
    optional: onClear !== undefined,
    onChange: (v, via) => {
      if (v === '') onClear?.clear()
      else onChange(v, via)
    },
  })
  const { inputProps, preview } = field
  const input = inputProps.ref
  const anchor = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  // ArrowDown opened the month to move into it.
  const intoMonth = useRef(false)
  const open = field.open
  const tint = tone === 'tint'
  const empty = value === ''
  const popupId = `${id}-month`
  // What the width of the text depends on, also for the texts it is at least as wide as.
  // On the tint, the ✕'s room after `px-1.5`, which would win otherwise.
  const metrics = cn(
    'tabular border-x px-3 text-sm',
    !tint && !empty && 'pr-8',
    tint && 'px-1.5 text-base font-medium',
    tint && onClear && !empty && 'pr-7',
  )
  // At least as wide as the last date the field could read, as it shows at rest, so neither shorter numbers typed nor
  // text it can't read move what follows it, and as wide as the numbers of a two-digit day of its month (the 28th),
  // so neither the focus nor a longer day typed does. On the tint only while it has the focus: there the numbers'
  // room, held at rest, would part the sentence, so it comes with the focus, as the outline does. While empty, at
  // least as wide as its placeholder, which the first digits typed replace (FR-09).
  const lastDay = field.lastRead === '' ? null : parseDayKey(field.lastRead)
  const withNumbers = !tint || field.focused
  const sizes = empty
    ? [placeholder ?? '']
    : lastDay
      ? [
          formatPickerDate(lastDay, prefs, now),
          ...(withNumbers ? [formatTypedDate(new Date(lastDay.getFullYear(), lastDay.getMonth(), 28), prefs)] : []),
        ]
      : []

  // The day the month shows and marks: what a commit would take now, else the date in the field, else the month
  // it opens on. One Date per day, as the month starts over on every new one.
  const shown = preview !== null && preview !== '' ? preview : day ? value : dayKey(month ?? now)
  const shownDay = useMemo(() => parseDayKey(shown), [shown])

  const inMonth = (node: EventTarget | null) => node instanceof Node && content.current?.contains(node) === true
  const focusDay = () => content.current?.querySelector<HTMLElement>('[data-day][tabindex="0"]')?.focus()

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && !e.nativeEvent.isComposing) {
      // Into the month, on the typed or chosen day; with Alt too (NFR-27).
      e.preventDefault()
      if (open) {
        focusDay()
      } else {
        intoMonth.current = true
        field.setOpen(true)
      }
      return
    }
    // Tab leaves the field, for the next one in the form, not for the month the page holds after it.
    if (e.key === 'Tab' && open) {
      flushSync(() => {
        field.setOpen(false)
      })
    }
    inputProps.onKeyDown?.(e)
  }

  // A pick from the month, or the ✕: the focus goes back to the text, which shows what was taken.
  const pick = (next: string) => {
    input.current?.focus()
    field.commit('pick', next)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        field.setOpen(next)
      }}
    >
      <PopoverAnchor asChild>
        <div ref={anchor} className="group/field relative inline-flex flex-col">
          <input
            {...inputProps}
            id={id}
            role="combobox"
            inputMode="numeric"
            aria-labelledby={labelledBy}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? popupId : undefined}
            aria-invalid={field.unreadable || invalid ? true : undefined}
            aria-describedby={describedBy}
            placeholder={placeholder}
            // As wide as its text, or as its `sizes` where they are wider: by `field-sizing` where the browser has it,
            // else by `size`.
            size={Math.max(field.text === '' ? (placeholder ?? '').length : field.text.length, 1)}
            onFocus={(e) => {
              // Back from the month: the text stays as it was.
              if (inMonth(e.relatedTarget)) {
                e.currentTarget.select()
                return
              }
              inputProps.onFocus?.(e)
            }}
            onBlur={(e) => {
              // Into the month: the field isn't left.
              if (inMonth(e.relatedTarget)) return
              inputProps.onBlur?.(e)
            }}
            onKeyDown={onKeyDown}
            className={cn(
              metrics,
              'peer field-sizing-content h-9 min-w-0 rounded-md border-y border-input bg-surface transition-[color,box-shadow] outline-none placeholder:text-muted-foreground',
              'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 aria-invalid:border-destructive aria-invalid:ring-destructive/25',
              'disabled:cursor-not-allowed disabled:opacity-50',
              quiet && !field.focused && 'text-muted-foreground',
              empty && 'border-transparent bg-transparent hover:border-input',
              tint && [onTint, 'placeholder:text-current/75'],
            )}
          />
          <FieldSizer texts={sizes} className={metrics} />
          {!empty && (
            <FieldEnd
              input={input}
              clearLabel={onClear?.label}
              onClear={() => {
                pick('')
              }}
              onOpen={() => {
                input.current?.focus()
                field.setOpen(true)
              }}
              tint={tint}
            />
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={content}
        id={popupId}
        aria-label={label}
        align="start"
        // Gone at once on a commit, so the next Escape or field doesn't meet a month still fading out.
        className="w-64 p-2 data-[state=closed]:animate-none!"
        onOpenAutoFocus={(e) => {
          // The focus stays in the text, unless ArrowDown opened the month to move into it.
          e.preventDefault()
          if (intoMonth.current) focusDay()
          intoMonth.current = false
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
        }}
        onInteractOutside={(e) => {
          // A click into the text keeps the month open.
          if (e.target instanceof Node && anchor.current?.contains(e.target)) e.preventDefault()
        }}
        onEscapeKeyDown={() => {
          // Only the month's layer takes this Escape: the dialog around stays (NFR-27). From the month, the
          // focus goes back to the text.
          if (inMonth(document.activeElement)) input.current?.focus()
          field.restore()
        }}
        onMouseDown={(e) => {
          // A press in the month keeps the focus where it is, so the text isn't left for it.
          e.preventDefault()
        }}
        onBlur={(e) => {
          // The focus left the month, and not for the text: the field is left.
          if (inMonth(e.relatedTarget) || e.relatedTarget === input.current) return
          field.leave(e.relatedTarget)
        }}
      >
        <MiniMonth
          date={shownDay}
          now={now}
          range={null}
          prefs={prefs}
          emphasis="selected"
          onSelect={(d) => {
            pick(dayKey(d))
          }}
          isDisabled={isDisabled}
          footer={footer}
        />
      </PopoverContent>
    </Popover>
  )
}
