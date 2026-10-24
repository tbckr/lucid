import { addDays, differenceInCalendarDays } from 'date-fns'
import { z } from 'zod'
import { type Todo, type TodoInput } from './api/schemas'
import { anchorOf, type TaskDates } from './calendarTasks'
import { dayAt, dayKey, localDateToUtc, parseDayKey, utcToZoned, zonedToUtc, zonedToUtcAfter } from './dates'
import { buildRRule, fitUntil, recurrenceFromRRule, type Recurrence } from './rrule'
import { ruleInZone, taskRuleClock } from './seriesShift'
import { todoToInput } from './tasks'

const optionalDate = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.date')])
const optionalTime = z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'validation.time')])

const taskFormShape = {
  title: z.string().trim().min(1, 'validation.titleRequired').max(1024, 'validation.tooLong'),
  description: z.string().max(64 * 1024, 'validation.tooLong'),
  startDate: optionalDate,
  startTime: optionalTime,
  dueDate: optionalDate,
  dueTime: optionalTime,
  priority: z.number().int().min(0).max(9),
  completed: z.boolean(),
  checklist: z
    .array(z.object({ text: z.string().trim().min(1, 'validation.itemRequired').max(1024, 'validation.tooLong'), done: z.boolean() }))
    .max(200, 'validation.tooManyItems'),
  recurrence: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom']),
  customRule: z.string().max(1024, 'validation.tooLong'),
}

/**
 * Task editor form; limits mirror domain.TodoInput.Validate. Messages are i18n keys.
 * `edit.original`, the task edited, lets `validation.repeatNeedsDate` (FR-17) see whether
 * the repeat itself changes, read on the browser's wall clock in `edit.timeZone`: a new
 * task needs a date only if it is given a repeat, and an existing task needs one only
 * when its repeat changes, or when it had a date and both are cleared while the rule
 * stays (the backend rejects a kept rule without a date either way). Not for edits that
 * leave both the rule and an already-dateless series alone (a `ruleUnsupported` series
 * can be dateless, and its title must still be editable). A changed repeat that doesn't
 * read the same on the wall clock the task keeps its rule on is
 * `validation.repeatOtherZone` (FR-18, see `writtenRule`).
 */
export function buildTaskFormSchema(edit?: { original: Todo; timeZone: string }) {
  const original = edit?.original
  return z.object(taskFormShape).superRefine((v, ctx) => {
    // A rule recurs from the start, else the due date (FR-17). Removing a rule needs
    // no date, so this only fires while a rule stays set, and only when the rule is
    // the one being set, or a dated series just lost both its dates: an untouched
    // rule, kept on a task whose dates were never there, does not need one to be saved.
    const clearedDatedSeries = original !== undefined && anchorOf(original) !== null
    // A new task's repeat is new whatever it is.
    const changed = edit ? repeatChanged(v, edit.timeZone, edit.original) : v.recurrence !== 'none'
    if (v.recurrence !== 'none' && v.startDate === '' && v.dueDate === '' && (changed || clearedDatedSeries)) {
      ctx.addIssue({ code: 'custom', message: 'validation.repeatNeedsDate', path: ['recurrence'] })
    } else if (edit && changed && writtenRule(v, edit.timeZone, edit.original) === null) {
      ctx.addIssue({ code: 'custom', message: 'validation.repeatOtherZone', path: ['recurrence'] })
    }
    if (v.dueTime !== '' && v.dueDate === '') {
      ctx.addIssue({ code: 'custom', message: 'validation.dateForTime', path: ['dueDate'] })
    }
    if (v.startTime !== '' && v.startDate === '') {
      ctx.addIssue({ code: 'custom', message: 'validation.dateForTime', path: ['startDate'] })
    }
    if (v.startDate === '' || v.dueDate === '') return
    // RFC 5545: DTSTART and DUE share a value type, and DUE is not before DTSTART (FR-16). Times
    // compare at the times saved, in the browser's zone, which the editors convert in: one summer
    // time skips counts where it is saved, an hour later (#10, FR-18).
    if ((v.startTime === '') !== (v.dueTime === '')) {
      ctx.addIssue({ code: 'custom', message: 'validation.startDueType', path: ['startDate'] })
    } else if (v.startTime === '' ? v.startDate > v.dueDate : dayAt(v.startDate, v.startTime) > dayAt(v.dueDate, v.dueTime)) {
      ctx.addIssue({ code: 'custom', message: 'validation.startAfterDue', path: ['startDate'] })
    }
  })
}

