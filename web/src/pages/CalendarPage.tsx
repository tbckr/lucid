import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CalendarDnd } from '@/components/dnd/CalendarDnd'
import { LimitPill } from '@/components/dnd/LimitPill'
import { CreatePopover } from '@/components/create/CreatePopover'
import { EditorDialog } from '@/components/EditorDialog'
import { EventDetailsPopover } from '@/components/events/EventDetailsPopover'
import { EventBar, EventChip, TimedBlock } from '@/components/events/EventItems'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { ShortcutsDialog } from '@/components/settings/ShortcutsDialog'
import { TaskDetailsPopover } from '@/components/tasks/TaskDetailsPopover'
import { TaskBar, TaskBlock, TaskChip } from '@/components/tasks/TaskItems'
import { TasksPanel } from '@/components/tasks/TasksPanel'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { AgendaView } from '@/components/views/AgendaView'
import { MonthView } from '@/components/views/MonthView'
import { TimeGridView } from '@/components/views/TimeGridView'
import { newDraft } from '@/components/views/createDefaults'
import { queryKeys, useCalendarTasks, useEvents, useSession, useVisibleCalendars } from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { useMediaQuery, WIDE_QUERY } from '@/hooks/useMediaQuery'
import { useNow } from '@/hooks/useNow'
import { usePrefs } from '@/hooks/usePrefs'
import { useShortcuts } from '@/hooks/useShortcuts'
import { endpoints } from '@/lib/api/endpoints'
import { eachDay, stepDate, visibleRange } from '@/lib/dates'
import { overlapsRange, type CalItem } from '@/lib/events'
import { formatPeriodTitle } from '@/lib/format'
import { navigate } from '@/lib/router'
import { type ShortcutAction } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'

