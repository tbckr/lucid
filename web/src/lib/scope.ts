import { type TFunction } from 'i18next'
import { anchorOf, type TaskDates, type TaskRepeat } from './calendarTasks'
import { utcDateToLocal } from './dates'
import { type CalEvent } from './events'
import { formatPickerDate, type FormatPrefs } from './format'
import { moveAllRefusal, taskMoveRefusal, type ShiftReason } from './seriesShift'
import { isDone } from './tasks'

/**
 * Which events of a recurring series, or repeats of a task series, a change
 * reaches: this one, this and the later ones, or all.
 */
export type Scope = 'this' | 'following' | 'all'

/**
 * What the user does to an occurrence: drags it (`move`), resizes it or saves
 * the editor with its rule and all-day flag untouched (`change`), saves the
 * editor with the rule changed or removed or the all-day flag toggled
 * (`rule`), or deletes it (`delete`). For a task's repeat, `move` is any
 * change of its dates, the all-day flags among them, and `change` one of its
 * other fields alone.
 */
export type ScopeAction = 'move' | 'change' | 'rule' | 'delete'

export interface ScopeResult {
  /**
   * The scopes the change can be applied to; empty for an event that is not
   * part of a series and a task that acts as a single one, which are saved as
   * they are, and for a move no option allows (`reason` set), which nothing
   * saves.
   */
  options: Scope[]
  /** Why `'all'` is missing from a move or change, or for a task's later repeat `'following'`, set only then. */
  reason?: ShiftReason
  /**
   * What took an option away where the user could expect it (FR-17):
   * - `attendees`: the series has attendees, which the server does not split,
   *   so `'following'` is missing. For an event only in a question of two
   *   options or more: absent when the first event is acted on, which has
   *   nothing before it, and when one option is left, which no question
   *   shows. For a task's later repeat, where one option is left, its hint
   *   says it.
   * - `attendeesTask`: the series has attendees, which no repeat can be
   *   detached from, so a task's current repeat has no `'this'`.
   * - `taskThis`: a task's later repeat has no `'this'`, which only the
   *   current one has; set in its questions alone.
   *
   * Never set for a task without an option left.
   */
  missing?: 'attendees' | 'attendeesTask' | 'taskThis'
}

/**
 * The scopes a change of an event can be applied to (FR-17). Only an
 * occurrence of a series (`recurring` with a `recurrenceId`) has a choice;
 * for anything else the result is empty and callers treat it as a single
 * event.
 *
 * `to` is the new start of a `move` or `change`; without it the shown start
 * is used, as for a resize that keeps the start. That is the wire `start`:
 * for an all-day event the UTC midnight `moveAllRefusal` reads, not the local
 * midnight of `startsAt`. A series follows such a change only if
 * `seriesShift` allows it, which `reason` explains when it does not. The same
 * goes for `'following'`, which also needs an event with something before it
 * (`!first`) and a series without attendees (`hasAttendees`), as the server
 * splits no other; `missing` names the attendees where they alone decide. A
 * rule change applies to the whole series or from this event on, a delete to
 * this event, the following ones or all.
 *
 * `kind: 'task'` asks the same of a task series' repeat, with its new dates
 * as `to` (`taskScopeOptions`). It needs no browser zone: a task series
 * without a zone of its own is judged in UTC, as the server judges it.
 */
export function scopeOptions(
  input:
    | { kind: 'event'; action: ScopeAction; item: CalEvent; to?: Date; tz: string }
    | { kind: 'task'; action: ScopeAction; item: TaskRepeat; to?: TaskDates },
): ScopeResult {
  if (input.kind === 'task') return taskScopeOptions(input.action, input.item, input.to)
  const { action, item, to, tz } = input
  if (!item.recurring || !item.recurrenceId) return { options: [] }

  switch (action) {
    case 'rule':
      // A single option is no question, so attendees are not `missing` here.
      return { options: canSplit(item) ? ['following', 'all'] : ['all'] }
    case 'delete':
      return thisFollowingAll(item)
    case 'move':
    case 'change': {
      const reason = moveAllRefusal(item, to ?? new Date(item.start), tz)
      return reason === null ? thisFollowingAll(item) : { options: ['this'], reason }
    }
  }
}

/** Whether the series can be split before `item`: it has an earlier event, and no attendees, which the server refuses (FR-17). */
function canSplit(item: CalEvent): boolean {
  return !item.first && !item.hasAttendees
}

/** This event, the following ones where the series can be split, all of them; with `missing` where attendees alone prevent it. */
function thisFollowingAll(item: CalEvent): ScopeResult {
  if (canSplit(item)) return { options: ['this', 'following', 'all'] }
  return item.first ? { options: ['this', 'all'] } : { options: ['this', 'all'], missing: 'attendees' }
}

