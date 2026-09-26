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
  /** Calendar IDs hidden in the sidebar (FR-05). */
  hiddenCalendars: string[]
  hideCompletedTasks: boolean
  tasksOpen: boolean
  /** Last server URL used for login (convenience, not a secret). */
  lastServerUrl: string

  update: (patch: Partial<Omit<SettingsState, 'update' | 'toggleCalendar'>>) => void
  toggleCalendar: (id: string) => void
}

export const defaultSettings = {
  language: 'auto',
  timeFormat: 'auto',
  weekStart: 'auto',
  defaultView: 'month',
  theme: 'system',
  hiddenCalendars: [],
  hideCompletedTasks: false,
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
      toggleCalendar: (id) => {
        set((s) => ({
          hiddenCalendars: s.hiddenCalendars.includes(id)
            ? s.hiddenCalendars.filter((c) => c !== id)
            : [...s.hiddenCalendars, id],
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