/** The schema for a new task: no original to compare the repeat against. */
export const taskFormSchema = buildTaskFormSchema()

export type TaskFormValues = z.infer<typeof taskFormSchema>

/** A wire date (UTC midnight for all-day values) as date and time fields in `timeZone`. */
function toFields(iso: string | null | undefined, allDay: boolean, timeZone: string): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  if (allDay) return { date: iso.slice(0, 10), time: '' }
  return utcToZoned(new Date(iso), timeZone)
}

/**
 * Date and time fields as a wire date; a date without time is all-day. The
 * fields can't say which of a time summer time repeats it is, so a time left
 * as the editor opened it, `opened`, keeps its instant, and a due time
 * entered anew is not before the start, `after` (#10, FR-18).
 */
function fromFields(
  date: string,
  time: string,
  timeZone: string,
  { opened, openedAllDay = false, after }: { opened?: string | null; openedAllDay?: boolean; after?: string | null } = {},
): { value: string | null; allDay: boolean } {
  if (!date) return { value: null, allDay: false }
  if (time) {
    const shown = opened && !openedAllDay ? toFields(opened, false, timeZone) : null
    const at =
      opened && shown?.date === date && shown.time === time
        ? new Date(opened)
        : after
          ? zonedToUtcAfter(date, time, timeZone, new Date(after))
          : zonedToUtc(date, time, timeZone)
    return { value: at.toISOString(), allDay: false }
  }
  return { value: localDateToUtc(parseDayKey(date)).toISOString(), allDay: true }
}

type RepeatFields = Pick<TaskFormValues, 'recurrence' | 'customRule'>

/**
 * The repeat rule of `todo` as the task editor shows and builds it (FR-17,
 * FR-18): on the browser's wall clock in `timeZone`, read at the task's
 * anchor on the wall clock the task keeps its rule on (`taskRuleClock`, see
 * `ruleInZone`). `null` where it doesn't read the same there: the editor can
 * only keep it, replace it by a preset, or remove it. A rule Lucid can't read
 * stays as it is.
 */
export function shownTaskRule(todo: Todo, timeZone: string): string | null {
  const clock = todo.ruleUnsupported ? null : taskRuleClock(todo)
  return clock ? ruleInZone(todo.rrule, clock.at, clock.zone, timeZone) : todo.rrule
}

/**
 * The repeat of a todo as the editor shows it (FR-17): a preset where the
 * rule is one, else "custom" with the rule kept verbatim, as it reads in
 * `timeZone` (`shownTaskRule`, FR-18). A rule Lucid can't read, one that
 * doesn't read the same in `timeZone`, or a series of dates without a rule,
 * is custom too: it can only be kept or removed.
 */
function repeatOf(todo: Todo | undefined, timeZone: string): RepeatFields {
  if (!todo) return { recurrence: 'none', customRule: '' }
  const rule = shownTaskRule(todo, timeZone) ?? todo.rrule
  const custom = todo.ruleUnsupported || (todo.recurring && !rule.trim())
  const recurrence: Recurrence = custom ? 'custom' : recurrenceFromRRule(rule)
  return { recurrence, customRule: recurrence === 'custom' ? rule : '' }
}

/**
 * Whether `v` changes the repeat of `original`, or gives a new task one
 * (FR-17), both read in `timeZone`. An untouched repeat is not sent: the
 * preset would write the stored rule in its own words ("FREQ=WEEKLY" for
 * "FREQ=WEEKLY;INTERVAL=1"), which the server takes as a new rule, starting
 * the series over.
 */
export function repeatChanged(v: RepeatFields, timeZone: string, original?: Todo): boolean {
  const before = repeatOf(original, timeZone)
  return v.recurrence !== before.recurrence || (v.recurrence === 'custom' && v.customRule !== before.customRule)
}

