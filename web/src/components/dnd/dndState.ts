import { createContext, use } from 'react'

export interface DndState {
  /** Occurrence keys with a pending (recurring) move: show a loading state. */
  pendingKeys: ReadonlySet<string>
  /** Live resize preview in minutes for the event being resized. */
  resize: { key: string; minutes: number } | null
  activeId: string | null
}

export const DndStateContext = createContext<DndState>({ pendingKeys: new Set(), resize: null, activeId: null })

export function useDndState(): DndState {
  return use(DndStateContext)
}
