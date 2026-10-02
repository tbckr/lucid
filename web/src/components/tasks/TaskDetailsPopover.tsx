import { AlignLeftIcon, CheckIcon, FlagIcon, ListChecksIcon, LockIcon, RepeatIcon } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { DetailActions, DetailClose, DetailContent, DetailRow, Linked } from '@/components/events/DetailParts'
import { Popover } from '@/components/ui/popover'
import { useCachedTodo, useDeleteTodo, useVisibleCalendars } from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { useNow } from '@/hooks/useNow'
import { usePrefs } from '@/hooks/usePrefs'
import { useToggleTodo } from '@/hooks/useToggleTodo'
import { anchorOf, canComplete, recurringLabel, toCalTask, type CalTask } from '@/lib/calendarTasks'
import { eventTitle } from '@/lib/events'
import { formatEventWhen, formatPickerDate } from '@/lib/format'
import { isOverdue, priorityLevel } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'
import { PencilMark } from './TaskItems'
import { PriorityChip } from './TaskRow'

/** Popover with the details of a task selected in the calendar (read, complete, edit, delete; FR-16). */
export function TaskDetailsPopover() {
  const detail = useUi((s) => s.detail)
  const openDetail = useUi((s) => s.openDetail)
  if (detail?.item.kind !== 'task') return null
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) openDetail(null)
      }}
    >
      <Details key={detail.item.key} task={detail.item} anchor={detail.anchor} />
    </Popover>
  )
}

