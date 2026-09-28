import { CheckIcon } from 'lucide-react'
import { type CSSProperties, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { type EventColors } from '@/hooks/useCalendarColors'
import { useToggleTodo } from '@/hooks/useToggleTodo'
import { type CalTask } from '@/lib/calendarTasks'
import { eventTitle } from '@/lib/events'
import { formatShortTime, type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'

/*
 * Tasks in the calendar views (FR-16): a round checkbox to complete them
 * (FR-15) and a title that opens the task editor. Unlike events they are not
 * draggable. Both buttons stop the click and together fill chips and bars, so
 * the cell underneath never creates an event from a click on a task.
 */

interface TaskItemProps {
  task: CalTask
  colors: EventColors
  prefs: FormatPrefs
  readOnly: boolean
}

function useTaskItem(task: CalTask) {
  const { t } = useTranslation()
  const openTaskEditor = useUi((s) => s.openTaskEditor)
  const { done, toggle } = useToggleTodo(task.todo)
  const title = eventTitle(task, t('event.untitled'))
  const open = (e: MouseEvent) => {
    e.stopPropagation()
    openTaskEditor(task.todo)
  }
  return { t, title, done, toggle, open }
}

/** A point shows its time; a span shows start – end unless `compact`. */
function timeText(task: CalTask, prefs: FormatPrefs, compact = false): string {
  const start = formatShortTime(task.startsAt, prefs)
  return task.point || compact ? start : `${start} – ${formatShortTime(task.endsAt, prefs)}`
}

function titleLabel(t: ReturnType<typeof useTranslation>['t'], task: CalTask, title: string, prefs: FormatPrefs) {
  return task.allDay ? t('event.allDayLabel', { title }) : t('event.chipLabel', { title, time: timeText(task, prefs) })
}

function TaskCheck({
  title,
  done,
  readOnly,
  onToggle,
  color,
  mark,
  className,
}: {
  title: string
  done: boolean
  readOnly: boolean
  onToggle: () => void
  /** Border and fill. */
  color: string
  /** Check mark on the fill. */
  mark: string
  /** Size and padding of the hit area around the circle. */
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={t('tasks.complete', { title })}
      disabled={readOnly}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
    >
      <span
        className="flex size-3.5 items-center justify-center rounded-full border-[1.5px]"
        style={{ borderColor: color, backgroundColor: done ? color : 'transparent' }}
        aria-hidden
      >
        {done && <CheckIcon className="size-2.5" strokeWidth={4} style={{ color: mark }} />}
      </span>
    </button>
  )
}

/** Task in a month cell or the "+N more" list: checkbox, time, title. */
export function TaskChip({ task, colors, prefs, readOnly, className }: TaskItemProps & { className?: string }) {
  const { t, title, done, toggle, open } = useTaskItem(task)
  return (
    <div
      data-task-key={task.key}
      data-calendar-id={task.calendarId}
      className={cn(
        'flex h-5 w-full min-w-0 items-stretch rounded-sm text-xs leading-none hover:bg-muted',
        done && 'opacity-60',
        className,
      )}
    >
      <TaskCheck
        title={title}
        done={done}
        readOnly={readOnly}
        onToggle={toggle}
        color={colors.solid}
        mark={colors.onSolid}
        className="px-1.5"
      />
      <button
        type="button"
        onClick={open}
        aria-label={titleLabel(t, task, title, prefs)}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm pr-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {!task.allDay && (
          <span className="tabular shrink-0 text-muted-foreground max-sm:hidden">{formatShortTime(task.startsAt, prefs)}</span>
        )}
        <span className={cn('truncate font-medium', done && 'line-through')}>{title}</span>
      </button>
    </div>
  )
}

/** All-day or multi-day task bar. */
export function TaskBar({
  task,
  colors,
  prefs,
  readOnly,
  continuesBefore = false,
  continuesAfter = false,
  className,
  style,
}: TaskItemProps & { continuesBefore?: boolean; continuesAfter?: boolean; className?: string; style?: CSSProperties }) {
  const { t, title, done, toggle, open } = useTaskItem(task)
  return (
    <div
      data-task-key={task.key}
      data-calendar-id={task.calendarId}
      className={cn(
        'flex h-5 min-w-0 items-stretch text-xs leading-none font-medium',
        continuesBefore ? 'rounded-l-none' : 'rounded-l-sm',
        continuesAfter ? 'rounded-r-none' : 'rounded-r-sm',
        done && 'opacity-60',
        className,
      )}
      style={{ backgroundColor: colors.solid, color: colors.onSolid, ...style }}
    >
      <TaskCheck
        title={title}
        done={done}
        readOnly={readOnly}
        onToggle={toggle}
        color={colors.onSolid}
        mark={colors.solid}
        className="pr-1 pl-1.5"
      />
      <button
        type="button"
        onClick={open}
        aria-label={titleLabel(t, task, title, prefs)}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-sm pr-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
      >
        {!task.allDay && !continuesBefore && (
          <span className="tabular shrink-0 opacity-85">{formatShortTime(task.startsAt, prefs)}</span>
        )}
        <span className={cn('truncate', done && 'line-through')}>{title}</span>
      </button>
    </div>
  )
}

/** Timed task in the week/day grid. */
export function TaskBlock({
  task,
  colors,
  prefs,
  readOnly,
  size,
  style,
}: TaskItemProps & {
  /** Available height decides how much text fits. */
  size: 'xs' | 'sm' | 'md'
  style?: CSSProperties
}) {
  const compact = size === 'xs'
  const { t, title, done, toggle, open } = useTaskItem(task)
  return (
    <div
      data-task-key={task.key}
      data-calendar-id={task.calendarId}
      className={cn('absolute px-px', done && 'opacity-60')}
      style={{ ...style, color: colors.onTint }}
    >
      {/* The whole block opens the task; the checkbox sits on top of it, left of the text. */}
      <TaskCheck
        title={title}
        done={done}
        readOnly={readOnly}
        onToggle={toggle}
        color={colors.solid}
        mark={colors.onSolid}
        className={cn('absolute left-2.5 z-10', compact ? 'top-1/2 -translate-y-1/2' : 'top-[5px]')}
      />
      <button
        type="button"
        onClick={open}
        aria-label={titleLabel(t, task, title, prefs)}
        className={cn(
          'flex size-full min-h-0 overflow-hidden rounded-md border-l-[3px] pr-1.5 pl-[1.625rem] text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
          compact ? 'flex-row items-center gap-1 py-0' : 'flex-col py-1',
        )}
        style={{ backgroundColor: colors.tint, borderLeftColor: colors.solid }}
      >
        <span className={cn('truncate font-semibold', done && 'line-through')}>{title}</span>
        <span className={cn('tabular truncate opacity-90', compact && 'shrink-0')}>{timeText(task, prefs, compact)}</span>
      </button>
    </div>
  )
}

/**
 * Task row in the agenda: time, checkbox, title. The button spans the row with
 * the same columns as event rows; the checkbox sits on top of the middle one.
 */
export function TaskAgendaRow({ task, time, colors, readOnly }: Omit<TaskItemProps, 'prefs'> & { time: string }) {
  const { t, title, done, toggle, open } = useTaskItem(task)
  return (
    <div data-task-key={task.key} data-calendar-id={task.calendarId} className={cn('relative', done && 'opacity-60')}>
      <TaskCheck
        title={title}
        done={done}
        readOnly={readOnly}
        onToggle={toggle}
        color={colors.solid}
        mark={colors.onSolid}
        // Centre of the middle column: padding + first column + gap + half the column.
        className="absolute top-1/2 left-[10.125rem] z-10 -translate-x-1/2 -translate-y-1/2 max-sm:left-[7.625rem]"
      />
      <button
        type="button"
        onClick={open}
        aria-label={task.allDay ? t('event.allDayLabel', { title }) : t('event.chipLabel', { title, time })}
        className="grid w-full grid-cols-[8.5rem_0.75rem_1fr] items-center gap-3 rounded-md px-2 py-2.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring max-sm:grid-cols-[6rem_0.75rem_1fr]"
      >
        <span className="tabular truncate text-muted-foreground">{time}</span>
        <span />
        <span className={cn('truncate font-medium', done && 'line-through')}>{title}</span>
      </button>
    </div>
  )
}
