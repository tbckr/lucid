import { create } from 'zustand'

interface CalendarStore {
  view: 'month' | 'week' | 'day' | 'agenda'
  selectedDate: Date
  selectedCalendars: Set<string>
  setView: (view: 'month' | 'week' | 'day' | 'agenda') => void
  setSelectedDate: (date: Date) => void
  toggleCalendarSelection: (calendarID: string) => void
}

export const useCalendarStore = create<CalendarStore>((set) => ({
  view: 'month',
  selectedDate: new Date(),
  selectedCalendars: new Set(),
  setView: (view) => set({ view }),
  setSelectedDate: (date) => set({ selectedDate: date }),
  toggleCalendarSelection: (calendarID) =>
    set((state) => {
      const newSelection = new Set(state.selectedCalendars)
      if (newSelection.has(calendarID)) {
        newSelection.delete(calendarID)
      } else {
        newSelection.add(calendarID)
      }
      return { selectedCalendars: newSelection }
    }),
}))