function Details({ task, anchor }: { task: CalTask; anchor: HTMLElement }) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const now = useNow()
  const { byId } = useVisibleCalendars()
  const colors = useCalendarColors()(task.calendarId)
  const openDetail = useUi((s) => s.openDetail)
  const openTaskEditor = useUi((s) => s.openTaskEditor)
  const del = useDeleteTodo()
  const closeRef = useRef<HTMLButtonElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  // The task as it is now: a reload may have replaced the one that was clicked.
  const todo = useCachedTodo(task.todo)
  // An occurrence keeps the dates it was clicked at; a plain task picks up the cache's, as before (FR-17).
  const placed = task.occurrence ? task : (toCalTask(todo) ?? task)
  const { done: toggledDone, toggle } = useToggleTodo(todo)
  // An occurrence another app completed (FR-17) shows as done regardless of the series' own status.
  const done = task.occurrence?.state === 'done' ? true : toggledDone
  const list = byId.get(todo.calendarId)
  const readOnly = list?.readOnly ?? true
  const title = eventTitle(todo, t('event.untitled'))
  // A point shows its time alone; one date says which one it is (FR-14).
  const when = formatEventWhen(placed.point ? { ...placed, endsAt: placed.startsAt } : placed, prefs, now)
  const whenText = placed.dates === 'span' ? when : t(placed.dates === 'due' ? 'tasks.dueWhen' : 'tasks.startsWhen', { when })
  const upcoming = task.occurrence?.state === 'upcoming'
  // The series carries its current occurrence's dates, the only one that can be completed and so be late (FR-14, FR-17).
  const overdue = !done && !upcoming && isOverdue(todo, now)
  const hasPriority = priorityLevel(todo.priority) !== 'none'
  const hasDetails = hasPriority || todo.checklist.length > 0 || todo.description !== '' || todo.recurring
  // The rule row's hint (FR-17): which occurrence to complete first, that another app already did, or that
  // Lucid can't read the rule at all; the current occurrence, or a plain series, needs none of these.
  const hint = upcoming
    ? t('tasks.upcomingHint', { date: formatPickerDate(anchorOf(todo) ?? placed.startsAt, prefs, now) })
    : task.occurrence?.state === 'done'
      ? t('tasks.doneElsewhere')
      : !task.occurrence && todo.ruleUnsupported
        ? t('tasks.ruleUnsupported')
        : null

  return (
    <DetailContent anchor={anchor} label={title} initialFocus={() => editRef.current ?? closeRef.current}>
      {/* The task as it appears in its list: the list's tint and bar, and the round check that completes it (FR-15). */}
      <div
        className="relative grid grid-cols-[1.25rem_1fr] items-start gap-x-3 border-l-4 pt-4 pr-12 pb-3.5 pl-3"
        style={{ backgroundColor: colors.tint, color: colors.onTint, borderLeftColor: colors.solid }}
      >
        {/* An upcoming occurrence has nothing to check off yet (FR-17): the same pencilled-in stand-in as its item. */}
        {upcoming ? (
          <PencilMark color={colors.solid} className="mt-[3px] size-6 justify-self-center" />
        ) : (
          <button
            type="button"
            role="checkbox"
            aria-checked={done}
            aria-label={t('tasks.complete', { title })}
            disabled={readOnly || !canComplete(placed)}
            onClick={() => {
              // Like Edit and Delete, the check is done with the details: a series has moved on to its
              // next repeat by then, and these would still show the one just completed (FR-17).
              toggle()
              openDetail(null)
            }}
            className="mt-[3px] flex size-6 items-center justify-center justify-self-center rounded-full border-2 transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-current/50 disabled:opacity-50"
            style={{ borderColor: colors.solid, backgroundColor: done ? colors.solid : 'transparent' }}
          >
            {done && <CheckIcon className="size-4" strokeWidth={3.5} style={{ color: colors.onSolid }} aria-hidden />}
          </button>
        )}
        <div className="grid min-w-0 gap-1">
          <h2
            className={cn(
              'font-display text-2xl leading-tight font-semibold tracking-tight [overflow-wrap:anywhere]',
              done && 'line-through decoration-2 opacity-70',
            )}
          >
            {title}
          </h2>
          <p className="tabular flex flex-wrap gap-x-2 font-medium">
            <span>{whenText}</span>
            {overdue && <span className="text-destructive">{t('tasks.overdue')}</span>}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm font-medium">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: colors.solid }} aria-hidden />
            <span className="sr-only">{t('tasks.list')}: </span>
            {list?.name ?? t('event.unknownCalendar')}
            {readOnly && (
              <span className="inline-flex items-center gap-1 font-normal">
                <LockIcon className="size-3.5" aria-hidden />
                {t('calendars.readOnly')}
              </span>
            )}
          </p>
        </div>
        <DetailClose
          ref={closeRef}
          onClose={() => {
            openDetail(null)
          }}
        />
      </div>

      <div className="grid gap-4 p-4 empty:hidden">
        {hasDetails && (
          <div className="grid gap-3 text-sm">
            {todo.recurring && (
              <DetailRow icon={<RepeatIcon />}>
                <p>{recurringLabel(t, todo, placed.startsAt, prefs, now)}</p>
                {hint && <p className="mt-1 text-muted-foreground">{hint}</p>}
              </DetailRow>
            )}
            {hasPriority && (
              <DetailRow icon={<FlagIcon />}>
                <PriorityChip priority={todo.priority} flag={false} />
              </DetailRow>
            )}
            {todo.checklist.length > 0 && (
              <DetailRow icon={<ListChecksIcon />}>
                {/* A list, not controls: items are ticked off in the editor. */}
                <ul className="grid gap-1">
                  {todo.checklist.map((item, i) => (
                    <li key={i} className="grid grid-cols-[0.875rem_1fr] items-start gap-2">
                      {item.done ? (
                        <CheckIcon
                          role="img"
                          aria-label={t('tasks.markCompleted')}
                          className="mt-[3px] size-3.5 text-muted-foreground"
                          strokeWidth={3}
                        />
                      ) : (
                        <span className="mt-2 size-1.5 justify-self-center rounded-full bg-muted-foreground/70" aria-hidden />
                      )}
                      <span className={cn('[overflow-wrap:anywhere]', item.done && 'text-muted-foreground line-through')}>
                        {item.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </DetailRow>
            )}
            {todo.description && (
              <DetailRow icon={<AlignLeftIcon />}>
                <p className="scrollbar-thin max-h-48 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
                  <Linked text={todo.description} />
                </p>
              </DetailRow>
            )}
          </div>
        )}

        {!readOnly && (
          <DetailActions
            editRef={editRef}
            editLabel={t('tasks.edit')}
            deleteLabel={t('tasks.delete')}
            confirm={todo.recurring ? t('tasks.confirmDeleteSeries') : t('tasks.confirmDelete')}
            onEdit={() => {
              openTaskEditor({ mode: 'edit', todo })
            }}
            onDelete={() => {
              del.mutate(todo)
              openDetail(null)
            }}
          />
        )}
      </div>
    </DetailContent>
  )
}
