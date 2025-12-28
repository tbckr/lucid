import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useCalendarStore } from '@stores/calendar-store'
import { apiClient } from '@lib/api-client'

export default function Calendar() {
  const { t } = useTranslation()
  const view = useCalendarStore((state) => state.view)
  const setView = useCalendarStore((state) => state.setView)
  const selectedDate = useCalendarStore((state) => state.selectedDate)
  const setSelectedDate = useCalendarStore((state) => state.setSelectedDate)

  const { data: calendars, isLoading } = useQuery({
    queryKey: ['calendars'],
    queryFn: async () => {
      const res = await apiClient.get('/api/calendars')
      return res.data.calendars
    },
  })

  const { data: events } = useQuery({
    queryKey: ['events', selectedDate],
    queryFn: async () => {
      const res = await apiClient.get(`/api/events?date=${selectedDate.toISOString()}`)
      return res.data.events
    },
    enabled: !!calendars,
  })

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-64 bg-white shadow-sm border-r border-gray-200">
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-2xl font-bold text-gray-900">{t('app_title')}</h1>
        </div>

        <div className="p-4 space-y-2">
          <button
            onClick={() => setView('month')}
            className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              view === 'month'
                ? 'bg-indigo-100 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            {t('calendar.month')}
          </button>
          <button
            onClick={() => setView('week')}
            className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              view === 'week'
                ? 'bg-indigo-100 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            {t('calendar.week')}
          </button>
          <button
            onClick={() => setView('day')}
            className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              view === 'day'
                ? 'bg-indigo-100 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            {t('calendar.day')}
          </button>
          <button
            onClick={() => setView('agenda')}
            className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              view === 'agenda'
                ? 'bg-indigo-100 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            {t('calendar.agenda')}
          </button>
        </div>

        <div className="p-4 border-t border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Calendars</h2>
          {isLoading ? (
            <p className="text-sm text-gray-500">Loading calendars...</p>
          ) : calendars && calendars.length > 0 ? (
            <ul className="space-y-2">
              {calendars.map((cal: any) => (
                <li key={cal.id} className="flex items-center">
                  <input
                    type="checkbox"
                    id={cal.id}
                    defaultChecked
                    className="w-4 h-4 rounded"
                  />
                  <label htmlFor={cal.id} className="ml-2 text-sm text-gray-700">
                    {cal.display_name || cal.name}
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">No calendars available</p>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <div className="p-8">
          <div className="bg-white rounded-lg shadow">
            <div className="p-6">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">
                {view === 'month' && 'Month View'}
                {view === 'week' && 'Week View'}
                {view === 'day' && 'Day View'}
                {view === 'agenda' && 'Agenda View'}
              </h2>
              <p className="text-gray-600">
                {events && events.length > 0
                  ? `${events.length} events`
                  : t('calendar.no_events')}
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
