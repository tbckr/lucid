import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { usePrefs } from '@/hooks/usePrefs'
import { type OffRule } from '@/lib/recurrence'
import { buildRRule, describeRRule, normalizeRRule, recurrenceFromRRule, type Recurrence } from '@/lib/rrule'
import { RecurrenceDialog } from './RecurrenceDialog'

export interface RepeatValue {
  recurrence: Recurrence
  customRule: string
}

// The select's entry that opens the repeat editor; never a value of the form.
const CUSTOMIZE = 'customize'

/**
 * The repeat select of the event and task editors (FR-17): the presets, named
 * after the start, the custom rule in words, and "Custom…", which opens the
 * repeat editor on the current repeat. A rule the editor hands back that a
 * preset says the same way becomes that preset; the custom rule stays in the
 * list to go back to.
 */
export function RepeatField({
  id,
  value,
  onChange,
  start,
  timeZone,
  presets,
  customizable,
  kept,
  explicit,
  offRule,
  disabled,
  invalid,
  describedBy,
}: {
  id: string
  value: RepeatValue
  onChange: (value: RepeatValue) => void
  start: Date
  timeZone: string
  presets: readonly Recurrence[]
  /** Offers "Custom…"; not for a rule Lucid can't read, which can only be kept or removed. */
  customizable: boolean
  /**
   * The series' rule as the editor opened it, and where it recurs from, where that lies elsewhere than `start`: a
   * task series keeps its days with its rule, but starts a changed one over at its repeat's dates (FR-17). The rule
   * is named, and the repeat editor opens on it, from there.
   */
  kept?: { rule: string; start: Date } | undefined
  /** An existing series: the repeat editor writes every day part (see `RecurrenceDialog`). */
  explicit?: boolean
  /** What a repeat that doesn't fall on `start` does to it, which the repeat editor says (see `RecurrenceDialog`, #11). */
  offRule?: OffRule | undefined
  disabled?: boolean
  invalid?: boolean
  describedBy?: string | undefined
}) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const now = useMemo(() => new Date(), [])
  const [editing, setEditing] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // The rule the repeat editor opens on; a series of dates has none, which Done replaces.
  const opened = buildRRule(value.recurrence, value.customRule)
  const dates = value.recurrence === 'custom' && !value.customRule.trim()
  // What a rule leaves to its start comes from where it recurs from (FR-17).
  const from = (rule: string) => (kept && normalizeRRule(rule) === normalizeRRule(kept.rule) ? kept.start : start)
  const words = (rule: string) => describeRRule(rule, from(rule), prefs, now, t)
  const custom = value.recurrence === 'custom' || value.customRule.trim() !== ''

  return (
    <>
      <Select
        value={value.recurrence}
        onValueChange={(v) => {
          if (v === CUSTOMIZE) setEditing(true)
          // Radix's hidden native select reports "" for an entry it doesn't hold yet, such as the
          // custom rule the repeat editor just added; only the entries offered are values.
          else if (v === 'custom' || presets.includes(v as Recurrence)) onChange({ recurrence: v as Recurrence, customRule: value.customRule })
        }}
        disabled={disabled}
      >
        <SelectTrigger
          ref={triggerRef}
          id={id}
          className="h-auto min-h-9 w-auto max-w-full min-w-48 text-left *:data-[slot=select-value]:line-clamp-2 *:data-[slot=select-value]:whitespace-normal"
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {presets.map((r) => (
            <SelectItem key={r} value={r}>
              {words(buildRRule(r))}
            </SelectItem>
          ))}
          {/* A series of dates without a rule has no words of its own. */}
          {custom && (
            <SelectItem value="custom">
              {dates ? t('recurrence.dates') : words(value.customRule)}
            </SelectItem>
          )}
          {customizable && <SelectItem value={CUSTOMIZE}>{t('recurrence.editor.customize')}</SelectItem>}
        </SelectContent>
      </Select>
      {customizable && (
        <RecurrenceDialog
          open={editing}
          onOpenChange={setEditing}
          rule={opened}
          start={start}
          opensFrom={from(opened)}
          timeZone={timeZone}
          explicit={explicit}
          foreign={dates}
          {...(offRule ? { offRule } : {})}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            triggerRef.current?.focus()
          }}
          onDone={(rule) => {
            // The rule it opened on, untouched: the stored text stays, however it is written,
            // since the server takes other text as a new rule (FR-17).
            if (rule === opened) return
            const preset = recurrenceFromRRule(rule)
            onChange(preset === 'custom' ? { recurrence: 'custom', customRule: rule } : { recurrence: preset, customRule: value.customRule })
          }}
        />
      )}
    </>
  )
}
