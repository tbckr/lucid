import { createContext, use, useMemo, type CSSProperties } from 'react'
import { type EventColors } from '@/hooks/useCalendarColors'
import { withScopePreview, type ScopePreview } from '@/lib/dnd'
import { type CalEvent, type CalItem } from '@/lib/events'

export interface DndState {
  /** Occurrence keys with a pending (recurring) move: show a loading state. */
  pendingKeys: ReadonlySet<string>
  /**
   * IDs of event series with an undo on its way (FR-17): all their events show a loading state,
   * by ID since "All events" has reloaded them with other keys than the undo was started with.
   */
  pendingSeries: ReadonlySet<string>
  /** IDs of recurring todos with an update on its way (FR-17), from `usePendingSeries`: their calendar entries show a busy state and can't be dragged. */
  pendingTodos: ReadonlySet<string>
  /** Live resize preview: the event being resized, with the end a drop would save. */
  resize: CalEvent | null
  activeId: string | null
  /**
   * A dropped event of a series, or repeat of a task series, while the
   * question which ones move is open (FR-10, FR-17): it shows at its new
   * place, the tiles the option in focus reaches get a ring, and nothing can
   * be dragged meanwhile.
   */
  scope: ScopePreview | null
  /**
   * An event moved with "Only this event", or a task's repeat with "Only this
   * repeat", until the write has settled: it stays where it was dropped
   * instead of jumping back until the optimistic update, or the detached
   * task, is in (NFR-26).
   */
  held: ScopePreview | null
  /** Extra ref for the tile of `scope.key`, which the question points at. */
  scopeAnchor: (el: HTMLElement | null) => void
}

export const DndStateContext = createContext<DndState>({
  pendingKeys: new Set(),
  pendingSeries: new Set(),
  pendingTodos: new Set(),
  resize: null,
  activeId: null,
  scope: null,
  held: null,
  scopeAnchor: () => undefined,
})

export function useDndState(): DndState {
  return use(DndStateContext)
}

/** `items` as the views show them while an event or task's repeat of a series waits for, or saves, its answer (FR-17). */
export function useScopePreview(items: CalItem[]): CalItem[] {
  const { scope, held } = useDndState()
  return useMemo(() => withScopePreview(withScopePreview(items, held), scope), [items, held, scope])
}

/** The 2 px ring of a tile the scope question is about (FR-17), in its calendar's color. */
export function ringStyle(ringed: boolean, colors: EventColors): CSSProperties | undefined {
  return ringed ? ({ '--tw-ring-color': colors.solid } as CSSProperties) : undefined
}
