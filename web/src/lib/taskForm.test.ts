import { describe, expect, it } from 'vitest'
import { type TodoInput } from '@/lib/api/schemas'
import { todo } from '@/test/fixtures'
import {
  buildTaskFormSchema,
  editedFields,
  formToTodoInput,
  formWithDate,
  seriesEditInput,
  shownTaskRule,
  taskFormSchema,
  taskToForm,
  withDue,
} from './taskForm'

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

    // FR-17: a series given a time writes it in the zone of the write, so the date picker names it, as the editor does.
    it.each([
      ['a new time', { date: '2026-09-25', time: '09:00' }],
      ['a new day', { date: '2026-09-26', time: '' }],
      ['no due date', { date: '', time: '' }],
    ])('names the zone its times are in, for %s', (_, due) => {
      expect(withDue(todo({ due: '2026-09-25T00:00:00Z', dueAllDay: true }), due, 'Asia/Tokyo')).toMatchObject({
        timezone: 'Asia/Tokyo',
      })
      const spanning = todo({ start: '2026-09-24T00:00:00Z', startAllDay: true, due: '2026-09-25T00:00:00Z', dueAllDay: true })
      expect(withDue(spanning, due, 'Asia/Tokyo')).toMatchObject({ timezone: 'Asia/Tokyo' })
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

    it('ends the series of an all-day task with a date', () => {
      const v = { ...taskToForm(single, TZ), recurrence: 'custom' as const, customRule: 'FREQ=WEEKLY;UNTIL=20261231T225959Z' }
      expect(formToTodoInput(v, TZ)).toMatchObject({ rrule: 'FREQ=WEEKLY;UNTIL=20261231' })
    })

    it('ends the series of a timed task with the end of its last day, as UTC', () => {
      const v = { ...taskToForm(single, TZ), dueTime: '09:00', recurrence: 'custom' as const, customRule: 'FREQ=WEEKLY;UNTIL=20261231' }
      expect(formToTodoInput(v, TZ)).toMatchObject({ rrule: 'FREQ=WEEKLY;UNTIL=20261231T225959Z' })
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
      expect(buildTaskFormSchema({ original: dateless, timeZone: TZ }).safeParse(v).success).toBe(true)
      // Removing the rule needs no date either.
      expect(buildTaskFormSchema({ original: dateless, timeZone: TZ }).safeParse({ ...v, recurrence: 'none' as const }).success).toBe(true)
      // Giving it a rule the editor actually writes does.
      const issues = buildTaskFormSchema({ original: dateless, timeZone: TZ })
        .safeParse({ ...v, recurrence: 'daily' as const })
        .error?.issues.map((i) => [i.path.join('.'), i.message])
      expect(issues).toContainEqual(['recurrence', 'validation.repeatNeedsDate'])
    })

    it('needs a date when a series that had one clears both while keeping its rule', () => {
      // Clearing the dates of a dateful series is a fresh way to reach the same invalid
      // state as changing the rule: the backend rejects a kept rule without a date either
      // way, so the form must ask before it tries (FR-17).
      const v = { ...taskToForm(series, TZ), startDate: '', startTime: '', dueDate: '', dueTime: '' }
      const issues = buildTaskFormSchema({ original: series, timeZone: TZ })
        .safeParse(v)
        .error?.issues.map((i) => [i.path.join('.'), i.message])
      expect(issues).toContainEqual(['recurrence', 'validation.repeatNeedsDate'])
    })

    it('still validates a date-less stored series whose dates stay empty and rule stays put', () => {
      const dateless = todo({ rrule: 'FREQ=WEEKLY', ruleUnsupported: true, recurring: true })
      const v = { ...taskToForm(dateless, TZ), title: 'Other' }
      expect(v).toMatchObject({ startDate: '', dueDate: '' })
      expect(buildTaskFormSchema({ original: dateless, timeZone: TZ }).safeParse(v).success).toBe(true)
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

  // FR-17: a write to a series carries the series' own values for what the user left alone, so the server, which
  // compares with the series, never takes a repeat's own value shown in the editor for a change.
  describe('seriesEditInput', () => {
    const series = todo({
      title: 'Water the flowers',
      description: 'Balcony',
      checklist: [{ text: 'Can', done: false }],
      priority: 5,
      recurring: true,
      rrule: 'FREQ=DAILY',
    })
    const input: TodoInput = {
      title: 'Water the herbs',
      description: 'Kitchen',
      checklist: [{ text: 'Hose', done: true }],
      start: null,
      startAllDay: false,
      due: '2026-10-09T08:00:00.000Z',
      dueAllDay: false,
      priority: 1,
      status: 'NEEDS-ACTION',
      rrule: 'FREQ=WEEKLY',
      timezone: TZ,
    }

    it('takes the fields the user left alone from the series, and the rest from the input', () => {
      expect(seriesEditInput(series, input, {})).toEqual({
        ...input,
        title: 'Water the flowers',
        description: 'Balcony',
        checklist: [{ text: 'Can', done: false }],
        priority: 5,
      })
    })

    it('takes the fields the user edited from the input', () => {
      const all = { title: true, description: true, checklist: true, priority: true }
      expect(seriesEditInput(series, input, all)).toEqual(input)
      expect(seriesEditInput(series, input, { title: true })).toEqual({
        ...input,
        description: 'Balcony',
        checklist: [{ text: 'Can', done: false }],
        priority: 5,
      })
    })
  })

  describe('editedFields', () => {
    const opened = taskToForm(
      todo({ title: 'Own', description: 'Notes', checklist: [{ text: 'Can', done: false }], priority: 5 }),
      TZ,
    )

    it('names nothing the user left as the form opened', () => {
      const same = { ...opened, checklist: [{ text: 'Can', done: false }], dueDate: '2026-10-09' }
      expect(editedFields(opened, same)).toEqual({
        title: false,
        description: false,
        checklist: false,
        priority: false,
      })
    })

    it('names each field that differs from the one the form opened with', () => {
      expect(editedFields(opened, { ...opened, title: 'New' })).toMatchObject({ title: true, description: false })
      expect(editedFields(opened, { ...opened, description: 'More' })).toMatchObject({ description: true, title: false })
      expect(editedFields(opened, { ...opened, priority: 1 })).toMatchObject({ priority: true, checklist: false })
      expect(editedFields(opened, { ...opened, checklist: [{ text: 'Can', done: true }] }).checklist).toBe(true)
      expect(editedFields(opened, { ...opened, checklist: [{ text: 'Hose', done: false }] }).checklist).toBe(true)
      expect(editedFields(opened, { ...opened, checklist: [] }).checklist).toBe(true)
    })

    // The save trims them, so a stray space is no edit.
    it('compares the title and the checklist texts trimmed', () => {
      const spaced = { ...opened, title: ' Own  ', checklist: [{ text: 'Can ', done: false }] }
      expect(editedFields(opened, spaced)).toMatchObject({ title: false, checklist: false })
    })
  })
})

// A task in New York at 18:00 shows at midnight in Berlin, a day later (FR-17, FR-18).
describe('a repeat in another time zone', () => {
  const ny = todo({
    start: '2026-11-10T23:00:00Z',
    due: '2026-11-10T23:00:00Z',
    timezone: 'America/New_York',
    rrule: 'FREQ=WEEKLY;BYDAY=TU,TH',
    recurring: true,
    fixedDays: true,
    recurrenceId: '2026-11-10T23:00:00Z',
  })
  const issues = (original: typeof ny, v: unknown) =>
    buildTaskFormSchema({ original, timeZone: TZ })
      .safeParse(v)
      .error?.issues.map((i) => [i.path.join('.'), i.message])

  it('opens on the days it shows on', () => {
    expect(taskToForm(ny, TZ)).toMatchObject({ startDate: '2026-11-11', startTime: '00:00', recurrence: 'custom', customRule: 'FREQ=WEEKLY;BYDAY=WE,FR' })
  })

  it('keeps the stored rule while the repeat is untouched', () => {
    expect(formToTodoInput({ ...taskToForm(ny, TZ), title: 'Other' }, TZ, ny)).not.toHaveProperty('rrule')
  })

  it('writes a changed rule on the wall clock of the zone the task keeps', () => {
    const v = { ...taskToForm(ny, TZ), customRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,FR' }
    expect(formToTodoInput(v, TZ, ny)).toMatchObject({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH' })
    // A plain weekly series, changed in the repeat editor, which names the weekday shown.
    const weekly = { ...ny, rrule: 'FREQ=WEEKLY', fixedDays: false }
    const every2 = { ...taskToForm(weekly, TZ), recurrence: 'custom' as const, customRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE' }
    expect(formToTodoInput(every2, TZ, weekly)).toMatchObject({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU' })
  })

  it('writes the rule of a task given dates as built, as dates are the same everywhere', () => {
    const v = { ...taskToForm(ny, TZ), startTime: '', dueTime: '', customRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,FR' }
    expect(formToTodoInput(v, TZ, ny)).toMatchObject({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,FR' })
  })

  it('writes the rule a single task with a zone of its own is given in that zone', () => {
    const single = todo({ due: '2026-11-10T23:00:00Z', timezone: 'America/New_York' })
    const v = { ...taskToForm(single, TZ), recurrence: 'custom' as const, customRule: 'FREQ=WEEKLY;BYDAY=WE,FR' }
    expect(formToTodoInput(v, TZ, single)).toMatchObject({ rrule: 'FREQ=WEEKLY;BYDAY=TU,TH' })
  })

  // In March 2027 New York is on summer time two weeks before Berlin: 18:00 there is 23:00 here, on the same day.
  it('reads the rule at the series, also when the editor opens at a later repeat', () => {
    const later = taskToForm({ ...ny, start: '2027-03-16T22:00:00Z', due: '2027-03-16T22:00:00Z' }, TZ, ny)
    expect(later).toMatchObject({ startDate: '2027-03-16', startTime: '23:00', customRule: 'FREQ=WEEKLY;BYDAY=WE,FR' })
    expect(formToTodoInput(later, TZ, ny)).not.toHaveProperty('rrule')
    expect(issues(ny, later)).toBeUndefined()
  })

  it("refuses a changed rule that doesn't read the same in the task's zone", () => {
    const monthly = { ...taskToForm(ny, TZ), customRule: 'FREQ=MONTHLY;BYMONTHDAY=11' }
    expect(issues(ny, monthly)).toContainEqual(['recurrence', 'validation.repeatOtherZone'])
    expect(formToTodoInput(monthly, TZ, ny)).not.toHaveProperty('rrule')
    // A preset reads the same anywhere: the series keeps its own day.
    expect(issues(ny, { ...monthly, recurrence: 'monthly' })).toBeUndefined()
    expect(formToTodoInput({ ...monthly, recurrence: 'monthly' }, TZ, ny)).toMatchObject({ rrule: 'FREQ=MONTHLY' })
  })

  it("keeps a rule that doesn't read the same here as it is", () => {
    const tenth = { ...ny, rrule: 'FREQ=MONTHLY;BYMONTHDAY=10' }
    expect(shownTaskRule(tenth, TZ)).toBeNull()
    expect(taskToForm(tenth, TZ)).toMatchObject({ recurrence: 'custom', customRule: 'FREQ=MONTHLY;BYMONTHDAY=10' })
    expect(formToTodoInput(taskToForm(tenth, TZ), TZ, tenth)).not.toHaveProperty('rrule')
    expect(issues(tenth, taskToForm(tenth, TZ))).toBeUndefined()
  })
})
