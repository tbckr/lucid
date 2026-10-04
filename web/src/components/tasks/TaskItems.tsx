import { useDraggable } from '@dnd-kit/core'
import { BanIcon, CheckIcon } from 'lucide-react'
import { useMemo, type CSSProperties, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useDndState } from '@/components/dnd/dndState'
import { RecurringMark } from '@/components/events/EventItems'
import { type EventColors } from '@/hooks/useCalendarColors'
import { useToggleTodo } from '@/hooks/useToggleTodo'
import { canComplete, recurringLabel, type CalTask } from '@/lib/calendarTasks'
import { type DragBinding } from '@/lib/dnd'
import { eventTitle } from '@/lib/events'
import { formatPickerDate, formatShortTime, type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'

/*
 * Tasks in the calendar views (FR-16): a round checkbox to complete them
 * (FR-15) and a title that opens their details and, like an event, moves them
 * by drag & drop (FR-10). Both buttons stop the click and together fill chips
 * and bars, so the cell underneath never creates an event from a click on a task.
 *
 * A recurring series (FR-17) places its upcoming occurrences too, pencilled in
 * ("Tinte und Bleistift"): a dashed outline in the calendar color instead of a
 * fill, `PencilMark` instead of the checkbox, and slate text. Once an
 * occurrence becomes current it inks in: the container's background-color
 * transitions instead of jumping.
 */

const INK_IN = 'transition-[background-color] duration-200 motion-reduce:transition-none'

/*
 * A one-line item with checkbox, time and title (FR-17): in a narrow `@container` the repeat mark
 * goes first, so it never takes the title's last characters; the details and the task list still
 * show the rule. Either width leaves the title about 3.5rem next to the checkbox, the time and the
 * mark: the chip's own, the block's content box inside its padding.
 */
const CHIP_MARK_IF_ROOM = '@max-[9rem]:hidden'
const BLOCK_MARK_IF_ROOM = '@max-[7rem]:hidden'

interface TaskItemProps {
  task: CalTask
  colors: EventColors
  prefs: FormatPrefs
  readOnly: boolean
}

/**
 * The stand-in for the checkbox on the drag overlay over a day outside the move window (FR-17): the task can't
 * land there. Decorative, as the limit is announced and shown beneath the overlay.
 */
export function StopMark({ className }: { className?: string }) {
  return <BanIcon aria-hidden className={cn('size-3.5 shrink-0 text-muted-foreground', className)} />
}

/**
 * The dashed, decorative stand-in for the checkbox on an upcoming occurrence (FR-17). Items place it inside
 * the button that opens the details, so a click on what looks like a disabled checkbox shows why it is one.
 */
export function PencilMark({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('size-3.5 shrink-0 rounded-full border-[1.5px] border-dashed', className)}
      style={{ borderColor: color }}
    />
  )
}

function useTaskItem(task: CalTask, onOpen?: (task: CalTask) => void) {
  const { t } = useTranslation()
  const openDetail = useUi((s) => s.openDetail)
  const { pendingTodos, draggedTodo } = useDndState()
  const { done: toggledDone, toggle } = useToggleTodo(task.todo)
  // Fixed per render, so a re-render mid-day never flips a year suffix under the pointer.
  const now = useMemo(() => new Date(), [])
  const title = eventTitle(task, t('event.untitled'))
  // An occurrence another app completed (FR-17) shows as done regardless of the series' own status.
  const done = task.occurrence?.state === 'done' ? true : toggledDone
  const pending = pendingTodos.has(task.todo.id)
  const open = (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation()
    if (onOpen) onOpen(task)
    else openDetail({ item: task, anchor: e.currentTarget })
  }
  // An entry of the series being dragged (FR-17) stays lit in the days it can't reach.
  const inDrag = task.todo.id === draggedTodo
  return { t, title, done, toggle, open, pending, now, inDrag }
}

