import { createContext, use } from 'react'
import { type MoveWindow } from '@/lib/calendarTasks'
import { type CalEvent } from '@/lib/events'

export interface DndState {
  /** Occurrence keys with a pending (recurring) move: show a loading state. */
  pendingKeys: ReadonlySet<string>
  /** IDs of recurring todos with an update on its way (FR-17), from `usePendingSeries`: their calendar entries show a busy state and can't be dragged. */
  pendingTodos: ReadonlySet<string>
  /** Live resize preview: the event being resized, with the end a drop would save. */
  resize: CalEvent | null
  /** Move window of the active drag's task, when it is a bounded series (FR-17): the views hatch days outside it. */
  moveWindow: MoveWindow | null
  activeId: string | null
}

export const DndStateContext = createContext<DndState>({
  pendingKeys: new Set(),
  pendingTodos: new Set(),
  resize: null,
  moveWindow: null,
  activeId: null,
})

export function useDndState(): DndState {
  return use(DndStateContext)
}
