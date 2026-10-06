import { type CalEvent } from './events'
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
