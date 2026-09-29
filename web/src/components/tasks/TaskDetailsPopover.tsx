import { AlignLeftIcon, CheckIcon, FlagIcon, ListChecksIcon, LockIcon } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { DetailActions, DetailClose, DetailContent, DetailRow, Linked } from '@/components/events/DetailParts'
import { Popover } from '@/components/ui/popover'
import { useCachedTodo, useDeleteTodo, useVisibleCalendars } from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { useNow } from '@/hooks/useNow'
import { usePrefs } from '@/hooks/usePrefs'
import { useToggleTodo } from '@/hooks/useToggleTodo'
import { toCalTask, type CalTask } from '@/lib/calendarTasks'
import { eventTitle } from '@/lib/events'
import { formatEventWhen } from '@/lib/format'
import { isOverdue, priorityLevel } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'
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
  // The task as it is now: the check below or a reload may have replaced the one that was clicked.
  const todo = useCachedTodo(task.todo)
  const placed = toCalTask(todo) ?? task
  const { done, toggle } = useToggleTodo(todo)
  const list = byId.get(todo.calendarId)
  const readOnly = list?.readOnly ?? true
  const title = eventTitle(todo, t('event.untitled'))
  // A point shows its time alone; one date says which one it is (FR-14).
  const when = formatEventWhen(placed.point ? { ...placed, endsAt: placed.startsAt } : placed, prefs, now)
  const whenText = placed.dates === 'span' ? when : t(placed.dates === 'due' ? 'tasks.dueWhen' : 'tasks.startsWhen', { when })
  const overdue = !done && isOverdue(todo, now)
  const hasPriority = priorityLevel(todo.priority) !== 'none'
  const hasDetails = hasPriority || todo.checklist.length > 0 || todo.description !== ''

  return (
    <DetailContent anchor={anchor} label={title} initialFocus={() => editRef.current ?? closeRef.current}>
      {/* The task as it appears in its list: the list's tint and bar, and the round check that completes it (FR-15). */}
      <div
        className="relative grid grid-cols-[1.25rem_1fr] items-start gap-x-3 border-l-4 pt-4 pr-12 pb-3.5 pl-3"
        style={{ backgroundColor: colors.tint, color: colors.onTint, borderLeftColor: colors.solid }}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-label={t('tasks.complete', { title })}
          disabled={readOnly}
          onClick={toggle}
          className="mt-[3px] flex size-6 items-center justify-center justify-self-center rounded-full border-2 transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-current/50 disabled:opacity-50"
          style={{ borderColor: colors.solid, backgroundColor: done ? colors.solid : 'transparent' }}
        >
          {done && <CheckIcon className="size-4" strokeWidth={3.5} style={{ color: colors.onSolid }} aria-hidden />}
        </button>
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
            confirm={t('tasks.confirmDelete')}
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
