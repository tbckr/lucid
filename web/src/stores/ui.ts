import { create } from 'zustand'
import { type ViewKind } from '@/lib/dates'
import { type CalEvent } from '@/lib/events'
import { type Todo } from '@/lib/api/schemas'
import { useSettings } from './settings'

export interface CreateDefaults {
  start: Date
  end: Date
  allDay: boolean
}

export type EditorState =
  | { mode: 'create'; defaults: CreateDefaults }
  | { mode: 'edit'; event: CalEvent }
  | null

export interface DetailState {
  event: CalEvent
  /** Element the popover is anchored to; focus returns here on close. */
  anchor: HTMLElement
}

interface UiState {
  view: ViewKind
  date: Date
  sidebarOpen: boolean
  editor: EditorState
  detail: DetailState | null
  taskEditor: Todo | null
  settingsOpen: boolean
  shortcutsOpen: boolean
  /** Backend reachable (updated by API client + /healthz polling). */
  backendReachable: boolean

  setView: (view: ViewKind) => void
  setDate: (date: Date) => void
  setSidebarOpen: (open: boolean) => void
  openEditor: (editor: EditorState) => void
  openDetail: (detail: DetailState | null) => void
  openTaskEditor: (todo: Todo | null) => void
  setSettingsOpen: (open: boolean) => void
  setShortcutsOpen: (open: boolean) => void
  setBackendReachable: (reachable: boolean) => void
}

const wide = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches

export const useUi = create<UiState>()((set) => ({
  view: useSettings.getState().defaultView,
  date: new Date(),
  sidebarOpen: wide(),
  editor: null,
  detail: null,
  taskEditor: null,
  settingsOpen: false,
  shortcutsOpen: false,
  backendReachable: true,

  setView: (view) => {
    set({ view, detail: null })
  },
  setDate: (date) => {
    set({ date, detail: null })
  },
  setSidebarOpen: (sidebarOpen) => {
    set({ sidebarOpen })
  },
  openEditor: (editor) => {
    set({ editor, detail: null })
  },
  openDetail: (detail) => {
    set({ detail })
  },
  openTaskEditor: (taskEditor) => {
    set({ taskEditor })
  },
  setSettingsOpen: (settingsOpen) => {
    set({ settingsOpen })
  },
  setShortcutsOpen: (shortcutsOpen) => {
    set({ shortcutsOpen })
  },
  setBackendReachable: (backendReachable) => {
    set({ backendReachable })
  },
}))

/** True while any modal surface is open (global shortcuts are suspended). */
export function isModalOpen(s: UiState): boolean {
  return s.editor !== null || s.taskEditor !== null || s.settingsOpen || s.shortcutsOpen
}