/**
 * The scopes a change of a task series' `repeat` can be applied to (FR-17),
 * the branch of `scopeOptions` for tasks. A task that does not repeat, a
 * series Lucid cannot read or that is done, and the last repeat act as a
 * single task: no options and no reason.
 *
 * At the current repeat, "only this repeat" detaches it (not with
 * attendees, `missing: 'attendeesTask'`), or skips it on a delete; there is
 * no "this and following", which would be all. At a later repeat, "this and
 * following" splits the series there (not with attendees, `missing:
 * 'attendees'`, nor from a repeat off the rule); "only this repeat" is
 * never offered there, which a question says (`missing: 'taskThis'`). "All
 * repeats" is always offered. A rule change detaches nothing.
 *
 * A move (`to`, else the shown dates) keeps an option only where the series
 * can follow it (`taskMoveRefusal`): "this and following" from the repeat,
 * "all repeats" from the current one. `reason` names a refusal that took
 * one of them away; with no option left, the move is refused.
 */
function taskScopeOptions(action: ScopeAction, repeat: TaskRepeat, to: TaskDates | undefined): ScopeResult {
  const { todo } = repeat
  if (!todo.recurring || todo.ruleUnsupported || isDone(todo) || repeat.last) return { options: [] }

  const moved = to ?? repeat.shown
  const refusal = (from: 'repeat' | 'current') => (action === 'move' ? taskMoveRefusal(repeat, moved, from) : null)
  const allRefused = refusal('current')
  const options: Scope[] = []
  let reason = allRefused
  let missing: ScopeResult['missing']

  if (repeat.at === 'current') {
    // Skipping detaches nothing, so a delete offers it with attendees too.
    if (action === 'delete' || (action !== 'rule' && !todo.hasAttendees)) options.push('this')
    else if (action !== 'rule') missing = 'attendeesTask'
  } else if (!repeat.offRule) {
    const followingRefused = refusal('repeat')
    if (followingRefused) reason ??= followingRefused
    else if (todo.hasAttendees) missing = 'attendees'
    else options.push('following')
  }
  if (!allRefused) options.push('all')
  if (repeat.at === 'upcoming' && options.length > 1) missing = 'taskThis'

  const result: ScopeResult = { options }
  if (reason) result.reason = reason
  // What is missing is said below a question's options or after a hint's sentence, so only with an option left.
  if (missing && options.length > 0) result.missing = missing
  return result
}

/**
 * One of the five places of the reach glyph: an event or repeat the change
 * reaches, one it leaves as it is, or a task's repeat that is done and stays.
 */
export type GlyphSlot = 'affected' | 'kept' | 'done'

/**
 * The five places of the reach glyph for `reach` (FR-17): the middle one is
 * the event acted on, the ones left of it earlier events, the ones right of it
 * later ones.
 */
export function glyphSlots(reach: Scope): GlyphSlot[] {
  switch (reach) {
    case 'this':
      return ['kept', 'kept', 'affected', 'kept', 'kept']
    case 'following':
      return ['kept', 'kept', 'affected', 'affected', 'affected']
    case 'all':
      return ['affected', 'affected', 'affected', 'affected', 'affected']
  }
}

/**
 * The five places of the reach glyph for `reach` from a task's repeat `at`
 * the current one or a later one (FR-17). Left of the middle are the done
 * repeats, which every option leaves as they are (a check), and from a later
 * repeat the current one, which "all repeats" reaches too; right of it the
 * later ones. "Only this repeat" is offered at the current repeat alone, and
 * "this and following" at a later one; the other two are drawn by the same
 * rule.
 */
export function taskGlyphSlots(reach: Scope, at: TaskRepeat['at']): GlyphSlot[] {
  const before: GlyphSlot[] = at === 'current' ? ['done', 'done'] : ['done', reach === 'all' ? 'affected' : 'kept']
  const after: GlyphSlot[] = reach === 'this' ? ['kept', 'kept'] : ['affected', 'affected']
  return [...before, 'affected', ...after]
}

/** An option of the scope question: its scope, its label, a line on what it reaches, and its reach glyph. */
export interface ScopeItem {
  scope: Scope
  label: string
  note: string
  slots: GlyphSlot[]
}

/**
 * What the notes of the scope question say the change does: `change` for a
 * move or a save, `delete` for a delete, `ruleRemoved` for a save that makes
 * the series a single event or task (everything but this event goes, or the
 * upcoming repeats).
 */
export type ScopeNotes = 'change' | 'delete' | 'ruleRemoved'