/**
 * The rule a save of the repeat `v` writes for `original` (FR-17, FR-18):
 * built on the browser's wall clock in `timeZone`, with its UNTIL in the form
 * of the date it recurs from (`fitUntil`), and, for a time, on the wall clock
 * the server keeps the task's rule on (`taskRuleClock`). `null` where it
 * doesn't read the same there (`ruleInZone`).
 *
 * The server starts the rule over at the dates the save sends (its anchor,
 * start else due), so it is read at the time of day they have now. A series
 * is read on the date of its own place in the rule, as `shownTaskRule` shows
 * it, as two zones can be a date apart for part of the year only; a task that
 * doesn't repeat yet, shown no rule, on its new date.
 */
function writtenRule(v: TaskFormValues, timeZone: string, original?: Todo): string | null {
  const [date, time] = v.startDate ? [v.startDate, v.startTime] : [v.dueDate, v.dueTime]
  const rule = fitUntil(buildRRule(v.recurrence, v.customRule), time === '', timeZone)
  const clock = original && time !== '' ? taskRuleClock(original) : null
  if (!clock) return rule
  const day = original?.recurring ? utcToZoned(clock.at, timeZone).date : date
  return ruleInZone(rule, zonedToUtc(day, time, timeZone), timeZone, clock.zone)
}

/**
 * The form of `todo` in fields of `timeZone`. Its repeat is the one of
 * `series`, the task itself unless `todo` holds the dates of one of its
 * repeats: it is read at the series, as a save compares and writes it
 * (`repeatChanged`, `writtenRule`).
 */
export function taskToForm(todo: Todo, timeZone: string, series: Todo = todo): TaskFormValues {
  const start = toFields(todo.start, todo.startAllDay, timeZone)
  const due = toFields(todo.due, todo.dueAllDay, timeZone)
  return {
    title: todo.title,
    description: todo.description,
    startDate: start.date,
    startTime: start.time,
    dueDate: due.date,
    dueTime: due.time,
    priority: todo.priority,
    completed: todo.status === 'COMPLETED',
    checklist: todo.checklist.map((c) => ({ ...c })),
    ...repeatOf(series, timeZone),
  }
}

/**
 * The body of a save of `v`. `original` is the task edited, `opened` the
 * dates the editor opened with: a repeat's own, else the task's.
 */
export function formToTodoInput(v: TaskFormValues, timeZone: string, original?: Todo, opened?: TaskDates): TodoInput {
  const start = fromFields(v.startDate, v.startTime, timeZone, { opened: opened?.start, openedAllDay: opened?.startAllDay })
  const due = fromFields(v.dueDate, v.dueTime, timeZone, {
    opened: opened?.due,
    openedAllDay: opened?.dueAllDay,
    after: start.allDay ? null : start.value,
  })
  const keepStatus = original && original.status !== 'COMPLETED' ? original.status : 'NEEDS-ACTION'
  const rrule = repeatChanged(v, timeZone, original) ? writtenRule(v, timeZone, original) : null
  return {
    title: v.title.trim(),
    description: v.description,
    checklist: v.checklist.map((c) => ({ text: c.text.trim(), done: c.done })),
    start: start.value,
    startAllDay: start.allDay,
    due: due.value,
    dueAllDay: due.allDay,
    priority: v.priority,
    status: v.completed ? 'COMPLETED' : keepStatus,
    // Absent keeps the stored rule, "" removes it (FR-17). One that can't be
    // written where the task keeps its rule stays absent too: the form
    // refuses it before it is saved (validation.repeatOtherZone).
    ...(rrule !== null ? { rrule } : {}),
    timezone: timeZone,
  }
}

/**
 * Which of the fields a write to a series compares (title, notes, checklist,
 * priority) the user edited (FR-17): those that differ from the values the
 * editor opened with.
 */
export interface EditedFields {
  title?: boolean
  description?: boolean
  checklist?: boolean
  priority?: boolean
}

/**
 * The fields of `values` that differ from `opened`, the values the editor
 * opened with (FR-17). Texts compare trimmed, as a save trims them, so a stray
 * space is no edit.
 */
