import { type TFunction } from 'i18next'
import { type CalEvent } from './events'
import { formatPickerDate, type FormatPrefs } from './format'
import { moveAllRefusal, type ShiftReason } from './seriesShift'

/** Which events of a recurring series a change reaches: this one, this and the later ones, or all. */
export type Scope = 'this' | 'following' | 'all'

/**
 * What the user does to an occurrence: drags it (`move`), resizes it or saves
 * the editor with its rule and all-day flag untouched (`change`), saves the
 * editor with the rule changed or removed or the all-day flag toggled
 * (`rule`), or deletes it (`delete`).
 */
export type ScopeAction = 'move' | 'change' | 'rule' | 'delete'

export interface ScopeResult {
  /** The scopes the change can be applied to; empty for an event that is not part of a series. */
  options: Scope[]
  /** Why `'all'` is missing from a move or change, set only then. */
  reason?: ShiftReason
  /**
   * What took `'following'` away from a question of two options or more: the
   * series has attendees, which the server does not split. Absent when the
   * first event is acted on, which has nothing before it, and when one option
   * is left, which no question shows.
   */
  missing?: 'attendees'
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
 */
export function scopeOptions(input: {
  kind: 'event'
  action: ScopeAction
  item: CalEvent
  to?: Date
  tz: string
}): ScopeResult {
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

/** One of the five places of the reach glyph: an event the change reaches, or one it leaves as it is. */
export type GlyphSlot = 'affected' | 'kept'

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

/** An option of the scope question: its scope, its label, and a line on what it reaches. */
export interface ScopeItem {
  scope: Scope
  label: string
  note: string
}

/**
 * What the notes of the scope question say the change does: `change` for a
 * move or a save, `delete` for a delete, `ruleRemoved` for a save that makes
 * the series a single event (everything but this event goes).
 */
export type ScopeNotes = 'change' | 'delete' | 'ruleRemoved'

/**
 * The options `options` of a change of `event` as the scope question lists
 * them (FR-17), in the same order. The notes name the day the event is shown
 * on, and say what `notes` does to the events they reach.
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
    switch (scope) {
      case 'this':
        return { scope, label: t('scope.event.this'), note: t('scope.event.thisNote', { date }) }
      case 'following':
        return { scope, label: t('scope.event.following'), note: followingNote(t, notes, date) }
      case 'all':
        return {
          scope,
          label: t('scope.event.all'),
          note: notes === 'ruleRemoved' ? t('scope.event.allRuleRemovedNote') : t('scope.event.allNote'),
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

/** Why the question has no "this and following events", where the user could expect it; `undefined` when nothing is missing (FR-17). */
export function eventScopeMissing(t: TFunction, result: ScopeResult): string | undefined {
  return result.missing === 'attendees' ? t('scope.missing.attendees') : undefined
}

/** What a change of a series reaches when there is no choice: in words, as reach glyph, and whether in red. */
export interface ScopeHint {
  text: string
  reach: Scope
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
      return { text: t('scope.hint.eventThis', { reason }).trim(), reach: 'this', tone: 'default' }
    }
    case 'all':
      return ruleRemoved
        ? { text: t('scope.hint.eventRuleRemoved'), reach: 'all', tone: 'destructive' }
        : { text: t('scope.hint.eventAll'), reach: 'all', tone: 'default' }
    case 'following':
      // "This and following" never stands alone: it comes with "all" or with "this" and "all", so it is a
      // question and has no hint.
      return null
  }
}
