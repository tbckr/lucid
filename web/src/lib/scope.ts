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
}

/**
 * The scopes a change of an event can be applied to (FR-17). Only an
 * occurrence of a series (`recurring` with a `recurrenceId`) has a choice;
 * for anything else the result is empty and callers treat it as a single
 * event. `'following'` is never offered yet.
 *
 * `to` is the new start of a `move` or `change`; without it the shown start
 * is used, as for a resize that keeps the start. That is the wire `start`:
 * for an all-day event the UTC midnight `moveAllRefusal` reads, not the local
 * midnight of `startsAt`. A series follows such a change only if
 * `seriesShift` allows it, which `reason` explains when it does not. A rule
 * change can only apply to the whole series, and a delete to either.
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
      return { options: ['all'] }
    case 'delete':
      return { options: ['this', 'all'] }
    case 'move':
    case 'change': {
      const reason = moveAllRefusal(item, to ?? new Date(item.start), tz)
      return reason === null ? { options: ['this', 'all'] } : { options: ['this'], reason }
    }
  }
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
 * The options `options` of a change of `event` as the scope question lists
 * them (FR-17), in the same order. "Only this event" names the day the event
 * is shown on. `'following'` has no words before phase 3 and throws.
 */
export function eventScopeItems(t: TFunction, event: CalEvent, options: Scope[], prefs: FormatPrefs, now: Date): ScopeItem[] {
  return options.map((scope) => {
    switch (scope) {
      case 'this':
        return {
          scope,
          label: t('scope.event.this'),
          note: t('scope.event.thisNote', { date: formatPickerDate(event.startsAt, prefs, now) }),
        }
      case 'all':
        return { scope, label: t('scope.event.all'), note: t('scope.event.allNote') }
      case 'following':
        throw new Error('"This and following events" is not offered for events yet')
    }
  })
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
 * red. `'following'` has no words before phase 3 and throws.
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
      throw new Error('"This and following events" is not offered for events yet')
  }
}
