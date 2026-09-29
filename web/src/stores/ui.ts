import { create } from 'zustand'
import { type ViewKind } from '@/lib/dates'
import { type CalEvent, type CalItem } from '@/lib/events'
import { type Todo } from '@/lib/api/schemas'
import { type CreateOrigin, type CreatePreview, type TaskWhen } from '@/lib/quickCreate'
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

/** The create popover at a click in the calendar (FR-09, FR-16). */
export interface CreateState {
  origin: CreateOrigin
  /** Element the popover is measured against: a day column (with `span`) or a cell. */
  anchor: HTMLElement
  /** Minutes of the day column the new entry covers. */
  span?: { startMin: number; endMin: number }
  /** Element that gets the focus back on close. */
  returnFocus: HTMLElement
}

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
  create: CreateState | null
  /**
   * The create popover's entry as the views draw it; written by the popover.
   * Kept beside `create`, so writing it does not render the popover again.
   */
  createPreview: CreatePreview | null
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
  openCreate: (state: CreateState | null) => void
  setCreatePreview: (preview: CreatePreview | null) => void
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
  create: null,
  createPreview: null,
  taskEditor: null,
  settingsOpen: false,
  shortcutsOpen: false,
  backendReachable: true,

  setView: (view) => {
    set({ view, detail: null, create: null, createPreview: null })
  },
  setDate: (date) => {
    set({ date, detail: null, create: null, createPreview: null })
  },
  setSidebarOpen: (sidebarOpen) => {
    set({ sidebarOpen })
  },
  openEditor: (editor) => {
    set({ editor, detail: null, create: null, createPreview: null })
  },
  openDetail: (detail) => {
    set({ detail })
  },
  openCreate: (state) => {
    set({ create: state, createPreview: null, detail: null })
  },
  setCreatePreview: (preview) => {
    set((s) => (s.create ? { createPreview: preview } : {}))
  },
  openTaskEditor: (taskEditor) => {
    set({ taskEditor, detail: null, create: null, createPreview: null })
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
