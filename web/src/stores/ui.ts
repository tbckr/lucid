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

/**
 * An event or task the user added to the problem report (FR-36). The report gets its object's ID and kind; the
 * `label` (its title) and the calendar's name and color are shown in the dialog only, never written to the report.
 */
export interface ReportCandidate {
  objectId: string
  kind: 'event' | 'todo'
  label: string
  calendarId: string
}

/** An object's raw content as the problem report shows it: asked for one at a time (FR-36). */
export type ReportContent = { status: 'loading' } | { status: 'failed' } | { status: 'shown'; text: string }

/**
 * The problem report (FR-36). Its items, the contents it showed and the ticks that add them stay while it is open
 * or waits, and only in the browser; a download, a discard or the end of the session forgets all of them.
 */
export interface ReportState {
  /** The dialog is open. */
  open: boolean
  /** The items the user added, newest first. */
  candidates: ReportCandidate[]
  /** The user chose to add an item: the report waits for it even while it has none. */
  waiting: boolean
  /** The raw contents the user asked to see, by object ID. */
  shown: ReadonlyMap<string, ReportContent>
  /** The object IDs whose shown content the user ticked: only these go into the file. */
  included: ReadonlySet<string>
}

export const emptyReport: ReportState = {
  open: false,
  candidates: [],
  waiting: false,
  shown: new Map(),
  included: new Set(),
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
  /**
   * The problem report (FR-36). Closed with items, or to add one, it waits in the tray, so several items can be
   * added one after the other; closed without, it is forgotten.
   */
  report: ReportState
  /**
   * The session ended without the user signing out: an `unauthenticated` answer while signed in, such as a forced
   * logout (FR-36). The login page then says so and offers the problem report; signing in clears it.
   */
  signedOut: boolean

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
  /** Opens the problem report, adding `candidate` first unless it is in it already (by object ID). */
  openReport: (candidate?: ReportCandidate) => void
  /** Closes the problem report: with items it waits, without it is forgotten. */
  closeReport: () => void
  /** Closes the problem report to add an item: it waits, also without one. */
  parkReport: () => void
  removeReportCandidate: (objectId: string) => void
  /** Forgets the report, its items, shown contents and ticks: after a download, a discard and on sign-out. */
  clearReport: () => void
  /** Puts back a report that was discarded (Undo). */
  restoreReport: (report: ReportState) => void
  showReportContent: (objectId: string, content: ReportContent) => void
  includeReportContent: (objectId: string, on: boolean) => void
  setSignedOut: (signedOut: boolean) => void
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
  report: emptyReport,
  signedOut: false,

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
  // A modal dialog: the popovers it may be opened from close, as for the editors.
  openReport: (candidate) => {
    set((s) => {
      const { candidates } = s.report
      const added = candidate && !candidates.some((c) => c.objectId === candidate.objectId)
      return {
        report: { ...s.report, open: true, waiting: false, candidates: added ? [candidate, ...candidates] : candidates },
        detail: null,
        ...noCreate,
      }
    })
  },
  closeReport: () => {
    set((s) => ({ report: s.report.candidates.length > 0 ? { ...s.report, open: false } : emptyReport }))
  },
  parkReport: () => {
    set((s) => ({ report: { ...s.report, open: false, waiting: true } }))
  },
  // What was shown and ticked of the item goes with it: added again, it starts unseen and unticked.
  removeReportCandidate: (objectId) => {
    set((s) => {
      const shown = new Map(s.report.shown)
      shown.delete(objectId)
      const included = new Set(s.report.included)
      included.delete(objectId)
      return {
        report: { ...s.report, candidates: s.report.candidates.filter((c) => c.objectId !== objectId), shown, included },
      }
    })
  },
  clearReport: () => {
    set((s) => ({ report: { ...emptyReport, open: s.report.open } }))
  },
  restoreReport: (report) => {
    set({ report })
  },
  showReportContent: (objectId, content) => {
    set((s) => ({ report: { ...s.report, shown: new Map(s.report.shown).set(objectId, content) } }))
  },
  includeReportContent: (objectId, on) => {
    set((s) => {
      const included = new Set(s.report.included)
      if (on) included.add(objectId)
      else included.delete(objectId)
      return { report: { ...s.report, included } }
    })
  },
  setSignedOut: (signedOut) => {
    set({ signedOut })
  },
}))

/** The problem report waits in the tray: closed with items, or to add one (FR-36). */
export function reportWaits(s: UiState): boolean {
  return !s.report.open && (s.report.waiting || s.report.candidates.length > 0)
}

/** True while any modal surface is open (global shortcuts are suspended). */
export function isModalOpen(s: UiState): boolean {
  return s.editor !== null || s.taskEditor !== null || s.settingsOpen || s.shortcutsOpen || s.report.open
}
