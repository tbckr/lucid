import { CheckIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { isFormTime, STEP_MINUTES } from '@/lib/dates'
import { timeOptions } from '@/lib/eventForm'
import { formatClock, type FormatPrefs } from '@/lib/format'
import { readTime } from '@/lib/typedTime'
import { cn } from '@/lib/utils'
import { FieldEnd, FieldSizer, onTint } from './EditorRow'
import { useTypedField, type CommitVia } from './useTypedField'

const OPTIONS = timeOptions(STEP_MINUTES)

/** Scrolls `box` to its entry `id`: into the middle, or just into sight. */
function reveal(box: HTMLElement | null, id: string, center: boolean) {
  const item = document.getElementById(id)
  if (!box || !item) return
  if (center) box.scrollTop = item.offsetTop - (box.clientHeight - item.offsetHeight) / 2
  else if (item.offsetTop < box.scrollTop) box.scrollTop = item.offsetTop
  else if (item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight) {
    box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight
  }
}

/**
 * Time field honouring the 12h/24h preference (FR-09): typed, minute-exact,
 * and read on Enter or when left (`readTime`), or picked from a list of the
 * day in 30-minute steps below it. The list follows the typing: a readable
 * time shows in its place, marked, before it is committed. A time off the
 * grid, saved or typed, shows in its sorted place.
 *
 * With `clearLabel`, the time can be left out (""): its ✕ removes it,
 * emptying the text clears it, and the empty field reads as `placeholder`, as
 * quiet as the other optional fields. Text it can't read
 * goes up as typed through `onChange` and marks the field.
 *
 * A combobox with a listbox popup (NFR-27): the focus stays in the text, the
 * arrow keys move through the list and write the entry into the text
 * (`aria-activedescendant`), Enter commits it, and Escape restores the last
 * value and closes the list, not the dialog around it.
 */
export function TimeField({
  id,
  value,
  onChange,
  prefs,
  disabled,
  invalid,
  clearLabel,
  placeholder,
  tone,
  describedBy,
  'aria-label': ariaLabel,
}: {
  id?: string
  /** "HH:mm", "", or text the field couldn't read. */
  value: string
  onChange: (value: string, via: CommitVia) => void
  prefs: FormatPrefs
  disabled?: boolean
  invalid?: boolean
  /** Name of the ✕ that removes the time, e.g. "Remove due time"; with it the time can be left out (""). */
  clearLabel?: string
  /** Text while there is no time, e.g. "Add a time". */
  placeholder?: string
  /** On a calendar's tint, like `DateField`. */
  tone?: 'tint'
  /** The ids of notes about the time, such as one summer time skips. */
  describedBy?: string | undefined
  'aria-label'?: string
}) {
  const clock = (v: string) => formatClock(v, prefs)
  const field = useTypedField({
    value,
    canonical: isFormTime,
    // The same text at rest and while typing: it reads back as it is.
    restText: clock,
    editText: clock,
    read: (text) => readTime(text, { prefs, current: value }),
    optional: clearLabel !== undefined,
    onChange,
  })
  const { inputProps, preview } = field
  const listId = useId()
  const anchor = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // The arrow keys moved the highlight, which `aria-activedescendant` then names; typing hands it back to the text,
  // and the list closing, however it closes, ends it (NFR-27).
  const [moved, setMoved] = useState(false)
  const open = field.open && !disabled
  if (!open && moved) setMoved(false)
  const tint = tone === 'tint'
  const empty = value === '' && clearLabel !== undefined
  // What the width of the text depends on, also for the texts it is at least as wide as.
  // On the tint, the ✕'s room after `px-1.5`, which would win otherwise.
  const metrics = cn(
    'tabular border-x px-3 text-sm',
    !tint && !empty && 'pr-8',
    tint && 'px-1.5 text-base font-medium',
    tint && clearLabel !== undefined && !empty && 'pr-7',
  )
  // On the tint, at least as wide as the last time it could read, so neither a shorter time typed nor text it can't
  // read moves the rest of the line. While empty, at least as wide as its placeholder, which the first digits typed
  // replace (FR-09).
  const sizes = empty ? [placeholder ?? ''] : tint && field.lastRead !== '' ? [clock(field.lastRead)] : []

  // The grid, with a saved or typed time off it in its sorted place.
  const times = useMemo(() => {
    const off = [value, preview].filter((v): v is string => v !== null && isFormTime(v) && !OPTIONS.includes(v))
    return off.length === 0 ? OPTIONS : [...new Set([...OPTIONS, ...off])].sort()
  }, [value, preview])
  const optionId = (v: string) => `${listId}-${v}`

  // The marked entry in sight as the typing or the arrow keys move it; the list opens on it (`onOpenAutoFocus`).
  // Typed, it shows in the middle, between the times around it; moved by the arrow keys, just in sight. No time marks
  // none: the ✕ removes it, not the list.
  const marked = preview === null || preview === '' ? null : optionId(preview)
  useEffect(() => {
    if (open && marked) reveal(list.current, marked, !moved)
  }, [open, marked, moved])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const at = times.indexOf(preview ?? value)
      const next =
        e.key === 'ArrowDown'
          ? times[at < 0 ? 0 : Math.min(at + 1, times.length - 1)]
          : times[at < 0 ? times.length - 1 : Math.max(at - 1, 0)]
      if (next === undefined) return
      field.setText(clock(next))
      setMoved(true)
      return
    }
    inputProps.onKeyDown?.(e)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        field.setOpen(next)
      }}
    >
      <PopoverAnchor asChild>
        <div
          ref={anchor}
          className={cn(
            'group/field relative inline-flex flex-col',
            !tint && !empty && (prefs.hourCycle === '12h' ? 'w-[7rem]' : 'w-[5.75rem]'),
          )}
        >
          <input
            {...inputProps}
            id={id}
            role="combobox"
            inputMode="numeric"
            aria-label={ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open && moved && marked ? marked : undefined}
            aria-autocomplete="none"
            aria-invalid={field.unreadable || invalid ? true : undefined}
            aria-describedby={describedBy}
            placeholder={placeholder}
            disabled={disabled}
            // On the tint and while empty, as wide as its text, or as its `sizes` where they are wider: by
            // `field-sizing` where the browser has it, else by `size`, which counts the placeholder only while it
            // shows.
            size={tint || empty ? Math.max(field.text === '' ? (placeholder ?? '').length : field.text.length, 1) : undefined}
            onChange={(e) => {
              setMoved(false)
              inputProps.onChange?.(e)
            }}
            onKeyDown={onKeyDown}
            className={cn(
              metrics,
              'peer h-9 w-full min-w-0 rounded-md border-y border-input bg-surface transition-[color,box-shadow] outline-none placeholder:text-muted-foreground',
              'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 aria-invalid:border-destructive aria-invalid:ring-destructive/25',
              'disabled:cursor-not-allowed disabled:opacity-50',
              (tint || empty) && 'field-sizing-content',
              empty && 'border-transparent bg-transparent hover:border-input',
              tint && [onTint, 'placeholder:text-current/75'],
            )}
          />
          <FieldSizer texts={sizes} className={metrics} />
          {!empty && (
            <FieldEnd
              input={inputProps.ref}
              clearLabel={clearLabel}
              onClear={() => {
                inputProps.ref.current?.focus()
                field.commit('pick', '')
              }}
              onOpen={() => {
                inputProps.ref.current?.focus()
                field.setOpen(true)
              }}
              tint={tint}
            />
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={list}
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        align="start"
        sideOffset={4}
        // Gone at once on a commit, so the next Escape or field doesn't meet a list still fading out.
        className="relative max-h-64 w-auto min-w-(--radix-popover-trigger-width) overflow-y-auto p-1 data-[state=closed]:animate-none!"
        onOpenAutoFocus={(e) => {
          // The focus stays in the text; the list opens on its marked entry.
          e.preventDefault()
          if (marked) reveal(list.current, marked, true)
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
        }}
        onInteractOutside={(e) => {
          // A click into the text keeps the list open.
          if (e.target instanceof Node && anchor.current?.contains(e.target)) e.preventDefault()
        }}
        onEscapeKeyDown={() => {
          // Only the list's layer takes this Escape: the dialog around stays (NFR-27).
          field.restore()
        }}
        onMouseDown={(e) => {
          // A press in the list keeps the focus in the text.
          e.preventDefault()
        }}
      >
        {times.map((v) => {
          const selected = v === preview
          return (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- the keyboard reaches the entries from the text, by the arrow keys and Enter (aria-activedescendant, NFR-27)
            <div
              key={v}
              id={optionId(v)}
              role="option"
              aria-selected={selected}
              tabIndex={-1}
              onClick={() => {
                field.commit('pick', v)
              }}
              className={cn(
                'relative flex cursor-default items-center rounded-md py-1.5 pr-8 pl-2 text-sm whitespace-nowrap select-none hover:bg-muted',
                'tabular',
                selected && 'bg-muted font-medium',
              )}
            >
              {clock(v)}
              {selected && <CheckIcon className="absolute right-2 size-4 text-primary" aria-hidden />}
            </div>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
