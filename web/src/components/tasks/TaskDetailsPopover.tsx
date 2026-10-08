import { AlignLeftIcon, CheckIcon, FlagIcon, ListChecksIcon, LockIcon, RepeatIcon } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { DetailActions, DetailClose, DetailContent, DetailRow, Linked } from '@/components/events/DetailParts'
import { RecurringMark } from '@/components/events/EventItems'
import { Popover } from '@/components/ui/popover'
import {
  useCachedTodo,
  useDeleteTodo,
  useEndTodo,
  useSeriesDetachedFrom,
  useSkipTodo,
  useVisibleCalendars,
} from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { useNow } from '@/hooks/useNow'
import { usePrefs } from '@/hooks/usePrefs'
import { useToggleTodo } from '@/hooks/useToggleTodo'
import { anchorOf, canComplete, recurringLabel, repeatOf, toCalTask, type CalTask } from '@/lib/calendarTasks'
import { eventTitle } from '@/lib/events'
import { formatEventWhen, formatPickerDate } from '@/lib/format'
import { scopeOptions, taskGlyphSlots, taskScopeItems, taskScopeMissing, type Scope, type ScopeResult } from '@/lib/scope'
import { isDetached, isDone, isOverdue, priorityLevel } from '@/lib/tasks'
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
  const closeRef = useRef<HTMLButtonElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  // Holds how to cancel the delete scope question while it is open, for the Escape handler below.
  const cancelScope = useRef<(() => void) | null>(null)
  // The task as it is now: a reload may have replaced the one that was clicked.
  const todo = useCachedTodo(task.todo)
  // The deletes of a task wait for its other writes, and take the ETag they got (FR-17, NFR-26).
  const del = useDeleteTodo(todo.id)
  const skip = useSkipTodo(todo.id)
  const end = useEndTodo(todo.id)
  // The repeat of a series these details show, from the series as it is now: none for a plain task
  // and a done repeat, which no change of the series starts from (FR-17).
  const repeat = useMemo(() => repeatOf({ ...task, todo }), [task, todo])
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
  // A task made of a repeat ("Only this repeat", FR-17) says so, and where the series it left goes on.
  const detached = isDetached(todo)
  const origin = useSeriesDetachedFrom(todo)
  const originAt = origin?.recurring && !isDone(origin) ? anchorOf(origin) : null
  const detachedNotice = detached
    ? originAt
      ? t('tasks.detachedNotice', { next: formatPickerDate(originAt, prefs, now) })
      : t('tasks.detachedNoticeAlone')
    : null
  const hasDetails = hasPriority || todo.checklist.length > 0 || todo.description !== '' || todo.recurring || detached
  // The rule row's hint (FR-17): which occurrence to complete first, that another app already did, or
  // that Lucid can't read the rule at all; the current occurrence, or a plain series, needs none of these.
  const hint = upcoming
    ? t('tasks.upcomingHint', { date: formatPickerDate(anchorOf(todo) ?? placed.startsAt, prefs, now) })
    : task.occurrence?.state === 'done'
      ? t('tasks.doneElsewhere')
      : !task.occurrence && todo.ruleUnsupported
        ? t('tasks.ruleUnsupported')
        : null

  // A repeat of a series asks which repeats to delete (FR-17): "only this repeat" skips the current
  // one, "this and following repeats" ends the series before a later one, "all repeats" deletes it.
  // The last repeat and a plain task ask only whether; "all repeats" alone is said by its confirm.
  const deleteScopes: ScopeResult = repeat ? scopeOptions({ kind: 'task', action: 'delete', item: repeat }) : { options: [] }
  const deleteOptions = deleteScopes.options
  const deleteScoped = (scope: Scope) => {
    if (!repeat) return
    switch (scope) {
      case 'this':
        skip.mutate({ todo, repeat })
        break
      case 'following':
        end.mutate({ todo, repeat })
        break
      case 'all':
        del.mutate({ todo, look: { slots: taskGlyphSlots('all', repeat.at) } })
        break
    }
    openDetail(null)
  }

  return (
    <DetailContent
      anchor={anchor}
      label={title}
      initialFocus={() => editRef.current ?? closeRef.current}
      onEscapeKeyDown={(e) => {
        // While the delete scope question is open, Escape cancels it instead of closing the
        // popover (NFR-27): Radix would otherwise dismiss this popover before the question's own
        // handler ever ran.
        if (cancelScope.current) {
          e.preventDefault()
          cancelScope.current()
        }
      }}
    >
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
            {(todo.recurring || detached) && (
              <DetailRow
                icon={
                  detached ? (
                    <RecurringMark recurring={todo.recurring} detached label={t('tasks.detached')} className="opacity-100" />
                  ) : (
                    <RepeatIcon />
                  )
                }
              >
                {todo.recurring && <p>{recurringLabel(t, todo, placed.startsAt, prefs, now)}</p>}
                {detachedNotice && <p className={cn(todo.recurring && 'mt-1 text-muted-foreground')}>{detachedNotice}</p>}
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
            // A series asks whether to delete all repeats, except at its last repeat, which is a task like any other.
            confirm={todo.recurring && !repeat?.last ? t('tasks.confirmDeleteSeries') : t('tasks.confirmDelete')}
            onEdit={() => {
              openTaskEditor({ mode: 'edit', todo, repeat: repeat ?? undefined })
            }}
            onDelete={() => {
              del.mutate({ todo })
              openDetail(null)
            }}
            deleteScope={
              repeat && deleteOptions.length > 1
                ? {
                    question: t('scope.task.delete'),
                    items: taskScopeItems(t, repeat, deleteOptions, prefs, now, 'delete'),
                    color: colors.solid,
                    missing: taskScopeMissing(t, deleteScopes),
                    onChoose: deleteScoped,
                  }
                : undefined
            }
            onScopeOpenChange={(cancel) => {
              cancelScope.current = cancel
            }}
          />
        )}
      </div>
    </DetailContent>
  )
}
