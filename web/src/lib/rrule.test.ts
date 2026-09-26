import { describe, expect, it } from 'vitest'
import { buildRRule, normalizeRRule, parseRRule, recurrenceFromRRule } from './rrule'

describe('rrule', () => {
  it('builds presets', () => {
    expect(buildRRule('none')).toBe('')
    expect(buildRRule('daily')).toBe('FREQ=DAILY')
    expect(buildRRule('weekly')).toBe('FREQ=WEEKLY')
    expect(buildRRule('monthly')).toBe('FREQ=MONTHLY')
    expect(buildRRule('yearly')).toBe('FREQ=YEARLY')
    expect(buildRRule('custom', 'rrule:freq=weekly; byday=mo,we ;')).toBe('FREQ=WEEKLY;BYDAY=MO,WE')
  })

  it('parses rules', () => {
    expect([...parseRRule('FREQ=WEEKLY;INTERVAL=2;BROKEN').entries()]).toEqual([
      ['FREQ', 'WEEKLY'],
      ['INTERVAL', '2'],
      ['BROKEN', ''],
    ])
    expect(normalizeRRule('')).toBe('')
  })

  it.each([
    [undefined, 'none'],
    ['', 'none'],
    ['FREQ=DAILY', 'daily'],
    ['FREQ=WEEKLY;INTERVAL=1', 'weekly'],
    ['FREQ=WEEKLY;WKST=MO', 'weekly'],
    ['FREQ=MONTHLY', 'monthly'],
    ['freq=yearly', 'yearly'],
    ['FREQ=WEEKLY;BYDAY=MO', 'custom'],
    ['FREQ=DAILY;INTERVAL=2', 'custom'],
    ['FREQ=DAILY;COUNT=3', 'custom'],
    ['FREQ=HOURLY', 'custom'],
  ])('maps %s to %s', (rule, preset) => {
    expect(recurrenceFromRRule(rule)).toBe(preset)
  })
})
