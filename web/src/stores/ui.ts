import { create } from 'zustand'
import { type ViewKind } from '@/lib/dates'
import { type CalEvent, type CalItem } from '@/lib/events'
import { type Todo } from '@/lib/api/schemas'
import { type TaskRepeat } from '@/lib/calendarTasks'
import { browserTimeZone } from '@/lib/locale'
import { draftOf, type CreateOrigin, type CreateWhen, type Draft } from '@/lib/quickCreate'
import { useSettings } from './settings'

/** A new event or task in its editor (FR-09, FR-16). */
export interface CreateEditorState {
  mode: 'create'
  draft: Draft
  /** Opened by a switch of the kind: the focus stays on the switch (NFR-27). */
  switched?: boolean
}

export type EditorState = CreateEditorState | { mode: 'edit'; event: CalEvent } | null

/**
 * A task in its editor (FR-16, FR-17): the series `todo`, at its `repeat` that
 * was clicked; without one, a series opens at its current repeat.
 */
export type TaskEditorState = CreateEditorState | { mode: 'edit'; todo: Todo; repeat?: TaskRepeat | undefined } | null

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
  /** When the create popover's entry happens: its fields and a drag of its draft in the calendar set it. */
  createWhen: CreateWhen | null
  /**
   * The create popover's entry as the views draw it; written by the popover.
   * Kept beside `create`, so writing it does not render the popover again.
   */
  createPreview: CalItem | null
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
  /** `at`: the column and slot the popover points at since its draft was dragged there. */
  setCreateWhen: (when: Partial<CreateWhen>, at?: Pick<CreateState, 'anchor' | 'span'>) => void
  setCreatePreview: (preview: CalItem | null) => void
  openTaskEditor: (state: TaskEditorState) => void
  setSettingsOpen: (open: boolean) => void
  setShortcutsOpen: (open: boolean) => void
  setBackendReachable: (reachable: boolean) => void
}

const noCreate = { create: null, createWhen: null, createPreview: null }

const wide = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches

export const useUi = create<UiState>()((set) => ({
  view: useSettings.getState().defaultView,
  date: new Date(),
  sidebarOpen: wide(),
  editor: null,
  detail: null,
  create: null,
  createWhen: null,
  createPreview: null,
  taskEditor: null,
  settingsOpen: false,
  shortcutsOpen: false,
  backendReachable: true,

  setView: (view) => {
    set({ view, detail: null, ...noCreate })
  },
  setDate: (date) => {
    set({ date, detail: null, ...noCreate })
  },
  setSidebarOpen: (sidebarOpen) => {
    set({ sidebarOpen })
  },
  // One editor at a time: they share a dialog, and a new entry switches between them.
  openEditor: (editor) => {
    set({ editor, taskEditor: null, detail: null, ...noCreate })
  },
  openDetail: (detail) => {
    set({ detail })
  },
  openCreate: (state) => {
    // The entry the click begins; the popover starts from the same.
    const when = state && draftOf(state.origin, browserTimeZone())
    set({ create: state, createWhen: when && { event: when.event, task: when.task }, createPreview: null, detail: null })
  },
  setCreateWhen: (when, at) => {
    set((s) => {
      if (!s.create || !s.createWhen) return {}
      return { createWhen: { ...s.createWhen, ...when }, create: at ? { ...s.create, ...at } : s.create }
    })
  },
  setCreatePreview: (preview) => {
    set((s) => (s.create ? { createPreview: preview } : {}))
  },
  openTaskEditor: (taskEditor) => {
    set({ taskEditor, editor: null, detail: null, ...noCreate })
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
