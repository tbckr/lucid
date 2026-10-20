import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { type ViewKind } from '@/lib/dates'
import { type Language, type WeekStart } from '@/lib/locale'

export type LanguageSetting = 'auto' | Language
export type TimeFormatSetting = 'auto' | '12h' | '24h'
export type WeekStartSetting = 'auto' | WeekStart
export type ThemeSetting = 'system' | 'light' | 'dark'

export interface SettingsState {
  language: LanguageSetting
  timeFormat: TimeFormatSetting
  weekStart: WeekStartSetting
  defaultView: ViewKind
  theme: ThemeSetting
  /** Stable IDs (`Calendar.stableId`, which survive a restart of Lucid) of the calendars hidden in the sidebar (FR-05). */
  hiddenCalendars: string[]
  /** Fold the completed group of the task panel away (FR-12). */
  hideCompletedTasks: boolean
  /** Hide completed and cancelled tasks in the calendar views, independent of the task panel (FR-16). */
  hideCompletedInCalendar: boolean
  /** Stable ID of the list shown in the task panel; the first list if empty or gone (FR-12). */
  taskList: string
  tasksOpen: boolean
  /** Last server URL used for login (convenience, not a secret). */
  lastServerUrl: string

  update: (patch: Partial<Omit<SettingsState, 'update' | 'toggleCalendar'>>) => void
  /** Hide the calendar with this stable ID, or show it again. */
  toggleCalendar: (stableId: string) => void
}

export const defaultSettings = {
  language: 'auto',
  timeFormat: 'auto',
  weekStart: 'auto',
  defaultView: 'month',
  theme: 'system',
  hiddenCalendars: [],
  hideCompletedTasks: false,
  hideCompletedInCalendar: false,
  taskList: '',
  tasksOpen: true,
  lastServerUrl: '',
} satisfies Omit<SettingsState, 'update' | 'toggleCalendar'>

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaultSettings,
      update: (patch) => {
        set(patch)
      },
      toggleCalendar: (stableId) => {
        set((s) => ({
          hiddenCalendars: s.hiddenCalendars.includes(stableId)
            ? s.hiddenCalendars.filter((c) => c !== stableId)
            : [...s.hiddenCalendars, stableId],
        }))
      },
    }),
    {
      name: 'lucid:settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ update: _u, toggleCalendar: _t, ...rest }) => rest,
    },
  ),
)
