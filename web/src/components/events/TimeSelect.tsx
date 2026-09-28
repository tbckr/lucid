import { useMemo } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { atMinutes } from '@/lib/dates'
import { timeOptions } from '@/lib/eventForm'
import { formatTime, type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'

const OPTIONS = timeOptions(15)
// Radix Select items cannot have an empty value; this one stands for "no time".
const NONE = 'none'

function label(value: string, prefs: FormatPrefs): string {
  const [h = 0, m = 0] = value.split(':').map(Number)
  return formatTime(atMinutes(new Date(2000, 0, 1), h * 60 + m), prefs)
}

/**
 * Time picker honouring the 12h/24h preference, in 15-minute steps. With
 * `none`, the time can be left out (""): the list offers `none`, and the
 * empty picker reads as `placeholder`, as quiet as the other optional fields.
 */
export function TimeSelect({
  id,
  value,
  onChange,
  prefs,
  disabled,
  invalid,
  none,
  placeholder,
  'aria-label': ariaLabel,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  prefs: FormatPrefs
  disabled?: boolean
  invalid?: boolean
  /** Label of the "no time" option, e.g. "No time". */
  none?: string
  /** Text while there is no time, e.g. "Add a time"; defaults to `none`. */
  placeholder?: string
  'aria-label'?: string
}) {
  const options = useMemo(() => (value === '' || OPTIONS.includes(value) ? OPTIONS : [...OPTIONS, value].sort()), [value])
  const empty = value === '' && none !== undefined
  return (
    <Select
      value={empty ? NONE : value}
      onValueChange={(v) => {
        onChange(v === NONE ? '' : v)
      }}
      {...(disabled !== undefined ? { disabled } : {})}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid ? true : undefined}
        className={cn(
          'tabular',
          empty
            ? 'w-auto border-transparent bg-transparent text-muted-foreground hover:border-input [&>svg]:hidden'
            : prefs.hourCycle === '12h'
              ? 'w-[7rem]'
              : 'w-[5.75rem]',
        )}
      >
        <SelectValue>{empty ? (placeholder ?? none) : undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-64">
        {none !== undefined && <SelectItem value={NONE}>{none}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o} value={o} className="tabular">
            {label(o, prefs)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