/**
 * Where "this and following events" from `event` starts (FR-17): the earlier
 * of its recurrence date and its shown start. The server splits a series by
 * recurrence ID, so an event changed on its own to a later day takes the
 * events between along, and one changed to an earlier day goes itself. An
 * all-day event's recurrence date is read as a date, as its start is.
 */
export function followingStart(event: CalEvent): Date {
  if (!event.recurrenceId) return event.startsAt
  const rid = event.allDay ? utcDateToLocal(event.recurrenceId) : new Date(event.recurrenceId)
  return rid < event.startsAt ? rid : event.startsAt
}

/**
 * The options `options` of a change of `event` as the scope question lists
 * them (FR-17), in the same order. The notes name the day the event is shown
 * on, "this and following" the day it starts from (`followingStart`), and say
 * what `notes` does to the events they reach.
 */
export function eventScopeItems(
  t: TFunction,
  event: CalEvent,
  options: Scope[],
  prefs: FormatPrefs,
  now: Date,
  notes: ScopeNotes = 'change',
): ScopeItem[] {
  const date = formatPickerDate(event.startsAt, prefs, now)
  return options.map((scope) => {
    const slots = glyphSlots(scope)
    switch (scope) {
      case 'this':
        return { scope, label: t('scope.event.this'), note: t('scope.event.thisNote', { date }), slots }
      case 'following': {
        const from = formatPickerDate(followingStart(event), prefs, now)
        return { scope, label: t('scope.event.following'), note: followingNote(t, notes, from), slots }
      }
      case 'all':
        return {
          scope,
          label: t('scope.event.all'),
          note: notes === 'ruleRemoved' ? t('scope.event.allRuleRemovedNote') : t('scope.event.allNote'),
          slots,
        }
    }
  })
}

function followingNote(t: TFunction, notes: ScopeNotes, date: string): string {
  switch (notes) {
    case 'change':
      return t('scope.followingNote', { date })
    case 'delete':
      return t('scope.followingDeleteNote', { date })
    case 'ruleRemoved':
      return t('scope.followingRuleRemovedNote', { date })
  }
}

/**
 * Where "this and following" from a task's `repeat` starts (FR-17): the
 * earlier of its recurrence date and the date it is shown on, as for an event
 * (`followingStart`), since the server splits a task series by recurrence ID
 * too. A recurrence date is read as a date where the repeat is shown on one.
 * The toast after the split or the end names the same day.
 */
export function taskFollowingStart(repeat: TaskRepeat): Date | null {
  const shown = anchorOf(repeat.shown)
  if (!shown) return null
  const allDay = repeat.shown.start ? repeat.shown.startAllDay : repeat.shown.dueAllDay
  const rid = allDay ? utcDateToLocal(repeat.recurrenceId) : new Date(repeat.recurrenceId)
  return rid < shown ? rid : shown
}

/** The day the series of `repeat` goes on after it, as the notes name it: its next repeat's (FR-17). */
function nextDay(repeat: TaskRepeat, prefs: FormatPrefs, now: Date): string {
  const next = repeat.todo.next
  const at =
    next &&
    anchorOf({
      start: next.start,
      startAllDay: next.startAllDay ?? false,
      due: next.due,
      dueAllDay: next.dueAllDay ?? false,
    })
  return at ? formatPickerDate(at, prefs, now) : ''
}

/**
 * The options `options` of a change of a task series' `repeat` as the scope
 * question lists them (FR-17), in the same order, each with its reach glyph
 * from where the repeat is. "Only this repeat", offered at the current repeat
 * alone, names the day the series goes on; "this and following" the day it
 * starts from (`taskFollowingStart`). The notes say what `notes` does to the
 * repeats an option reaches: a removed rule leaves this repeat as a single
 * task, or stops the series.
 */
export function taskScopeItems(
  t: TFunction,
  repeat: TaskRepeat,
  options: Scope[],
  prefs: FormatPrefs,
  now: Date,
  notes: ScopeNotes,
): ScopeItem[] {
  return options.map((scope) => {
    const slots = taskGlyphSlots(scope, repeat.at)
    switch (scope) {
      case 'this': {
        const next = nextDay(repeat, prefs, now)
        const note = notes === 'delete' ? t('scope.task.thisDeleteNote', { next }) : t('scope.task.thisNote', { next })
        return { scope, label: t('scope.task.this'), note, slots }
      }
      case 'following': {
        const start = taskFollowingStart(repeat)
        const date = start ? formatPickerDate(start, prefs, now) : ''
        const note =
          notes === 'ruleRemoved' ? t('scope.task.followingRuleRemovedNote', { date }) : followingNote(t, notes, date)
        return { scope, label: t('scope.task.following'), note, slots }
      }
      case 'all':
        return { scope, label: t('scope.task.all'), note: taskAllNote(t, notes), slots }
    }
  })
}

