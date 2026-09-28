import { describe, expect, it } from 'vitest'
import { todo } from '@/test/fixtures'
import { formToTodoInput, taskFormSchema, taskToForm } from './taskForm'

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
})
