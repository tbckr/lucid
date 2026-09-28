import { useMemo } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { atMinutes } from '@/lib/dates'
import { timeOptions } from '@/lib/eventForm'
import { formatTime, type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'

const OPTIONS = timeOptions(15)

function label(value: string, prefs: FormatPrefs): string {
  const [h = 0, m = 0] = value.split(':').map(Number)
  return formatTime(atMinutes(new Date(2000, 0, 1), h * 60 + m), prefs)
}

/** Time picker honouring the 12h/24h preference, in 15-minute steps. */
export function TimeSelect({
  id,
  value,
  onChange,
  prefs,
  disabled,
  invalid,
  'aria-label': ariaLabel,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  prefs: FormatPrefs
  disabled?: boolean
  invalid?: boolean
  'aria-label'?: string
}) {
  const options = useMemo(() => (OPTIONS.includes(value) ? OPTIONS : [...OPTIONS, value].sort()), [value])
  return (
    <Select value={value} onValueChange={onChange} {...(disabled !== undefined ? { disabled } : {})}>
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid ? true : undefined}
        className={cn('tabular', prefs.hourCycle === '12h' ? 'w-[7rem]' : 'w-[5.75rem]')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-64">
        {options.map((o) => (
          <SelectItem key={o} value={o} className="tabular">
            {label(o, prefs)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