/** What "all repeats" does to a task series: done ones stay, or, with the rule removed, it stops. */
function taskAllNote(t: TFunction, notes: ScopeNotes): string {
  switch (notes) {
    case 'change':
      return t('scope.task.allNote')
    case 'delete':
      return t('scope.task.allDeleteNote')
    case 'ruleRemoved':
      return t('scope.hint.taskRuleRemoved')
  }
}

/** Why the question has no "this and following events", where the user could expect it; `undefined` when nothing is missing (FR-17). */
export function eventScopeMissing(t: TFunction, result: ScopeResult): string | undefined {
  return result.missing === 'attendees' ? t('scope.missing.attendees') : undefined
}

/**
 * Why a change of a task series has no "only this repeat" or no "this and
 * following", where the user could expect it (FR-17); `undefined` when
 * nothing is missing. A question says it below its options; a hint after its
 * sentence (`taskScopeHint`).
 */
export function taskScopeMissing(t: TFunction, result: ScopeResult): string | undefined {
  switch (result.missing) {
    case 'attendees':
      return t('scope.missing.attendees')
    case 'attendeesTask':
      return t('scope.missing.attendeesTask')
    case 'taskThis':
      return t('scope.missing.taskThis')
    case undefined:
      return undefined
  }
}

/**
 * What a change of a series reaches when there is no choice: in words, the
 * option it reaches, its reach glyph, and whether in red.
 */
export interface ScopeHint {
  text: string
  reach: Scope
  slots: GlyphSlot[]
  tone: 'default' | 'destructive'
}

/**
 * What a change of an event series reaches when it has exactly one option
 * (FR-17), said before it happens: under the dragged event, in the editor's
 * footer, and to screen readers while dragging (NFR-27). `null` with a
 * choice, which the question asks, or for a single event. `ruleRemoved`: the
 * series becomes this one event, which deletes all others, the only hint in
 * red.
 */
export function eventScopeHint(t: TFunction, result: ScopeResult, ruleRemoved: boolean): ScopeHint | null {
  const [only] = result.options
  if (result.options.length !== 1 || !only) return null
  switch (only) {
    case 'this': {
      const reason = result.reason ? t(`scope.reason.${result.reason}`) : ''
      const text = t('scope.hint.eventThis', { reason }).trim()
      return { text, reach: 'this', slots: glyphSlots('this'), tone: 'default' }
    }
    case 'all': {
      const slots = glyphSlots('all')
      return ruleRemoved
        ? { text: t('scope.hint.eventRuleRemoved'), reach: 'all', slots, tone: 'destructive' }
        : { text: t('scope.hint.eventAll'), reach: 'all', slots, tone: 'default' }
    }
    case 'following':
      // "This and following" never stands alone: it comes with "all" or with "this" and "all", so it is a
      // question and has no hint.
      return null
  }
}

/**
 * What a change of a task series' repeat `at` the current one or a later one
 * reaches when it has exactly one option (FR-17), said before it happens, as
 * `eventScopeHint` says it for events. `null` with a choice, which the
 * question asks, for a single task, for a refused move, which says why
 * (`scope.hint.none`), and for a delete, which asks to confirm instead
 * (`tasks.confirmDeleteSeries`). "All repeats" says that a move moves them
 * all, and warns in red that a removed rule removes the upcoming ones. Where
 * attendees took the other option away, a second sentence says so; "only
 * this repeat", missing at every later repeat, is not worth one.
 */
export function taskScopeHint(
  t: TFunction,
  result: ScopeResult,
  action: ScopeAction,
  ruleRemoved: boolean,
  at: TaskRepeat['at'],
): ScopeHint | null {
  const [only] = result.options
  if (result.options.length !== 1 || !only || action === 'delete') return null
  const missing = result.missing === 'taskThis' ? undefined : taskScopeMissing(t, result)
  const hint = (key: 'taskThis' | 'taskFollowing' | 'taskAll' | 'taskAllMove' | 'taskRuleRemoved'): string =>
    missing ? `${t(`scope.hint.${key}`)} ${missing}` : t(`scope.hint.${key}`)
  const slots = taskGlyphSlots(only, at)
  switch (only) {
    case 'this':
      return { text: hint('taskThis'), reach: 'this', slots, tone: 'default' }
    case 'following':
      return { text: hint('taskFollowing'), reach: 'following', slots, tone: 'default' }
    case 'all':
      if (ruleRemoved) return { text: hint('taskRuleRemoved'), reach: 'all', slots, tone: 'destructive' }
      return { text: hint(action === 'move' ? 'taskAllMove' : 'taskAll'), reach: 'all', slots, tone: 'default' }
  }
}
