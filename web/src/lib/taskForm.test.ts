import { describe, expect, it } from 'vitest'
import { type Todo, type TodoInput } from '@/lib/api/schemas'
import { PICKED_UTC } from '@/lib/zones'
import { todo } from '@/test/fixtures'
import {
  buildTaskFormSchema,
  dueFields,
  editedFields,
  formToTodoInput,
  formWithDate,
  formWithTime,
  seriesEditInput,
  taskFormSchema,
  taskToForm,
  taskZonesChanged,
  withDue,
  withTaskStartZone,
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

  it('sends the dates the editor opened with while they stay, also in the hour summer time repeats', () => {
    const t = todo({ due: '2026-10-25T01:30:00Z', start: '2026-10-25T01:00:00Z' })
    const v = { ...taskToForm(t, TZ), title: 'Renamed' }
    expect(formToTodoInput(v, TZ, t, t)).toMatchObject({ start: '2026-10-25T01:00:00.000Z', due: '2026-10-25T01:30:00.000Z' })
    // Without them, the times are read as entered: the first 02:00 and 02:30.
    expect(formToTodoInput(v, TZ, t)).toMatchObject({ start: '2026-10-25T00:00:00.000Z', due: '2026-10-25T00:30:00.000Z' })
  })

  it('reads a changed due time in the hour summer time repeats after a start kept at its second pass', () => {
    const t = todo({ start: '2026-10-25T01:00:00Z', due: '2026-10-25T01:30:00Z' })
    const v = { ...taskToForm(t, TZ), dueTime: '02:45' }
    expect(formToTodoInput(v, TZ, t, t)).toMatchObject({ start: '2026-10-25T01:00:00.000Z', due: '2026-10-25T01:45:00.000Z' })
  })

  it("compares with the repeat's dates the editor opened, not the series'", () => {
    const series = todo({ due: '2026-10-18T01:30:00Z', rrule: 'FREQ=WEEKLY', recurring: true })
    const shown = { start: null, startAllDay: false, due: '2026-10-25T01:30:00Z', dueAllDay: false }
    const v = taskToForm({ ...series, ...shown }, TZ, series)
    expect(formToTodoInput(v, TZ, series, shown).due).toBe('2026-10-25T01:30:00.000Z')
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

    it('judges a start after the due date at the times saved on the night summer time starts', () => {
      const x = { ...v, startDate: '2026-03-29', startTime: '02:45', dueDate: '2026-03-29', dueTime: '03:15' }
      expect(issues(x)).toEqual([['startDate', 'validation.startAfterDue']])
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

  // A field passes text it couldn't read up as typed (FR-09): the form refuses that text, and reads nothing from it.
  describe("text a field couldn't read", () => {
    const issues = (schema: ReturnType<typeof buildTaskFormSchema>, x: unknown) =>
      schema.safeParse(x).error?.issues.map((i) => [i.path.join('.'), i.message])
    const v = taskToForm(todo(), TZ)

    it.each([
      ['due time', { dueTime: '8:4x' }, ['dueTime', 'validation.time']],
      ['start time', { startTime: '9:4x', dueTime: '' }, ['startTime', 'validation.time']],
      ['due date', { dueDate: '10/4' }, ['dueDate', 'validation.date']],
      ['start date', { startDate: '2026-10-6', startTime: '', dueTime: '' }, ['startDate', 'validation.date']],
      // The forms' shape, but no day the calendar has: read, it would be 3 March, or 14 February 2027.
      ['due date that does not exist', { dueDate: '2026-02-31' }, ['dueDate', 'validation.date']],
      ['start date that does not exist', { startDate: '2026-13-45' }, ['startDate', 'validation.date']],
    ])('refuses an unreadable %s as such, not as out of order', (_, typed, want) => {
      // Start and due on Monday, 5 October 2026, at 9:00 or all day: in order, until a field holds text it couldn't
      // read, which reads as out of order as a time (midnight) or a date (by its characters).
      const x = { ...v, startDate: '2026-10-05', startTime: '09:00', dueDate: '2026-10-05', dueTime: '09:00', ...typed }
      expect(issues(taskFormSchema, x)).toEqual([want])
    })

    it.each([
      [
        'time of a series',
        todo({ due: '2026-10-05T07:00:00Z', rrule: 'FREQ=WEEKLY', recurring: true, recurrenceId: '2026-10-05T07:00:00Z' }),
        { dueTime: '9:4x' },
        ['dueTime', 'validation.time'],
      ],
      [
        'date of a task with a zone of its own',
        todo({ due: '2026-11-10T23:00:00Z', timezone: 'America/New_York' }),
        { dueDate: '11/4x' },
        ['dueDate', 'validation.date'],
      ],
    ])('refuses an unreadable %s given a new repeat as such, without writing the rule', (_, original, typed, want) => {
      const x = { ...taskToForm(original, TZ), recurrence: 'daily' as const, ...typed }
      expect(issues(buildTaskFormSchema({ original }), x)).toEqual([want])
    })
  })

  describe('withDue', () => {
    it('moves a start after the new due date back to it at the times saved on the night summer time starts', () => {
      // 02:45 to 03:15 on the 28th, moved to the 29th: 02:45 is saved as 03:45, after 03:15.
      const t = todo({ start: '2026-03-28T01:45:00Z', due: '2026-03-28T02:15:00Z' })
      expect(withDue(t, { date: '2026-03-29', time: '03:15' }, TZ)).toMatchObject({
        start: '2026-03-29T01:15:00.000Z',
        due: '2026-03-29T01:15:00.000Z',
      })
    })

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

    // FR-17, FR-18: a series given a time takes it in the zone of the write, so the date picker names the browser's
    // where a series without a time gets one, as the editor does; any other change keeps the zones the task has.
    describe('zone', () => {
      const allDay = todo({ due: '2026-09-25T00:00:00Z', dueAllDay: true, rrule: 'FREQ=WEEKLY', recurring: true })
      const spanning = { ...allDay, start: '2026-09-24T00:00:00Z', startAllDay: true }

      it('names the zone a series without a time is given one in', () => {
        expect(withDue(allDay, { date: '2026-09-25', time: '09:00' }, 'Asia/Tokyo')).toMatchObject({ timezone: 'Asia/Tokyo' })
        expect(withDue(spanning, { date: '2026-09-26', time: '09:00' }, 'Asia/Tokyo')).toMatchObject({ timezone: 'Asia/Tokyo' })
        expect(withDue(todo({ rrule: 'FREQ=WEEKLY', recurring: true }), { date: '2026-09-25', time: '09:00' }, 'Asia/Tokyo')).toMatchObject({
          timezone: 'Asia/Tokyo',
        })
      })

      it.each([
        ['a series given a new day', allDay, { date: '2026-09-26', time: '' }],
        ['a series given no due date', spanning, { date: '', time: '' }],
        ['a series with a time', { ...allDay, due: '2026-09-25T07:00:00Z', dueAllDay: false }, { date: '2026-09-25', time: '10:00' }],
        ['a single task given a time', todo({ due: '2026-09-25T00:00:00Z', dueAllDay: true }), { date: '2026-09-25', time: '09:00' }],
      ])('names none for %s', (_, t, due) => {
        const input = withDue(t, due, 'Asia/Tokyo')
        expect(input).not.toHaveProperty('timezone')
        expect(input).not.toHaveProperty('dueTimezone')
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

    // FR-18: a timed series needs a zone to keep its time across summer time; a date has none.
    it('sends a preset with the time zone a timed task repeats in, and none for dates', () => {
      const v = { ...taskToForm(single, TZ), recurrence: 'weekly' as const }
      const dates = formToTodoInput(v, TZ, single)
      expect(dates).toMatchObject({ rrule: 'FREQ=WEEKLY' })
      expect(dates).not.toHaveProperty('timezone')
      expect(formToTodoInput(v, TZ)).not.toHaveProperty('timezone')
      const timed = { ...v, dueTime: '09:00' }
      expect(formToTodoInput(timed, TZ, single)).toMatchObject({ rrule: 'FREQ=WEEKLY', timezone: TZ, dueTimezone: TZ })
      expect(formToTodoInput(timed, TZ)).toMatchObject({ rrule: 'FREQ=WEEKLY', timezone: TZ, dueTimezone: TZ })
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
      expect(buildTaskFormSchema({ original: dateless }).safeParse(v).success).toBe(true)
      // Removing the rule needs no date either.
      expect(buildTaskFormSchema({ original: dateless }).safeParse({ ...v, recurrence: 'none' as const }).success).toBe(true)
      // Giving it a rule the editor actually writes does.
      const issues = buildTaskFormSchema({ original: dateless })
        .safeParse({ ...v, recurrence: 'daily' as const })
        .error?.issues.map((i) => [i.path.join('.'), i.message])
      expect(issues).toContainEqual(['recurrence', 'validation.repeatNeedsDate'])
    })

    it('needs a date when a series that had one clears both while keeping its rule', () => {
      // Clearing the dates of a dateful series is a fresh way to reach the same invalid
      // state as changing the rule: the backend rejects a kept rule without a date either
      // way, so the form must ask before it tries (FR-17).
      const v = { ...taskToForm(series, TZ), startDate: '', startTime: '', dueDate: '', dueTime: '' }
      const issues = buildTaskFormSchema({ original: series })
        .safeParse(v)
        .error?.issues.map((i) => [i.path.join('.'), i.message])
      expect(issues).toContainEqual(['recurrence', 'validation.repeatNeedsDate'])
    })

    it('still validates a date-less stored series whose dates stay empty and rule stays put', () => {
      const dateless = todo({ rrule: 'FREQ=WEEKLY', ruleUnsupported: true, recurring: true })
      const v = { ...taskToForm(dateless, TZ), title: 'Other' }
      expect(v).toMatchObject({ startDate: '', dueDate: '' })
      expect(buildTaskFormSchema({ original: dateless }).safeParse(v).success).toBe(true)
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

    // FR-18: the time taken means the same moment in the zone it is taken from, not hours apart in another.
    it("gives a new date the other's time in the other's zone", () => {
      // From 10:00 Berlin time to 16:00 in New York (22:00 here), its due date removed.
      const flight = { ...v, startDate: '2026-10-28', startTime: '10:00', startZone: TZ, dueDate: '', dueTime: '', dueZone: 'America/New_York' }
      expect(formWithDate(flight, 'due', '2026-10-28')).toMatchObject({ dueTime: '10:00', dueZone: TZ })
      // A date that moves keeps its zone, and one given no time the zone it has.
      const moved = { ...flight, dueDate: '2026-10-28', dueTime: '16:00' }
      expect(formWithDate(moved, 'due', '2026-10-29')).toMatchObject({ dueTime: '16:00', dueZone: 'America/New_York' })
      const day = { ...flight, startTime: '' }
      expect(formWithDate(day, 'due', '2026-10-28')).toMatchObject({ dueTime: '', dueZone: 'America/New_York' })
    })
  })

  describe('formWithTime', () => {
    const timed = { ...taskToForm(todo(), TZ), startDate: '2026-03-12', startTime: '10:00', dueDate: '2026-03-13', dueTime: '11:00' }
    const allDay = { ...timed, startTime: '', dueTime: '' }

    it('takes the time of the other date along when one is removed', () => {
      expect(formWithTime(timed, 'due', '')).toMatchObject({ startTime: '', dueTime: '' })
      expect(formWithTime(timed, 'start', '')).toMatchObject({ startTime: '', dueTime: '' })
    })

    it('gives the other date, without a time, the time one is given', () => {
      expect(formWithTime(allDay, 'due', '18:00')).toMatchObject({ startTime: '18:00', dueTime: '18:00' })
      expect(formWithTime(allDay, 'start', '09:30')).toMatchObject({ startTime: '09:30', dueTime: '09:30' })
    })

    it("keeps the other date's time when a time changes", () => {
      expect(formWithTime(timed, 'due', '12:00')).toMatchObject({ startTime: '10:00', dueTime: '12:00' })
    })

    it('changes only its own time with one date', () => {
      const due = { ...timed, startDate: '', startTime: '' }
      expect(formWithTime(due, 'due', '')).toMatchObject({ startTime: '', dueTime: '' })
      const start = { ...allDay, dueDate: '' }
      expect(formWithTime(start, 'start', '08:00')).toMatchObject({ startTime: '08:00', dueTime: '' })
    })

    it("leaves the other date alone for text it can't read", () => {
      expect(formWithTime(allDay, 'due', '18:4x')).toMatchObject({ startTime: '', dueTime: '18:4x' })
    })

    // FR-18: the time given goes to the other date in the zone it is given in, where it means the same moment.
    it('gives the other date the time in the zone it is given in, and keeps the zone of a time changed', () => {
      const zoned = { ...allDay, startZone: TZ, dueZone: 'America/New_York' }
      expect(formWithTime(zoned, 'due', '18:00')).toMatchObject({ startTime: '18:00', startZone: 'America/New_York' })
      const both = { ...timed, startZone: TZ, dueZone: 'America/New_York' }
      expect(formWithTime(both, 'due', '12:00')).toMatchObject({ startZone: TZ, dueZone: 'America/New_York' })
      expect(formWithTime(both, 'due', '')).toMatchObject({ startZone: TZ, dueZone: 'America/New_York' })
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

// A task in New York at 18:00 is shown and edited at 18:00 in New York, its rule as stored (FR-17, FR-18).
describe('time zones', () => {
  const NY = 'America/New_York'
  const zoneKeys = (input: TodoInput) => ['timezone', 'dueTimezone'].filter((key) => key in input)
  const issues = (v: unknown, original?: Todo) =>
    buildTaskFormSchema(original && { original })
      .safeParse(v)
      .error?.issues.map((i) => [i.path.join('.'), i.message])
  // Due Tuesday, 27 October 2026, at 18:00 in New York, 23:00 here; weekly.
  const nyWeekly = todo({
    due: '2026-10-27T22:00:00Z',
    dueAllDay: false,
    timezone: NY,
    dueTimezone: NY,
    rrule: 'FREQ=WEEKLY',
    recurring: true,
    recurrenceId: '2026-10-27T22:00:00Z',
  })
  const nyDue = todo({ due: '2026-10-27T22:00:00Z', timezone: NY, dueTimezone: NY })
  // From 18:00 to 20:00 in New York on the same day.
  const nySpan = todo({ start: '2026-10-27T22:00:00Z', due: '2026-10-28T00:00:00Z', timezone: NY, dueTimezone: NY })

  it('opens a New York task in New York', () => {
    expect(taskToForm(nyWeekly, TZ)).toMatchObject({
      dueDate: '2026-10-27',
      dueTime: '18:00',
      dueZone: NY,
      recurrence: 'weekly',
      customRule: '',
    })
    expect(taskToForm(nySpan, TZ)).toMatchObject({ startTime: '18:00', startZone: NY, dueTime: '20:00', dueZone: NY })
  })

  it("opens a series without a zone in UTC, and a single task without one in the browser's", () => {
    const utc = todo({ due: '2026-10-27T22:00:00Z', rrule: 'FREQ=WEEKLY', recurring: true })
    expect(taskToForm(utc, TZ)).toMatchObject({ dueTime: '22:00', dueZone: 'UTC' })
    expect(taskToForm(todo({ due: '2026-10-27T22:00:00Z' }), TZ)).toMatchObject({ dueTime: '23:00', dueZone: '' })
    const allDay = todo({ due: '2026-10-27T00:00:00Z', dueAllDay: true, rrule: 'FREQ=WEEKLY', recurring: true })
    expect(taskToForm(allDay, TZ)).toMatchObject({ startZone: '', dueZone: '' })
  })

  // The server gives a date the task doesn't have yet the form of the other: a time given it is saved there.
  it("puts a row without a time in the other row's zone", () => {
    const v = taskToForm(nyDue, TZ)
    expect(v).toMatchObject({ startDate: '', startZone: NY })
    const started = formWithDate(v, 'start', '2026-10-27')
    expect(started).toMatchObject({ startTime: '18:00', startZone: NY })
    const input = formToTodoInput(started, TZ, nyDue, nyDue)
    expect(input.start).toBe('2026-10-27T22:00:00.000Z')
    expect(zoneKeys(input)).toEqual([])
    expect(taskToForm(todo({ start: '2026-10-27T22:00:00Z', timezone: NY }), TZ)).toMatchObject({ startZone: NY, dueZone: NY })
  })

  it("opens a task in a zone the browser doesn't know in the browser's, and keeps it", () => {
    const mars = todo({ due: '2026-10-27T22:00:00Z', timezone: 'Mars/Olympus', dueTimezone: 'Mars/Olympus' })
    const v = taskToForm(mars, TZ)
    expect(v).toMatchObject({ dueTime: '23:00', dueZone: 'Mars/Olympus' })
    const input = formToTodoInput({ ...v, title: 'Other' }, TZ, mars, mars)
    expect(zoneKeys(input)).toEqual([])
    expect(input.due).toBe('2026-10-27T22:00:00.000Z')
  })

  it('sends no zone for an unchanged task', () => {
    const weekly = formToTodoInput({ ...taskToForm(nyWeekly, TZ), title: 'Other' }, TZ, nyWeekly, nyWeekly)
    expect(zoneKeys(weekly)).toEqual([])
    expect(weekly).not.toHaveProperty('rrule')
    expect(weekly.due).toBe('2026-10-27T22:00:00.000Z')
    expect(zoneKeys(formToTodoInput(taskToForm(nySpan, TZ), TZ, nySpan, nySpan))).toEqual([])
    // A name of the browser's zone it has another for is the same zone.
    const kolkata = todo({ due: '2026-10-27T22:00:00Z', timezone: 'Asia/Kolkata', dueTimezone: 'Asia/Kolkata' })
    const v = taskToForm(kolkata, 'Asia/Calcutta')
    expect(taskZonesChanged({ ...v, dueZone: 'Asia/Calcutta' }, v)).toBe(false)
    expect(zoneKeys(formToTodoInput(v, 'Asia/Calcutta', kolkata, kolkata))).toEqual([])
  })

  it('keeps the clock on a zone change', () => {
    const v = withTaskStartZone(taskToForm(nySpan, TZ), TZ)
    expect(v).toMatchObject({ startTime: '18:00', startZone: TZ, dueTime: '20:00', dueZone: TZ })
    expect(taskZonesChanged(v, taskToForm(nySpan, TZ))).toBe(true)
    expect(formToTodoInput(v, TZ, nySpan, nySpan)).toMatchObject({
      start: '2026-10-27T17:00:00.000Z',
      due: '2026-10-27T19:00:00.000Z',
      timezone: TZ,
      dueTimezone: TZ,
    })
  })

  it('keeps the zone of a due in a zone of its own, and sends the start zone only where it changes', () => {
    const tokyo = { ...taskToForm(nySpan, TZ), dueZone: 'Asia/Tokyo' }
    const dueOnly = formToTodoInput(tokyo, TZ, nySpan, nySpan)
    expect(zoneKeys(dueOnly)).toEqual(['dueTimezone'])
    expect(dueOnly.dueTimezone).toBe('Asia/Tokyo')
    const moved = withTaskStartZone(tokyo, TZ)
    expect(moved).toMatchObject({ startZone: TZ, dueZone: 'Asia/Tokyo' })
    expect(formToTodoInput(moved, TZ, nySpan, nySpan)).toMatchObject({ timezone: TZ, dueTimezone: 'Asia/Tokyo' })
    // Back in the start's zone, the due follows it again.
    expect(withTaskStartZone({ ...tokyo, dueZone: NY }, TZ)).toMatchObject({ startZone: TZ, dueZone: TZ })
  })

  // FR-18: for a task without a start, `timezone` names the zone of its due, which a sent `dueTimezone` names too.
  it('a due-only task names its zone as timezone', () => {
    const v = { ...taskToForm(nyDue, TZ), dueZone: 'Asia/Tokyo' }
    expect(formToTodoInput(v, TZ, nyDue, nyDue)).toMatchObject({
      due: '2026-10-27T09:00:00.000Z',
      timezone: 'Asia/Tokyo',
      dueTimezone: 'Asia/Tokyo',
    })
    const start = todo({ start: '2026-10-27T22:00:00Z', timezone: NY })
    const tokyo = withTaskStartZone(taskToForm(start, TZ), 'Asia/Tokyo')
    expect(formToTodoInput(tokyo, TZ, start, start)).toMatchObject({ timezone: 'Asia/Tokyo', dueTimezone: 'Asia/Tokyo' })
    // Also for a series without a zone, shown in UTC.
    const utc = todo({ due: '2026-10-27T22:00:00Z', rrule: 'FREQ=WEEKLY', recurring: true, recurrenceId: '2026-10-27T22:00:00Z' })
    expect(formToTodoInput({ ...taskToForm(utc, TZ), dueZone: 'Asia/Tokyo' }, TZ, utc, utc)).toMatchObject({
      timezone: 'Asia/Tokyo',
      dueTimezone: 'Asia/Tokyo',
    })
  })

  // A series without a start zone (floating, a TZID Lucid can't resolve) is shown in UTC: sending that back would
  // write it in UTC for every other app.
  it('sends no start zone for a series without one whose due zone alone changed', () => {
    const utc = todo({
      start: '2026-10-27T18:00:00Z',
      due: '2026-10-27T20:00:00Z',
      rrule: 'FREQ=WEEKLY',
      recurring: true,
      recurrenceId: '2026-10-27T18:00:00Z',
    })
    const v = { ...taskToForm(utc, TZ), dueZone: 'Asia/Tokyo' }
    expect(v.startZone).toBe('UTC')
    const input = formToTodoInput(v, TZ, utc, utc)
    expect('timezone' in input).toBe(false)
    expect(input.dueTimezone).toBe('Asia/Tokyo')
    // The start as it was; the due at 20:00 as before, now in Tokyo.
    expect(input).toMatchObject({ start: '2026-10-27T18:00:00.000Z', due: '2026-10-27T11:00:00.000Z' })
  })

  it('sends the zone of an unlinked due with a changed start, so it does not follow the start', () => {
    const apart = todo({ start: '2026-10-27T22:00:00Z', due: '2026-10-28T11:00:00Z', timezone: NY, dueTimezone: 'Asia/Tokyo' })
    const v = withTaskStartZone(taskToForm(apart, TZ), TZ)
    expect(v.dueZone).toBe('Asia/Tokyo')
    expect(formToTodoInput(v, TZ, apart, apart)).toMatchObject({ timezone: TZ, dueTimezone: 'Asia/Tokyo' })
  })

  // A browser that reports UTC offers it as "Where you are now": picked, it is stored, as every zone picked is.
  it('sends a changed zone that names UTC as a UTC picked', () => {
    const single = todo({ start: '2026-10-27T22:00:00Z', due: '2026-10-28T00:00:00Z' })
    const v = withTaskStartZone(taskToForm(single, 'UTC'), 'UTC')
    expect(formToTodoInput(v, 'UTC', single, single)).toMatchObject({ timezone: PICKED_UTC, dueTimezone: PICKED_UTC })
    expect(formToTodoInput({ ...taskToForm(nyDue, TZ), dueZone: 'Etc/GMT' }, TZ, nyDue, nyDue)).toMatchObject({
      timezone: PICKED_UTC,
      dueTimezone: PICKED_UTC,
    })
    // Unchanged, it is not sent; the ✕ still sends none.
    const utc = todo({ due: '2026-10-27T22:00:00Z', rrule: 'FREQ=WEEKLY', recurring: true })
    expect(zoneKeys(formToTodoInput(taskToForm(utc, 'UTC'), 'UTC', utc, utc))).toEqual([])
    expect(formToTodoInput({ ...taskToForm(nySpan, 'UTC'), startZone: '', dueZone: '' }, 'UTC', nySpan, nySpan)).toMatchObject({
      timezone: '',
      dueTimezone: '',
    })
  })

  it("a new task series sends the browser's zone, a new single task none", () => {
    const fresh = { ...taskToForm(todo(), TZ), dueDate: '2026-10-28', dueTime: '09:00' }
    expect(zoneKeys(formToTodoInput(fresh, TZ))).toEqual([])
    expect(formToTodoInput({ ...fresh, recurrence: 'weekly' }, TZ)).toMatchObject({ rrule: 'FREQ=WEEKLY', timezone: TZ, dueTimezone: TZ })
    expect(zoneKeys(formToTodoInput({ ...fresh, dueTime: '', recurrence: 'weekly' }, TZ))).toEqual([])
    // One picked is sent as it is.
    expect(formToTodoInput({ ...fresh, startZone: NY, dueZone: NY }, TZ)).toMatchObject({ timezone: NY, dueTimezone: NY })
  })

  it("makes a series of a task without a zone in the browser's, and of one with a zone in its own", () => {
    const single = todo({ due: '2026-10-27T22:00:00Z' })
    const weekly = (t: Todo) => formToTodoInput({ ...taskToForm(t, TZ), recurrence: 'weekly' }, TZ, t, t)
    expect(weekly(single)).toMatchObject({ rrule: 'FREQ=WEEKLY', timezone: TZ, dueTimezone: TZ })
    expect(zoneKeys(weekly(nyDue))).toEqual([])
    // An all-day series given a time, too; a series without a zone keeps UTC.
    const allDay = todo({ due: '2026-10-27T00:00:00Z', dueAllDay: true, rrule: 'FREQ=WEEKLY', recurring: true })
    expect(formToTodoInput({ ...taskToForm(allDay, TZ), dueTime: '09:00' }, TZ, allDay, allDay)).toMatchObject({
      timezone: TZ,
      dueTimezone: TZ,
    })
    const utc = todo({ due: '2026-10-27T22:00:00Z', rrule: 'FREQ=WEEKLY', recurring: true })
    expect(zoneKeys(formToTodoInput({ ...taskToForm(utc, TZ), dueTime: '09:00' }, TZ, utc, utc))).toEqual([])
  })

  it('the ✕ of a single task sends UTC', () => {
    const v = { ...taskToForm(nySpan, TZ), startZone: '', dueZone: '' }
    expect(formToTodoInput(v, TZ, nySpan, nySpan)).toMatchObject({
      start: '2026-10-27T17:00:00.000Z',
      due: '2026-10-27T19:00:00.000Z',
      timezone: '',
      dueTimezone: '',
    })
  })

  it("the ✕ of a series sends the browser's zone, and UTC once its rule goes", () => {
    const v = { ...taskToForm(nyWeekly, TZ), startZone: '', dueZone: '' }
    expect(formToTodoInput(v, TZ, nyWeekly, nyWeekly)).toMatchObject({ timezone: TZ, dueTimezone: TZ })
    expect(formToTodoInput({ ...v, recurrence: 'none' }, TZ, nyWeekly, nyWeekly)).toMatchObject({
      rrule: '',
      timezone: '',
      dueTimezone: '',
    })
  })

  it('a picked UTC is Etc/UTC', () => {
    const v = { ...taskToForm(nySpan, TZ), startZone: PICKED_UTC, dueZone: PICKED_UTC }
    expect(formToTodoInput(v, TZ, nySpan, nySpan)).toMatchObject({
      start: '2026-10-27T18:00:00.000Z',
      timezone: 'Etc/UTC',
      dueTimezone: 'Etc/UTC',
    })
  })

  it('sends no zone for dates', () => {
    const v = { ...taskToForm(nySpan, TZ), startTime: '', dueTime: '', startZone: TZ, dueZone: TZ }
    expect(zoneKeys(formToTodoInput(v, TZ, nySpan, nySpan))).toEqual([])
  })

  // New York repeats 1:00 to 2:00 on 1 November 2026: 06:30Z is the second 1:30 there (#10).
  it('keeps the instant of a row as opened while its date, time and zone stay', () => {
    const t = todo({ due: '2026-11-01T06:30:00Z', timezone: NY, dueTimezone: NY })
    const v = taskToForm(t, TZ)
    expect(v).toMatchObject({ dueDate: '2026-11-01', dueTime: '01:30' })
    expect(formToTodoInput({ ...v, title: 'Other' }, TZ, t, t).due).toBe('2026-11-01T06:30:00.000Z')
    // Without them, the first 1:30; in another zone, read there.
    expect(formToTodoInput(v, TZ, t).due).toBe('2026-11-01T05:30:00.000Z')
    expect(formToTodoInput({ ...v, dueZone: 'Europe/London' }, TZ, t, t).due).toBe('2026-11-01T01:30:00.000Z')
  })

  it('refuses a start after the due across zones', () => {
    // 04:00 in New York is 09:00 here; 06:00 there 11:00, in order though earlier on the clock.
    const v = {
      ...taskToForm(todo(), TZ),
      startDate: '2026-10-28',
      startTime: '10:00',
      startZone: TZ,
      dueDate: '2026-10-28',
      dueTime: '04:00',
      dueZone: NY,
    }
    expect(issues(v)).toContainEqual(['startDate', 'validation.startAfterDue'])
    expect(issues({ ...v, dueTime: '06:00' })).toBeUndefined()
  })

  it('a changed repeat of a foreign task is written as built', () => {
    const v = { ...taskToForm(nyWeekly, TZ), recurrence: 'custom' as const, customRule: 'FREQ=WEEKLY;INTERVAL=2' }
    expect(issues(v, nyWeekly)).toBeUndefined()
    const input = formToTodoInput(v, TZ, nyWeekly, nyWeekly)
    expect(input).toMatchObject({ rrule: 'FREQ=WEEKLY;INTERVAL=2' })
    expect(zoneKeys(input)).toEqual([])
    // Also one on a day of the month, which falls on other dates here.
    const monthly = { ...v, customRule: 'FREQ=MONTHLY;BYMONTHDAY=27' }
    expect(issues(monthly, nyWeekly)).toBeUndefined()
    expect(formToTodoInput(monthly, TZ, nyWeekly, nyWeekly)).toMatchObject({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=27' })
  })

  it("ends a rule at the end of its last day in the task's zone", () => {
    const v = { ...taskToForm(nyWeekly, TZ), recurrence: 'custom' as const, customRule: 'FREQ=WEEKLY;UNTIL=20261231' }
    expect(formToTodoInput(v, TZ, nyWeekly, nyWeekly)).toMatchObject({ rrule: 'FREQ=WEEKLY;UNTIL=20270101T045959Z' })
  })

  describe('a series on Tuesdays and Thursdays', () => {
    const ny = todo({
      start: '2026-11-10T23:00:00Z',
      due: '2026-11-10T23:00:00Z',
      timezone: NY,
      dueTimezone: NY,
      rrule: 'FREQ=WEEKLY;BYDAY=TU,TH',
      recurring: true,
      fixedDays: true,
      recurrenceId: '2026-11-10T23:00:00Z',
    })

    it('opens with its rule as stored, and keeps it while the repeat is untouched', () => {
      expect(taskToForm(ny, TZ)).toMatchObject({
        startDate: '2026-11-10',
        startTime: '18:00',
        recurrence: 'custom',
        customRule: 'FREQ=WEEKLY;BYDAY=TU,TH',
      })
      expect(formToTodoInput({ ...taskToForm(ny, TZ), title: 'Other' }, TZ, ny, ny)).not.toHaveProperty('rrule')
    })

    // In March 2027 New York is on summer time two weeks before Berlin.
    it('opens at a later repeat in its zone, with the rule of the series', () => {
      const shown = { start: '2027-03-16T22:00:00Z', startAllDay: false, due: '2027-03-16T22:00:00Z', dueAllDay: false }
      const later = taskToForm({ ...ny, ...shown }, TZ, ny)
      expect(later).toMatchObject({ startDate: '2027-03-16', startTime: '18:00', customRule: 'FREQ=WEEKLY;BYDAY=TU,TH' })
      expect(formToTodoInput(later, TZ, ny, shown)).not.toHaveProperty('rrule')
      expect(issues(later, ny)).toBeUndefined()
    })
  })

  describe('the due picker', () => {
    it('reads the due in the browser’s zone', () => {
      expect(dueFields(nyDue, TZ)).toEqual({ dueDate: '2026-10-27', dueTime: '23:00' })
      expect(dueFields(todo({ due: '2026-10-27T00:00:00Z', dueAllDay: true, timezone: NY }), TZ)).toEqual({
        dueDate: '2026-10-27',
        dueTime: '',
      })
      expect(dueFields(todo(), TZ)).toEqual({ dueDate: '', dueTime: '' })
    })

    it('keeps the zone', () => {
      const input = withDue(nyDue, { date: '2026-10-28', time: '10:00' }, TZ)
      expect(input.due).toBe('2026-10-28T09:00:00.000Z')
      expect(input).not.toHaveProperty('timezone')
      expect(input).not.toHaveProperty('dueTimezone')
      const dateless = todo({ rrule: 'FREQ=WEEKLY', recurring: true })
      expect(withDue(dateless, { date: '2026-10-28', time: '10:00' }, TZ)).toMatchObject({ timezone: TZ })
    })
  })
})
