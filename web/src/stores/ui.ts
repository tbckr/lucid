import { create } from 'zustand'
import { type ViewKind } from '@/lib/dates'
import { type CalEvent, type CalItem } from '@/lib/events'
import { type Todo } from '@/lib/api/schemas'
import { type TaskWhen } from '@/lib/quickCreate'
import { useSettings } from './settings'

export interface CreateDefaults {
  start: Date
  end: Date
  allDay: boolean
  /** Carried over from the create popover. */
  title?: string
  calendarId?: string
}

/** A new task handed over from the create popover (FR-16). */
export interface TaskCreateDefaults extends TaskWhen {
  title: string
  calendarId: string
}

export type TaskEditorState = { mode: 'edit'; todo: Todo } | { mode: 'create'; defaults: TaskCreateDefaults } | null

export type EditorState =
  | { mode: 'create'; defaults: CreateDefaults }
  | { mode: 'edit'; event: CalEvent }
  | null

export interface DetailState {
  /** The event or task whose details are shown (FR-09, FR-16). */
  item: CalItem
  /** Element the popover is anchored to; focus returns here on close. */
  anchor: HTMLElement
}

interface UiState {
  view: ViewKind
  date: Date
  sidebarOpen: boolean
  editor: EditorState
  detail: DetailState | null
  taskEditor: TaskEditorState
  settingsOpen: boolean
  shortcutsOpen: boolean
  /** Backend reachable (updated by API client + /healthz polling). */
  backendReachable: boolean

  setView: (view: ViewKind) => void
  setDate: (date: Date) => void
  setSidebarOpen: (open: boolean) => void
  openEditor: (editor: EditorState) => void
  openDetail: (detail: DetailState | null) => void
  openTaskEditor: (state: TaskEditorState) => void
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
    set({ taskEditor, detail: null })
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
