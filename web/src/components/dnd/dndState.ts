import { createContext, use } from 'react'
import { type CalEvent } from '@/lib/events'

export interface DndState {
  /** Occurrence keys with a pending (recurring) move: show a loading state. */
  pendingKeys: ReadonlySet<string>
  /** Live resize preview: the event being resized, with the end a drop would save. */
  resize: CalEvent | null
  activeId: string | null
}

export const DndStateContext = createContext<DndState>({ pendingKeys: new Set(), resize: null, activeId: null })

export function useDndState(): DndState {
  return use(DndStateContext)
}
