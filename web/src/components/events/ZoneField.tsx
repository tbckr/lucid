import { CheckIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { dayKey, isFormDate, parseDayKey } from '@/lib/dates'
import { formatMonthDay, type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'
import { genericName, sameZone, warmZones, zoneCity, zoneGroups, zoneOffset, type ZoneGroup } from '@/lib/zones'
import { FieldEnd } from './EditorRow'
import { reveal, useTypedField } from './useTypedField'

/** An entry of the list: a zone in one of its groups, which a zone in use or here is in twice. */
interface Entry {
  key: string
  zone: string
  city: string
  /** "Eastern Time"; empty where Intl has no name of its own for the zone. */
  name: string
  /** "UTC−4" on the row's date; empty for a zone Intl does not know. */
  offset: string
}

interface Section {
  kind: ZoneGroup['kind']
  entries: Entry[]
}

/** The entry the arrow keys moved to. */
interface Moved {
  key: string
  zone: string
}

/**
 * Names Intl falls back to where it has none for the zone ("GMT+00:00" for UTC, "UTC+00:00" in French): the offset
 * says as much.
 */
const OFFSET_NAME = /^(GMT|UTC)[+\-−]/

/**
 * Time zone field of a row's date and time (FR-18): the zone at rest as its city, a typed search with a list of
 * the zones below it, the zone picked from the list. Like `TimeField`, a combobox with a listbox popup (NFR-27):
 * the focus stays in the text, the arrow keys move through the list and write the entry's city into the text
 * (`aria-activedescendant`), Enter commits it, and Escape restores the last zone and closes the list, not the
 * dialog around it.
 *
 * What is typed filters the list (`zoneGroups`) and is not a value: Enter and leaving take the entry the arrow
 * keys moved to, else the first match, and text that matches no zone restores the last zone, as does an emptied
 * field. The list marks the zone the field has with a ✓ and names the offsets of the row's `date`, once, at its
 * top. The groups are the browser's zone, the zones in `inUse`, and every zone by city.
 *
 * The ✕ shows while the field's zone is not `clearTo` and sets it: none for a single item, the browser's zone for
 * a series. A zone the same as the one the field has, under another name, is no change.
 */
export function ZoneField({
  id,
  value,
  onChange,
  clearTo,
  browserZone,
  date,
  inUse,
  prefs,
  disabled,
  autoFocus,
  describedBy,
  'aria-label': ariaLabel,
}: {
  id?: string
  /** An IANA zone, or "" for none: a single item's "Your time zone". */
  value: string
  onChange: (zone: string) => void
  /** What the ✕ sets: "" for a single item, the browser's zone for a series. */
  clearTo: string
  browserZone: string
  /** The row's "yyyy-MM-dd": the offsets in the list are that day's. */
  date: string
  /** The zones of the loaded items (`zonesInUse`). */
  inUse: string[]
  prefs: FormatPrefs
  disabled?: boolean
  /** Takes the focus and opens the list on mount, for a field shown by "Other time zone". */
  autoFocus?: boolean
  /** The ids of notes about the zone. */
  describedBy?: string | undefined
  'aria-label': string
}): ReactNode {
  const { t } = useTranslation()
  const listId = useId()
  const noteId = useId()
  const anchor = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const tag = prefs.tag
  // The offsets are noon UTC's on the row's day; a date the form can't read is today.
  const day = isFormDate(date) ? date : dayKey(new Date())
  const at = useMemo(() => new Date(`${day}T12:00:00Z`), [day])
  // By value: a parent passing a new array each render doesn't rebuild the list.
  const inUseKey = inUse.join('|')
  const used = useMemo(() => (inUseKey === '' ? [] : inUseKey.split('|')), [inUseKey])

  // What was typed to search the list, and the entry the arrow keys moved to, which writes its city into the text
  // and keeps the list as it was typed. Both end with the text being edited (see below).
  const [query, setQuery] = useState('')
  const [moved, setMoved] = useState<Moved | null>(null)
  // The groups of a search. The first match is what Enter and leaving take, so it exists while the list is closed
  // too, such as after a click beside it.
  const searched = useMemo(
    () => (query.trim() === '' ? null : zoneGroups({ query, at, tag, browserZone, inUse: used, current: value })),
    [query, at, tag, browserZone, used, value],
  )
  const first = searched?.[0]?.zones[0]

  const field = useTypedField({
    value,
    // Any zone is one to show, a stored one Intl doesn't know too; "" is none.
    canonical: () => true,
    restText: zoneCity,
    editText: zoneCity,
    // What Enter and leaving take: the entry the arrow keys moved to, else the first match of what was typed. Text
    // that matches no zone reads as the zone the field has, so it isn't committed but restored, which is also what
    // an emptied field does (FR-18).
    read: () => moved?.zone ?? first ?? value,
    optional: false,
    onChange: (zone) => {
      // The same zone under another name is no change (`Asia/Calcutta` for `Asia/Kolkata`).
      if (!sameZone(zone, value)) onChange(zone)
    },
  })
  const { inputProps } = field
  const open = field.open && !disabled
  if (!field.edited && (query !== '' || moved !== null)) {
    // The text is the zone's again after a commit, a restore or the focus: nothing typed, nothing moved to.
    setQuery('')
    setMoved(null)
  }
  const typed = field.edited && query.trim() !== ''

  // The groups the list shows, with the names and offsets of their zones: every zone while nothing is typed.
  const unfiltered = useMemo(
    () => (open && searched === null ? zoneGroups({ query: '', at, tag, browserZone, inUse: used, current: value }) : null),
    [open, searched, at, tag, browserZone, used, value],
  )
  const sections = useMemo<Section[]>(
    () =>
      open
        ? (searched ?? unfiltered ?? []).map(({ kind, zones }) => ({
            kind,
            entries: zones.map((zone) => {
              const name = genericName(zone, tag, 'longGeneric', at)
              return {
                key: `${kind}|${zone}`,
                zone,
                city: zoneCity(zone),
                name: OFFSET_NAME.test(name) ? '' : name,
                offset: zoneOffset(zone, at),
              }
            }),
          }))
        : [],
    [open, searched, unfiltered, tag, at],
  )
  const entries = useMemo(() => sections.flatMap((section) => section.entries), [sections])
  const optionId = (key: string) => `${listId}-${key}`

  // The marked entry is the one Enter takes: the arrow keys' (the highlight `aria-activedescendant` names), the
  // first match of a search, else the zone the field has, which the list opens on (NFR-27).
  const markedKey = moved
    ? moved.key
    : typed
      ? entries[0]?.key
      : value === ''
        ? undefined
        : entries.find((entry) => sameZone(entry.zone, value))?.key
  const marked = markedKey === undefined ? null : optionId(markedKey)
  useEffect(() => {
    if (open && marked) reveal(list.current, marked, moved === null)
  }, [open, marked, moved])

  // The list's names and offsets, for every zone, are built in the background once a field shows, and the names a
  // search reads once the list opens, rather than when it opens or the first key is typed (FR-18).
  useEffect(() => {
    warmZones(tag, 'list')
  }, [tag])
  useEffect(() => {
    if (open) warmZones(tag, 'search')
  }, [open, tag])

  // Shown by "Other time zone" (FR-18): once, when it appears.
  useEffect(() => {
    if (!autoFocus) return
    inputProps.ref.current?.focus()
    field.setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only: a later change of the prop or the field must not take the focus again
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const index = entries.findIndex((entry) => entry.key === markedKey)
      const next =
        e.key === 'ArrowDown'
          ? entries[index < 0 ? 0 : Math.min(index + 1, entries.length - 1)]
          : entries[index < 0 ? entries.length - 1 : Math.max(index - 1, 0)]
      if (next === undefined) return
      field.setText(next.city)
      setMoved({ key: next.key, zone: next.zone })
      return
    }
    inputProps.onKeyDown?.(e)
  }

  const clearable = !sameZone(value, clearTo)
  const notes = [describedBy, value === '' ? undefined : noteId].filter(Boolean).join(' ')

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        field.setOpen(next)
      }}
    >
      <PopoverAnchor asChild>
        <div ref={anchor} className="group/field relative inline-flex w-44 max-w-full flex-col">
          <input
            {...inputProps}
            id={id}
            role="combobox"
            aria-label={ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open && sections.length > 0 ? listId : undefined}
            aria-activedescendant={open && moved && marked ? marked : undefined}
            aria-autocomplete="list"
            aria-describedby={notes === '' ? undefined : notes}
            // Quiet beside the zones: none is the user's own, which the fields of the row are in.
            placeholder={value === '' ? t('zone.yours') : undefined}
            disabled={disabled}
            onChange={(e) => {
              setQuery(e.target.value)
              setMoved(null)
              inputProps.onChange?.(e)
            }}
            onKeyDown={onKeyDown}
            // At rest the city is quiet beside the time, as "Your time zone" is; typed in, it is ink (FR-18).
            className={cn(
              'peer h-9 w-full min-w-0 rounded-md border border-input bg-surface pr-8 pl-3 text-sm text-muted-foreground transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus:text-foreground',
              'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          />
          {value !== '' && (
            // The city is short for the zone; a screen reader gets the whole ID.
            <span id={noteId} className="sr-only">
              {value}
            </span>
          )}
          {/* The focus stays in the text, so an empty list is announced from here: by a live region that is there
              before the list empties, as one added with its text would go unsaid (NFR-27). */}
          <span role="status" className="sr-only">
            {open && sections.length === 0 ? t('zone.none') : ''}
          </span>
          <FieldEnd
            input={inputProps.ref}
            clearLabel={clearable ? t('zone.useYours') : undefined}
            onClear={() => {
              // The ✕ sets a zone of its own, not the text's: whatever was typed is dropped.
              field.restore()
              onChange(clearTo)
            }}
            onOpen={() => {
              inputProps.ref.current?.focus()
              field.setOpen(true)
            }}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        // Gone at once on a commit, so the next Escape or field doesn't meet a list still fading out.
        className="w-[26rem] max-w-(--radix-popover-content-available-width) min-w-(--radix-popover-trigger-width) p-0 data-[state=closed]:animate-none!"
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
        {sections.length === 0 ? (
          // For the eye: the field's live region says it (NFR-27).
          <p aria-hidden className="px-3 py-2.5 text-sm text-muted-foreground">
            {t('zone.none')}
          </p>
        ) : (
          <>
            {/* The offsets below are this day's. Decoration for the eye: the entries are named by their IDs. */}
            <div aria-hidden className="px-3 pt-2 pb-1 text-right text-xs text-muted-foreground">
              {t('zone.on', { date: formatMonthDay(parseDayKey(day), prefs) })}
            </div>
            <div
              ref={list}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              className="relative max-h-64 overflow-y-auto p-1 pt-0"
            >
              {sections.map((section, i) => {
                const label = section.kind === 'here' ? t('zone.here') : section.kind === 'inUse' ? t('zone.inUse') : null
                const labelId = `${listId}-${section.kind}`
                return (
                  <div
                    key={section.kind}
                    role={label === null ? undefined : 'group'}
                    aria-labelledby={label === null ? undefined : labelId}
                    // Every zone follows the groups above it under a divider, with no heading of its own.
                    className={cn(i > 0 && section.kind === 'all' && 'mt-1 border-t border-border pt-1')}
                  >
                    {label !== null && (
                      <div id={labelId} className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
                        {label}
                      </div>
                    )}
                    {section.entries.map((entry) => (
                      // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- the keyboard reaches the entries from the text, by the arrow keys and Enter (aria-activedescendant, NFR-27)
                      <div
                        key={entry.key}
                        id={optionId(entry.key)}
                        role="option"
                        aria-selected={entry.key === markedKey}
                        aria-label={`${entry.city}, ${entry.zone}`}
                        // The offset of the row's date, which the eye reads in its column (NFR-27).
                        aria-describedby={entry.offset === '' ? undefined : `${optionId(entry.key)}-offset`}
                        tabIndex={-1}
                        onClick={() => {
                          field.commit('pick', entry.zone)
                        }}
                        className={cn(
                          'relative flex cursor-default items-center gap-3 rounded-md py-1.5 pr-8 pl-2 text-sm select-none hover:bg-muted',
                          entry.key === markedKey && 'bg-muted',
                        )}
                      >
                        <span className="shrink-0 font-medium whitespace-nowrap">{entry.city}</span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.name}</span>
                        <span
                          id={`${optionId(entry.key)}-offset`}
                          className="tabular w-[4.5rem] shrink-0 text-right whitespace-nowrap"
                        >
                          {entry.offset}
                        </span>
                        {value !== '' && sameZone(entry.zone, value) && (
                          <CheckIcon className="absolute right-2 size-4 text-primary" aria-hidden />
                        )}
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