export function CalendarPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const prefs = usePrefs()
  const now = useNow()
  const wide = useMediaQuery(WIDE_QUERY)
  const { data: session } = useSession()
  const view = useUi((s) => s.view)
  const date = useUi((s) => s.date)
  const sidebarOpen = useUi((s) => s.sidebarOpen)
  const setSidebarOpen = useUi((s) => s.setSidebarOpen)
  const setView = useUi((s) => s.setView)
  const setDate = useUi((s) => s.setDate)
  const setSettingsOpen = useUi((s) => s.setSettingsOpen)
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen)
  const tasksOpen = useSettings((s) => s.tasksOpen)
  const updateSettings = useSettings((s) => s.update)
  const [mobileTasks, setMobileTasks] = useState(false)

  const range = useMemo(() => visibleRange(view, date, prefs.weekStartsOn), [view, date, prefs.weekStartsOn])
  const { events: allEvents, corrupted: corruptedEvents, isFetching, errors } = useEvents(range)
  const events = useMemo(() => allEvents.filter((e) => overlapsRange(e, range)), [allEvents, range])
  const { tasks, corrupted: corruptedRepeats, errors: repeatErrors } = useCalendarTasks(range)
  const items = useMemo<CalItem[]>(() => [...events, ...tasks], [events, tasks])
  const corrupted = useMemo(() => [...corruptedEvents, ...corruptedRepeats], [corruptedEvents, corruptedRepeats])
  const colorsOf = useCalendarColors()
  const { byId } = useVisibleCalendars()
  const calendarOf = useCallback((id: string) => byId.get(id), [byId])
  const title = formatPeriodTitle(view, date, range, prefs)

  // Keep the sidebar inline on wide screens and as a drawer on small ones.
  useEffect(() => {
    setSidebarOpen(wide)
  }, [wide, setSidebarOpen])

  useEffect(() => {
    document.title = `${title} – Lucid`
  }, [title])

  const firstError = errors[0]
  useEffect(() => {
    if (firstError) toast.error(t('errors.eventsLoadFailed'), { id: 'events-load' })
  }, [firstError, t])

  const firstRepeatError = repeatErrors[0]
  useEffect(() => {
    if (firstRepeatError) toast.error(t('errors.repeatsLoadFailed'), { id: 'repeats-load' })
  }, [firstRepeatError, t])

  const toggleTasks = useCallback(() => {
    if (wide) updateSettings({ tasksOpen: !useSettings.getState().tasksOpen })
    else setMobileTasks((v) => !v)
  }, [wide, updateSettings])

  const onShortcut = useCallback(
    (a: ShortcutAction) => {
      const s = useUi.getState()
      switch (a.type) {
        case 'today':
          s.setDate(new Date())
          break
        case 'step':
          s.setDate(stepDate(s.view, s.date, a.dir))
          break
        case 'view':
          s.setView(a.view)
          break
        case 'create':
          s.openEditor({ mode: 'create', draft: newDraft(s.date, new Date()) })
          break
        case 'help':
          s.setShortcutsOpen(true)
          break
        case 'toggleTasks':
          toggleTasks()
          break
      }
    },
    [toggleTasks],
  )
  useShortcuts(onShortcut)

  const logout = async () => {
    try {
      await endpoints.logout()
    } catch {
      // The session is gone either way; continue to the login page.
    }
    qc.clear()
    try {
      qc.setQueryData(queryKeys.session, await endpoints.getSession())
    } catch {
      void qc.invalidateQueries({ queryKey: queryKeys.session })
    }
    navigate('/login', { replace: true })
  }

  const sidebar = (
    <Sidebar
      date={date}
      now={now}
      range={view === 'week' || view === 'day' ? range : null}
      prefs={prefs}
      onNavigate={() => {
        if (!wide) setSidebarOpen(false)
      }}
    />
  )

  const renderView = () => {
    switch (view) {
      case 'month':
        return (
          <MonthView
            date={date}
            now={now}
            events={items}
            corrupted={corrupted}
            prefs={prefs}
            colorsOf={colorsOf}
            calendarOf={calendarOf}
          />
        )
      case 'week':
      case 'day':
        return (
          <TimeGridView
            days={eachDay(range)}
            now={now}
            events={items}
            corrupted={corrupted}
            prefs={prefs}
            colorsOf={colorsOf}
            calendarOf={calendarOf}
          />
        )
      case 'agenda':
        return (
          <AgendaView
            range={range}
            now={now}
            events={items}
            corrupted={corrupted}
            prefs={prefs}
            colorsOf={colorsOf}
            calendarOf={calendarOf}
          />
        )
    }
  }

  return (
    <div className="flex h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {t('nav.skipToCalendar')}
      </a>
      <TopBar
        title={title}
        view={view}
        fetching={isFetching}
        username={session?.username}
        serverUrl={session?.serverUrl}
        tasksOpen={wide ? tasksOpen : mobileTasks}
        onMenu={() => {
          setSidebarOpen(!sidebarOpen)
        }}
        onToday={() => {
          setDate(new Date())
        }}
        onStep={(dir) => {
          setDate(stepDate(view, date, dir))
        }}
        onView={setView}
        onToggleTasks={toggleTasks}
        onSettings={() => {
          setSettingsOpen(true)
        }}
        onShortcuts={() => {
          setShortcutsOpen(true)
        }}
        onLogout={() => void logout()}
      />

      <div className="flex min-h-0 flex-1">
        {wide && sidebarOpen && <aside aria-label={t('sidebar.label')} className="w-64 shrink-0">{sidebar}</aside>}
        {!wide && (
          <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <SheetContent side="left" aria-describedby={undefined}>
              <SheetTitle className="sr-only">{t('sidebar.label')}</SheetTitle>
              {sidebar}
            </SheetContent>
          </Sheet>
        )}

        <main
          id="main"
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto border-border bg-surface lg:mr-2 lg:mb-2 lg:rounded-xl lg:border"
        >
          <CalendarDnd
            renderOverlay={(d, limit) => {
              const e = d.event
              const colors = colorsOf(e.calendarId)
              const bar = e.allDay || e.endsAt.getTime() - e.startsAt.getTime() >= 86_400_000
              if (e.kind === 'task') {
                // Over a day it can't reach (FR-17): pencilled in on paper, with the limit beneath.
                const blocked = limit !== null
                const item = { task: e, colors, prefs, readOnly: false, blocked }
                const pill = limit && <LimitPill className="absolute top-full left-0 mt-1">{limit}</LimitPill>
                if (d.type === 'timed') {
                  return (
                    <div className={cn('relative size-full shadow-float', blocked && 'rounded-md bg-surface')}>
                      <TaskBlock {...item} size="md" style={{ inset: 0 }} />
                      {pill}
                    </div>
                  )
                }
                return (
                  <div className="relative">
                    {bar ? (
                      <TaskBar {...item} className={cn('w-full shadow-float', blocked && 'bg-surface')} />
                    ) : (
                      <TaskChip {...item} className="bg-surface shadow-float" />
                    )}
                    {pill}
                  </div>
                )
              }
              const drag = { id: 'overlay', data: d, disabled: true }
              if (d.type === 'timed') {
                return (
                  <div className="relative size-full shadow-float">
                    <TimedBlock event={e} colors={colors} prefs={prefs} drag={drag} size="md" style={{ inset: 0 }} />
                  </div>
                )
              }
              if (bar) return <EventBar event={e} colors={colors} prefs={prefs} drag={drag} className="w-full shadow-float" />
              return <EventChip event={e} colors={colors} prefs={prefs} drag={drag} className="bg-surface shadow-float" />
            }}
          >
            {renderView()}
          </CalendarDnd>
        </main>

        {wide && tasksOpen && (
          <div className="w-80 shrink-0">
            <TasksPanel
              onClose={() => {
                updateSettings({ tasksOpen: false })
              }}
            />
          </div>
        )}
        {!wide && (
          <Sheet open={mobileTasks} onOpenChange={setMobileTasks}>
            <SheetContent side="right" aria-describedby={undefined}>
              <SheetTitle className="sr-only">{t('tasks.title')}</SheetTitle>
              <SheetDescription className="sr-only">{t('tasks.title')}</SheetDescription>
              <TasksPanel
                onClose={() => {
                  setMobileTasks(false)
                }}
              />
            </SheetContent>
          </Sheet>
        )}
      </div>

      <EventDetailsPopover />
      <TaskDetailsPopover />
      <CreatePopover />
      <EditorDialog />
      <SettingsDialog />
      <ShortcutsDialog />
    </div>
  )
}
