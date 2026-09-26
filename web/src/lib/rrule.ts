/**
 * Minimal RRULE support for the event editor: the simple presets map to a
 * bare FREQ rule (the weekday/day of month is implied by DTSTART). Existing
 * rules the editor cannot express are kept verbatim as "custom".
 */

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom'

export const RECURRENCE_PRESETS = ['none', 'daily', 'weekly', 'monthly', 'yearly'] as const

const FREQ_BY_PRESET = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  yearly: 'YEARLY',
} as const

/** Build the RRULE value (without "RRULE:") for a preset. */
export function buildRRule(recurrence: Recurrence, customRule = ''): string {
  if (recurrence === 'none') return ''
  if (recurrence === 'custom') return normalizeRRule(customRule)
  return `FREQ=${FREQ_BY_PRESET[recurrence]}`
}

/** Uppercase, strip an "RRULE:" prefix, whitespace and empty parts. */
export function normalizeRRule(rule: string): string {
  return rule
    .trim()
    .replace(/^RRULE:/i, '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [k = '', v = ''] = p.split('=')
      return `${k.toUpperCase()}=${v.toUpperCase()}`
    })
    .join(';')
}

/** Parse "FREQ=WEEKLY;INTERVAL=2" into a key/value map. */
export function parseRRule(rule: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of normalizeRRule(rule).split(';')) {
    if (!part) continue
    const [k, v] = part.split('=')
    if (k && v !== undefined) map.set(k, v)
  }
  return map
}

/** Map an RRULE back to a preset; anything beyond a plain FREQ is "custom". */
export function recurrenceFromRRule(rule: string | undefined | null): Recurrence {
  if (!rule?.trim()) return 'none'
  const parts = parseRRule(rule)
  const freq = parts.get('FREQ')
  const interval = parts.get('INTERVAL')
  const extra = [...parts.keys()].filter((k) => k !== 'FREQ' && k !== 'INTERVAL' && k !== 'WKST')
  if (extra.length > 0 || (interval !== undefined && interval !== '1')) return 'custom'
  switch (freq) {
    case 'DAILY':
      return 'daily'
    case 'WEEKLY':
      return 'weekly'
    case 'MONTHLY':
      return 'monthly'
    case 'YEARLY':
      return 'yearly'
    default:
      return 'custom'
  }
}
