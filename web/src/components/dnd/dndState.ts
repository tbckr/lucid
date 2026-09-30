import { createContext, use } from 'react'
import { type CalEvent } from '@/lib/events'

export interface DndState {
  /** Occurrence keys with a pending (recurring) move: show a loading state. */
  pendingKeys: ReadonlySet<string>
  /** IDs of recurring todos with an update on its way (FR-17), from `usePendingSeries`: their calendar entries show a busy state and can't be dragged. */
  pendingTodos: ReadonlySet<string>
  /** Live resize preview: the event being resized, with the end a drop would save. */
  resize: CalEvent | null
  activeId: string | null
}

export const DndStateContext = createContext<DndState>({
  pendingKeys: new Set(),
  pendingTodos: new Set(),
  resize: null,
  activeId: null,
})

export function useDndState(): DndState {
  return use(DndStateContext)
}