/**
 * Drags the task item by its title: Space starts a keyboard drag, Enter still
 * opens the details. Without `drag`, disabled, or while the question which
 * events of a series move is open (FR-10, FR-17), the item stays in place.
 */
function useTaskDrag(task: CalTask, drag: DragBinding | undefined) {
  const { scope } = useDndState()
  const draggable = drag !== undefined && !drag.disabled && scope === null
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: drag?.id ?? task.key,
    data: drag?.data,
    disabled: !draggable,
  })
  // dnd-kit sets role="button"; the title is a real one.
  const handle = { ref: setActivatorNodeRef, ...(draggable ? { ...attributes, ...listeners, role: undefined } : {}) }
  return { ref: setNodeRef, handle, isDragging }
}

/** A point shows its time; a span shows start – end unless `compact`. */
function timeText(task: CalTask, prefs: FormatPrefs, compact = false): string {
  const start = formatShortTime(task.startsAt, prefs)
  return task.point || compact ? start : `${start} – ${formatShortTime(task.endsAt, prefs)}`
}

/**
 * The title button's accessible name (FR-16, FR-17): the planned date for an
 * upcoming occurrence (nothing to open yet but its details), the time
 * otherwise, as for an event.
 */
function titleLabel(
  t: ReturnType<typeof useTranslation>['t'],
  task: CalTask,
  title: string,
  time: string,
  prefs: FormatPrefs,
  now: Date,
): string {
  if (task.occurrence?.state === 'upcoming') {
    return t('tasks.plannedRepeat', { title, date: formatPickerDate(task.startsAt, prefs, now) })
  }
  return task.allDay ? t('event.allDayLabel', { title }) : t('event.chipLabel', { title, time })
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
export function TaskChip({
  task,
  colors,
  prefs,
  readOnly,
  drag,
  blocked = false,
  className,
  onOpen,
}: TaskItemProps & {
  drag?: DragBinding
  /** As the drag overlay shows it over a day outside its move window (FR-17): pencilled in, with `StopMark` for the checkbox. */
  blocked?: boolean
  className?: string
  /** Opens the details elsewhere, e.g. at the "+N more" button whose list closes. */
  onOpen?: (task: CalTask) => void
}) {
  const { t, title, done, toggle, open, pending, now, inDrag } = useTaskItem(task, onOpen)
  const { ref, handle, isDragging } = useTaskDrag(task, drag)
  const upcoming = task.occurrence?.state === 'upcoming'
  // Pencilled in: a planned repeat, or the drag overlay over a day it can't reach (FR-17).
  const pencil = upcoming || blocked
  return (
    <div
      ref={ref}
      data-task-key={task.key}
      data-calendar-id={task.calendarId}
      data-dragged-series={inDrag ? '' : undefined}
      className={cn(
        'flex h-5 w-full min-w-0 items-stretch rounded-sm text-xs leading-none @container hover:bg-muted',
        INK_IN,
        done && 'opacity-60',
        isDragging && 'opacity-40',
        className,
      )}
    >
      {!pencil && (
        <TaskCheck
          title={title}
          done={done}
          readOnly={readOnly || !canComplete(task) || pending}
          onToggle={toggle}
          color={colors.solid}
          mark={colors.onSolid}
          className="px-1.5"
        />
      )}
      <button
        type="button"
        {...handle}
        onClick={open}
        aria-busy={pending || undefined}
        aria-label={titleLabel(t, task, title, timeText(task, prefs), prefs, now)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 rounded-sm pr-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
          pencil && 'pl-1.5',
        )}
      >
        {blocked ? <StopMark /> : upcoming && <PencilMark color={colors.solid} />}
        {!task.allDay && (
          <span className="tabular shrink-0 text-muted-foreground max-sm:hidden">{formatShortTime(task.startsAt, prefs)}</span>
        )}
        <span className={cn('truncate font-medium', pencil && 'text-muted-foreground', done && 'line-through')}>{title}</span>
        <RecurringMark
          recurring={task.todo.recurring}
          label={recurringLabel(t, task.todo, task.startsAt, prefs, now)}
          className={CHIP_MARK_IF_ROOM}
        />
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
  drag,
  blocked = false,
  continuesBefore = false,
  continuesAfter = false,
  className,
  style,
}: TaskItemProps & {
  drag?: DragBinding
  /** As the drag overlay shows it over a day outside its move window (FR-17): pencilled in, with `StopMark` for the checkbox. */
  blocked?: boolean
  continuesBefore?: boolean
  continuesAfter?: boolean
  className?: string
  style?: CSSProperties
}) {
  const { t, title, done, toggle, open, pending, now, inDrag } = useTaskItem(task)
  const { ref, handle, isDragging } = useTaskDrag(task, drag)
  const upcoming = task.occurrence?.state === 'upcoming'
  // Pencilled in: a planned repeat, or the drag overlay over a day it can't reach (FR-17).
  const pencil = upcoming || blocked
  return (
    <div
      ref={ref}
      data-task-key={task.key}
      data-calendar-id={task.calendarId}
      data-dragged-series={inDrag ? '' : undefined}
      className={cn(
        'flex h-5 min-w-0 items-stretch text-xs leading-none font-medium',
        INK_IN,
        continuesBefore ? 'rounded-l-none' : 'rounded-l-sm',
        continuesAfter ? 'rounded-r-none' : 'rounded-r-sm',
        done && 'opacity-60',
        isDragging && 'opacity-40',
        pencil && 'border-[1.5px] border-dashed bg-transparent text-muted-foreground',
        className,
      )}
      style={pencil ? { borderColor: colors.solid, ...style } : { backgroundColor: colors.solid, color: colors.onSolid, ...style }}
    >
      {!pencil && (
        <TaskCheck
          title={title}
          done={done}
          readOnly={readOnly || !canComplete(task) || pending}
          onToggle={toggle}
          color={colors.onSolid}
          mark={colors.solid}
          className="pr-1 pl-1.5"
        />
      )}
      <button
        type="button"
        {...handle}
        onClick={open}
        aria-busy={pending || undefined}
        aria-label={titleLabel(t, task, title, timeText(task, prefs), prefs, now)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1 rounded-sm pr-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
          pencil && 'pl-1.5',
        )}
      >
        {blocked ? <StopMark /> : upcoming && <PencilMark color={colors.solid} />}
        {!task.allDay && !continuesBefore && (
          <span className="tabular shrink-0 opacity-85">{formatShortTime(task.startsAt, prefs)}</span>
        )}
        <span className={cn('truncate', done && 'line-through')}>{title}</span>
        <RecurringMark recurring={task.todo.recurring} label={recurringLabel(t, task.todo, task.startsAt, prefs, now)} />
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
  drag,
  blocked = false,
  size,
  style,
}: TaskItemProps & {
  drag?: DragBinding
  /** As the drag overlay shows it over a day outside its move window (FR-17): pencilled in, with `StopMark` for the checkbox. */
  blocked?: boolean
  /** Available height decides how much text fits. */
  size: 'xs' | 'sm' | 'md'
  style?: CSSProperties
}) {
  const compact = size === 'xs'
  const { t, title, done, toggle, open, pending, now, inDrag } = useTaskItem(task)
  const { ref, handle, isDragging } = useTaskDrag(task, drag)
  const upcoming = task.occurrence?.state === 'upcoming'
  // Pencilled in: a planned repeat, or the drag overlay over a day it can't reach (FR-17).
  const pencil = upcoming || blocked
  const markClassName = cn('absolute left-2.5 z-10', compact ? 'top-1/2 -translate-y-1/2' : 'top-[5px]')
  return (
    <div
      ref={ref}
      data-task-key={task.key}
      data-calendar-id={task.calendarId}
      data-dragged-series={inDrag ? '' : undefined}
      className={cn('absolute px-px', done && 'opacity-60', isDragging && 'opacity-40')}
      style={{ ...style, color: pencil ? undefined : colors.onTint }}
    >
      {/* The whole block opens the task; the checkbox sits on top of it, left of the text, the pencil mark inside it. */}
      {!pencil && (
        <TaskCheck
          title={title}
          done={done}
          readOnly={readOnly || !canComplete(task) || pending}
          onToggle={toggle}
          color={colors.solid}
          mark={colors.onSolid}
          className={markClassName}
        />
      )}
      <button
        type="button"
        {...handle}
        onClick={open}
        aria-busy={pending || undefined}
        aria-label={titleLabel(t, task, title, timeText(task, prefs), prefs, now)}
        className={cn(
          'flex size-full min-h-0 overflow-hidden rounded-md pr-1.5 pl-[1.625rem] text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
          INK_IN,
          pencil ? 'border-[1.5px] border-dashed bg-transparent text-muted-foreground' : 'border-l-[3px]',
          compact ? 'flex-row items-center gap-1 py-0 @container' : 'flex-col py-1',
        )}
        style={pencil ? { borderColor: colors.solid } : { backgroundColor: colors.tint, borderLeftColor: colors.solid }}
      >
        {blocked ? <StopMark className={markClassName} /> : upcoming && <PencilMark color={colors.solid} className={markClassName} />}
        <span className="flex min-w-0 items-center gap-1 font-semibold">
          <span className={cn('truncate', done && 'line-through')}>{title}</span>
          <RecurringMark
            recurring={task.todo.recurring}
            label={recurringLabel(t, task.todo, task.startsAt, prefs, now)}
            className={compact ? BLOCK_MARK_IF_ROOM : undefined}
          />
        </span>
        <span className={cn('tabular truncate opacity-90', compact && 'shrink-0')}>{timeText(task, prefs, compact)}</span>
      </button>
    </div>
  )
}