export function editedFields(opened: TaskFormValues, values: TaskFormValues): Required<EditedFields> {
  const sameItems =
    opened.checklist.length === values.checklist.length &&
    opened.checklist.every((c, i) => {
      const item = values.checklist[i]
      return item?.text.trim() === c.text.trim() && item.done === c.done
    })
  return {
    title: values.title.trim() !== opened.title.trim(),
    description: values.description !== opened.description,
    checklist: !sameItems,
    priority: values.priority !== opened.priority,
  }
}

/**
 * The body of a write to the task series `series` from the editor (FR-17):
 * `input`, with the series' own title, notes, checklist and priority where
 * the user left them alone (`dirty`). The server takes a field as changed
 * where it differs from the series', and writes it into the repeats; a
 * repeat's own value the editor showed, such as the title another app gave
 * a later repeat, is then not mistaken for the user's change.
 */
export function seriesEditInput(series: Todo, input: TodoInput, dirty: EditedFields): TodoInput {
  return {
    ...input,
    title: dirty.title ? input.title : series.title,
    description: dirty.description ? input.description : series.description,
    checklist: dirty.checklist ? input.checklist : series.checklist,
    priority: dirty.priority ? input.priority : series.priority,
  }
}

const DATE_FIELDS = {
  start: { date: 'startDate', time: 'startTime', other: 'dueTime' },
  due: { date: 'dueDate', time: 'dueTime', other: 'startTime' },
} as const

/**
 * `v` with its start or due date set to `day` (FR-14, FR-16): a date that
 * moves keeps its time; a new one takes the other date's time, as RFC 5545
 * wants a time on both or neither.
 */
export function formWithDate(v: TaskFormValues, which: 'start' | 'due', day: string): TaskFormValues {
  const f = DATE_FIELDS[which]
  return { ...v, [f.date]: day, [f.time]: v[f.date] ? v[f.time] : v[f.other] }
}

interface Fields {
  date: string
  time: string
}

function minutesOf(time: string): number {
  const [h = 0, m = 0] = time.split(':').map(Number)
  return h * 60 + m
}

/** Date and time fields moved by `days` and `minutes`, carrying past midnight; wall-clock arithmetic, so DST cannot skew it. */
function shiftFields(f: Fields, days: number, minutes: number): Fields {
  if (!f.time) return { date: dayKey(addDays(parseDayKey(f.date), days)), time: '' }
  const total = minutesOf(f.time) + minutes
  const carry = Math.floor(total / 1440)
  const m = total - carry * 1440
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: dayKey(addDays(parseDayKey(f.date), days + carry)),
    time: `${pad(Math.floor(m / 60))}:${pad(m % 60)}`,
  }
}

/**
 * `todo` with its due date set to `due`, in fields of `timeZone`: without a
 * date it is removed, without a time it is all-day (FR-14). The start moves by
 * as much as the due date and takes its kind, so the two stay a valid pair
 * (FR-16); a start that would still come after the due date ends at it. The
 * write names `timeZone`, as the editor's does (`formToTodoInput`): a series
 * given a time takes it there (FR-17).
 */
export function withDue(todo: Todo, due: Fields, timeZone: string): TodoInput {
  const next = fromFields(due.date, due.time, timeZone)
  const patch = { due: next.value, dueAllDay: next.allDay, timezone: timeZone }
  if (!due.date || !todo.start) return todoToInput(todo, patch)

  const before = toFields(todo.due, todo.dueAllDay, timeZone)
  let start = toFields(todo.start, todo.startAllDay, timeZone)
  if (before.date) {
    const days = differenceInCalendarDays(parseDayKey(due.date), parseDayKey(before.date))
    const minutes = start.time && before.time && due.time ? minutesOf(due.time) - minutesOf(before.time) : 0
    start = shiftFields(start, days, minutes)
  }
  if (!due.time) start = { date: start.date, time: '' }
  else if (!start.time || !before.time) start = { date: start.date, time: due.time }
  if (`${start.date}T${start.time}` > `${due.date}T${due.time}`) start = due

  const s = fromFields(start.date, start.time, timeZone)
  return todoToInput(todo, { ...patch, start: s.value, startAllDay: s.allDay })
}
