import { describe, expect, it } from 'vitest'
import { todo } from '@/test/fixtures'
import { buildTaskFormSchema, dayAllowed, formToTodoInput, formWithDate, taskFormSchema, taskToForm, withDue } from './taskForm'

const TZ = 'Europe/Berlin'

describe('taskForm', () => {
  it('round-trips all-day and timed due dates', () => {
    const allDay = taskToForm(todo({ due: '2026-09-25T00:00:00Z', dueAllDay: true }), TZ)
    expect(allDay).toMatchObject({ dueDate: '2026-09-25', dueTime: '' })
    expect(formToTodoInput(allDay, TZ)).toMatchObject({ due: '2026-09-25T00:00:00.000Z', dueAllDay: true })

    const timed = taskToForm(todo({ due: '2026-09-25T15:30:00Z' }), TZ)
    expect(timed).toMatchObject({ dueDate: '2026-09-25', dueTime: '17:30' })
    expect(formToTodoInput(timed, TZ)).toMatchObject({ due: '2026-09-25T15:30:00.000Z', dueAllDay: false })

    expect(formToTodoInput(taskToForm(todo(), TZ), TZ)).toMatchObject({ due: null, dueAllDay: false })
  })

  it('keeps IN-PROCESS unless completed', () => {
    const t = todo({ status: 'IN-PROCESS' })
    const v = taskToForm(t, TZ)
    expect(formToTodoInput(v, TZ, t).status).toBe('IN-PROCESS')
    expect(formToTodoInput({ ...v, completed: true }, TZ, t).status).toBe('COMPLETED')
    const done = todo({ status: 'COMPLETED' })
    expect(formToTodoInput({ ...taskToForm(done, TZ), completed: false }, TZ, done).status).toBe('NEEDS-ACTION')
  })

  it('trims checklist items and title', () => {
    const v = { ...taskToForm(todo(), TZ), title: '  x ', checklist: [{ text: ' a ', done: true }] }
    expect(formToTodoInput(v, TZ)).toMatchObject({ title: 'x', checklist: [{ text: 'a', done: true }] })
  })

  it('validates', () => {
    const v = taskToForm(todo(), TZ)
    expect(taskFormSchema.safeParse(v).success).toBe(true)
    const messages = (x: unknown) => taskFormSchema.safeParse(x).error?.issues.map((i) => i.message)
    expect(messages({ ...v, title: '   ' })).toContain('validation.titleRequired')
    expect(messages({ ...v, dueTime: '10:00' })).toContain('validation.dateForTime')
    expect(messages({ ...v, checklist: [{ text: '', done: false }] })).toContain('validation.itemRequired')
    expect(messages({ ...v, dueDate: '25.09.2026' })).toBeDefined()
  })

  describe('start date', () => {
    const v = taskToForm(todo(), TZ)
    const issues = (x: unknown) => taskFormSchema.safeParse(x).error?.issues.map((i) => [i.path.join('.'), i.message])

    it('rejects a start time without a start date', () => {
      expect(issues({ ...v, startTime: '09:00' })).toContainEqual(['startDate', 'validation.dateForTime'])
    })

    it('rejects start and due of different types', () => {
      const x = { ...v, startDate: '2026-09-25', startTime: '09:00', dueDate: '2026-09-26', dueTime: '' }
      expect(issues(x)).toContainEqual(['startDate', 'validation.startDueType'])
    })

    it('rejects a start after the due date', () => {
      expect(issues({ ...v, startDate: '2026-09-26', dueDate: '2026-09-25' })).toContainEqual([
        'startDate',
        'validation.startAfterDue',
      ])
      const timed = { ...v, startDate: '2026-09-25', startTime: '11:00', dueDate: '2026-09-25', dueTime: '10:00' }
      expect(issues(timed)).toContainEqual(['startDate', 'validation.startAfterDue'])
    })

    it('accepts a start equal to the due date', () => {
      const x = { ...v, startDate: '2026-09-25', startTime: '10:00', dueDate: '2026-09-25', dueTime: '10:00' }
      expect(taskFormSchema.safeParse(x).success).toBe(true)
    })

    it('round-trips a timed start', () => {
      const form = taskToForm(todo({ start: '2026-09-25T07:00:00Z', due: '2026-09-25T09:00:00Z' }), TZ)
      expect(form).toMatchObject({ startDate: '2026-09-25', startTime: '09:00', dueTime: '11:00' })
      expect(formToTodoInput(form, TZ)).toMatchObject({ start: '2026-09-25T07:00:00.000Z', startAllDay: false })
    })

    it('maps a start date without time to an all-day start', () => {
      expect(formToTodoInput({ ...v, startDate: '2026-09-25' }, TZ)).toMatchObject({
        start: '2026-09-25T00:00:00.000Z',
        startAllDay: true,
      })
      expect(formToTodoInput(v, TZ)).toMatchObject({ start: null, startAllDay: false })
    })
  })

  describe('withDue', () => {
    it('moves an all-day due date and its start by the same days, keeping the rest', () => {
      const t = todo({ title: ' as is ', start: '2026-09-20T00:00:00Z', startAllDay: true, due: '2026-09-25T00:00:00Z', dueAllDay: true })
      expect(withDue(t, { date: '2026-09-30', time: '' }, TZ)).toMatchObject({
        title: ' as is ',
        start: '2026-09-25T00:00:00.000Z',
        startAllDay: true,
        due: '2026-09-30T00:00:00.000Z',
        dueAllDay: true,
      })
    })

    it('keeps the local time of a timed due date across a DST change', () => {
      const t = todo({ due: '2026-10-24T07:00:00Z' })
      expect(withDue(t, { date: '2026-10-26', time: '09:00' }, TZ)).toMatchObject({
        start: null,
        due: '2026-10-26T08:00:00.000Z',
        dueAllDay: false,
      })
    })

    it('shifts a timed start by as much as the due time, past midnight', () => {
      const t = todo({ start: '2026-09-25T21:00:00Z', due: '2026-09-26T08:00:00Z' })
      expect(withDue(t, { date: '2026-09-26', time: '12:00' }, TZ)).toMatchObject({
        start: '2026-09-25T23:00:00.000Z',
        startAllDay: false,
        due: '2026-09-26T10:00:00.000Z',
      })
    })

    it('gives the start the time the due date gets', () => {
      const t = todo({ start: '2026-09-24T00:00:00Z', startAllDay: true, due: '2026-09-25T00:00:00Z', dueAllDay: true })
      expect(withDue(t, { date: '2026-09-26', time: '14:00' }, TZ)).toMatchObject({
        start: '2026-09-25T12:00:00.000Z',
        startAllDay: false,
        due: '2026-09-26T12:00:00.000Z',
        dueAllDay: false,
      })
    })

    it('drops the time of the start with the time of the due date', () => {
      const t = todo({ start: '2026-09-24T08:00:00Z', due: '2026-09-25T15:30:00Z' })
      expect(withDue(t, { date: '2026-09-25', time: '' }, TZ)).toMatchObject({
        start: '2026-09-24T00:00:00.000Z',
        startAllDay: true,
        due: '2026-09-25T00:00:00.000Z',
        dueAllDay: true,
      })
    })

    it('removes the due date and keeps the start', () => {
      const t = todo({ start: '2026-09-24T08:00:00Z', due: '2026-09-25T15:30:00Z' })
      expect(withDue(t, { date: '', time: '' }, TZ)).toMatchObject({
        start: '2026-09-24T08:00:00Z',
        startAllDay: false,
        due: null,
        dueAllDay: false,
      })
    })

    it('moves a start after the new due date back to it', () => {
      const t = todo({ start: '2026-10-01T00:00:00Z', startAllDay: true })
      expect(withDue(t, { date: '2026-09-28', time: '' }, TZ)).toMatchObject({
        start: '2026-09-28T00:00:00.000Z',
        startAllDay: true,
      })
      expect(withDue(t, { date: '2026-09-28', time: '09:00' }, TZ)).toMatchObject({
        start: '2026-09-28T07:00:00.000Z',
        startAllDay: false,
        due: '2026-09-28T07:00:00.000Z',
      })
    })
  })

  describe('repeat', () => {
    const allDay = (d: string) => `${d}T00:00:00Z`
    const single = todo({ due: allDay('2026-10-05'), dueAllDay: true })
    const series = todo({
      due: allDay('2026-10-05'),
      dueAllDay: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
      recurring: true,
      fixedDays: true,
      next: { start: null, due: allDay('2026-10-08') },
    })

    it('round-trips a rule the presets cannot express as custom', () => {
      const v = taskToForm(series, TZ)
      expect(v).toMatchObject({ recurrence: 'custom', customRule: 'FREQ=WEEKLY;BYDAY=MO,TH' })
      expect(formToTodoInput(v, TZ)).toMatchObject({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TH' })
    })

    it('maps a preset rule to the preset', () => {
      const t = todo({ due: allDay('2026-10-05'), dueAllDay: true, rrule: 'FREQ=DAILY', recurring: true })
      expect(taskToForm(t, TZ)).toMatchObject({ recurrence: 'daily', customRule: '' })
      expect(taskToForm(single, TZ)).toMatchObject({ recurrence: 'none', customRule: '' })
    })

    it('sends a preset with the time zone it repeats in', () => {
      const v = { ...taskToForm(single, TZ), recurrence: 'weekly' as const }
      expect(formToTodoInput(v, TZ, single)).toMatchObject({ rrule: 'FREQ=WEEKLY', timezone: 'Europe/Berlin' })
      expect(formToTodoInput(v, TZ)).toMatchObject({ rrule: 'FREQ=WEEKLY', timezone: 'Europe/Berlin' })
    })

    it('removes the rule of a series with "none"', () => {
      expect(formToTodoInput({ ...taskToForm(series, TZ), recurrence: 'none' }, TZ, series).rrule).toBe('')
    })

    it('keeps the stored rule while the repeat is untouched', () => {
      // The preset would write FREQ=WEEKLY: another rule to the server, which re-anchors the series.
      const t = { ...series, rrule: 'FREQ=WEEKLY;INTERVAL=1', fixedDays: false }
      const v = taskToForm(t, TZ)
      expect(v.recurrence).toBe('weekly')
      expect(formToTodoInput({ ...v, title: 'Other' }, TZ, t)).not.toHaveProperty('rrule')
      expect(formToTodoInput(taskToForm(series, TZ), TZ, series)).not.toHaveProperty('rrule')
      expect(formToTodoInput(taskToForm(single, TZ), TZ, single)).not.toHaveProperty('rrule')
      // Back to what it was is untouched, too.
      expect(formToTodoInput({ ...v, recurrence: 'weekly' }, TZ, t)).not.toHaveProperty('rrule')
    })

    it('gives a new task a rule only when it repeats', () => {
      const v = { ...taskToForm(single, TZ), recurrence: 'none' as const }
      expect(formToTodoInput(v, TZ)).not.toHaveProperty('rrule')
      expect(formToTodoInput({ ...v, recurrence: 'daily' }, TZ).rrule).toBe('FREQ=DAILY')
    })

    it('shows a rule Lucid cannot read, or a series without a rule, as custom', () => {
      const unreadable = todo({ ...series, rrule: 'FREQ=WEEKLY', ruleUnsupported: true, next: null })
      expect(taskToForm(unreadable, TZ)).toMatchObject({ recurrence: 'custom', customRule: 'FREQ=WEEKLY' })
      const dates = todo({ ...series, rrule: '', ruleUnsupported: true, next: null })
      expect(taskToForm(dates, TZ)).toMatchObject({ recurrence: 'custom', customRule: '' })
      expect(formToTodoInput(taskToForm(dates, TZ), TZ, dates)).not.toHaveProperty('rrule')
      expect(formToTodoInput({ ...taskToForm(dates, TZ), recurrence: 'none' }, TZ, dates).rrule).toBe('')
    })

    it('needs a date to repeat', () => {
      const v = taskToForm(todo(), TZ)
      const issues = (x: unknown) => taskFormSchema.safeParse(x).error?.issues.map((i) => [i.path.join('.'), i.message])
      expect(issues({ ...v, recurrence: 'daily' })).toContainEqual(['recurrence', 'validation.repeatNeedsDate'])
      expect(taskFormSchema.safeParse({ ...v, recurrence: 'daily', dueDate: '2026-10-05' }).success).toBe(true)
      expect(taskFormSchema.safeParse({ ...v, recurrence: 'daily', startDate: '2026-10-05' }).success).toBe(true)
      expect(taskFormSchema.safeParse(v).success).toBe(true)
    })

    it('limits a custom rule to 1024 characters', () => {
      const v = { ...taskToForm(series, TZ), customRule: `FREQ=WEEKLY;BYDAY=${'MO,'.repeat(400)}TH` }
      expect(taskFormSchema.safeParse(v).error?.issues.map((i) => i.message)).toContain('validation.tooLong')
    })

    it('needs a date only while the repeat of an existing task changes', () => {
      // A ruleUnsupported series may have no date at all (RDATE-only, or a rule no
      // client can read); an edit that leaves its rule alone must still be savable.
      const dateless = todo({ rrule: 'FREQ=WEEKLY', ruleUnsupported: true, recurring: true })
      const v = { ...taskToForm(dateless, TZ), title: 'Other' }
      expect(buildTaskFormSchema(dateless).safeParse(v).success).toBe(true)
      // Removing the rule needs no date either.
      expect(buildTaskFormSchema(dateless).safeParse({ ...v, recurrence: 'none' as const }).success).toBe(true)
      // Giving it a rule the editor actually writes does.
      const issues = buildTaskFormSchema(dateless)
        .safeParse({ ...v, recurrence: 'daily' as const })
        .error?.issues.map((i) => [i.path.join('.'), i.message])
      expect(issues).toContainEqual(['recurrence', 'validation.repeatNeedsDate'])
    })
  })

  describe('formWithDate', () => {
    const v = { ...taskToForm(todo(), TZ), dueDate: '2026-10-05', dueTime: '09:00' }

    it('gives a new date the time of the other one', () => {
      expect(formWithDate(v, 'start', '2026-10-02')).toMatchObject({ startDate: '2026-10-02', startTime: '09:00' })
    })

    it('keeps the time of a date that moves', () => {
      expect(formWithDate(v, 'due', '2026-10-07')).toMatchObject({ dueDate: '2026-10-07', dueTime: '09:00' })
      const noTime = { ...v, dueTime: '', startDate: '2026-10-01', startTime: '' }
      expect(formWithDate(noTime, 'due', '2026-10-07')).toMatchObject({ dueDate: '2026-10-07', dueTime: '' })
    })
  })

  describe('dayAllowed', () => {
    // The window of a fixed-day series due Mon, Oct 5 whose next repeat is due Thu, Oct 8.
    const series = todo({
      due: '2026-10-05T00:00:00Z',
      dueAllDay: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
      recurring: true,
      fixedDays: true,
      next: { start: null, due: '2026-10-08T00:00:00Z' },
    })
    const v = taskToForm(series, TZ)

    it('allows the days before the next repeat', () => {
      expect(dayAllowed(series, v, 'due', '2026-10-05', TZ)).toBe(true)
      expect(dayAllowed(series, v, 'due', '2026-10-07', TZ)).toBe(true)
    })

    it('blocks the day of the next repeat, the days after it and those before the current one', () => {
      expect(dayAllowed(series, v, 'due', '2026-10-08', TZ)).toBe(false)
      expect(dayAllowed(series, v, 'due', '2026-10-09', TZ)).toBe(false)
      expect(dayAllowed(series, v, 'due', '2026-10-04', TZ)).toBe(false)
    })

    it('judges a timed series by the day, whatever time the date gets', () => {
      const timed = todo({ ...series, due: '2026-10-05T07:00:00Z', dueAllDay: false, next: { due: '2026-10-08T07:00:00Z' } })
      const tv = taskToForm(timed, TZ)
      // A start takes the due date's time, 09:00, and places the task from then on.
      expect(dayAllowed(timed, tv, 'start', '2026-10-07', TZ)).toBe(true)
      expect(dayAllowed(timed, tv, 'start', '2026-10-08', TZ)).toBe(false)
      // The next repeat's day is out even before its 09:00; the day before is in until midnight.
      expect(dayAllowed(timed, { ...tv, dueTime: '08:00' }, 'due', '2026-10-08', TZ)).toBe(false)
      expect(dayAllowed(timed, { ...tv, dueTime: '23:30' }, 'due', '2026-10-07', TZ)).toBe(true)
    })

    it('allows any day without a window', () => {
      expect(dayAllowed(undefined, v, 'due', '2026-10-20', TZ)).toBe(true)
      const single = todo({ due: '2026-10-05T00:00:00Z', dueAllDay: true })
      expect(dayAllowed(single, taskToForm(single, TZ), 'due', '2026-10-20', TZ)).toBe(true)
    })

    it('allows any day once the rule changes, which starts it over from there', () => {
      expect(dayAllowed(series, { ...v, recurrence: 'none' }, 'due', '2026-10-09', TZ)).toBe(true)
      expect(dayAllowed(series, { ...v, recurrence: 'daily' }, 'due', '2026-10-09', TZ)).toBe(true)
    })
  })
})