/**
 * Task row in the agenda: time, checkbox, title. The button spans the row with
 * the same columns as event rows; the checkbox sits on top of the middle one,
 * the pencil mark inside it, at the same spot.
 */
export function TaskAgendaRow({ task, time, colors, prefs, readOnly }: TaskItemProps & { time: string }) {
  const { t, title, done, toggle, open, pending, now } = useTaskItem(task)
  const upcoming = task.occurrence?.state === 'upcoming'
  // Centre of the middle column: padding + first column + gap + half the column.
  const markClassName = 'absolute top-1/2 left-[10.125rem] z-10 -translate-x-1/2 -translate-y-1/2 max-sm:left-[7.625rem]'
  return (
    <div data-task-key={task.key} data-calendar-id={task.calendarId} className={cn('relative', INK_IN, done && 'opacity-60')}>
      {!upcoming && (
        <TaskCheck
          title={title}
          done={done}
          readOnly={readOnly || !canComplete(task) || pending}
          onToggle={toggle}
          color={colors.solid}
          mark={colors.onSolid}
          className={markClassName}
        />
      )}
      <button
        type="button"
        onClick={open}
        aria-busy={pending || undefined}
        aria-label={titleLabel(t, task, title, time, prefs, now)}
        className="grid w-full grid-cols-[8.5rem_0.75rem_1fr] items-center gap-3 rounded-md px-2 py-2.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring max-sm:grid-cols-[6rem_0.75rem_1fr]"
      >
        {upcoming && <PencilMark color={colors.solid} className={markClassName} />}
        <span className="tabular truncate text-muted-foreground">{time}</span>
        <span />
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn('truncate font-medium', upcoming && 'text-muted-foreground', done && 'line-through')}>{title}</span>
          <RecurringMark recurring={task.todo.recurring} label={recurringLabel(t, task.todo, task.startsAt, prefs, now)} />
        </span>
      </button>
    </div>
  )
}
