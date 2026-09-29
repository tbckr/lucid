import { CheckIcon, FlagIcon, ListChecksIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNow } from '@/hooks/useNow'
import { usePrefs } from '@/hooks/usePrefs'
import { useToggleTodo } from '@/hooks/useToggleTodo'
import { type Calendar, type Todo } from '@/lib/api/schemas'
import { checklistProgress, formatDue, priorityLevel } from '@/lib/tasks'
import { readableTextColor } from '@/lib/color'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'

/** The priority level in its color; without `flag` where an icon column already shows one. */
export function PriorityChip({ priority, flag = true }: { priority: number; flag?: boolean }) {
  const { t } = useTranslation()
  const level = priorityLevel(priority)
  if (level === 'none') return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-medium',
        level === 'high' && 'text-destructive',
        level === 'medium' && 'text-amber-800 dark:text-amber-300',
        level === 'low' && 'text-sky-800 dark:text-sky-300',
      )}
    >
      {flag && <FlagIcon className="size-3" aria-hidden />}
      {t(`priority.${level}`)}
    </span>
  )
}

/** A task in the sidebar; `timeOnly` where the group heading already names the day (FR-14). */
export function TaskRow({ todo, calendar, timeOnly = false }: { todo: Todo; calendar: Calendar; timeOnly?: boolean }) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const now = useNow()
  const openTaskEditor = useUi((s) => s.openTaskEditor)
  const { done, toggle } = useToggleTodo(todo)
  const labels = { today: t('tasks.today'), tomorrow: t('tasks.tomorrow'), yesterday: t('tasks.yesterday') }
  const due = formatDue(todo, now, prefs, labels, { timeOnly })
  const progress = checklistProgress(todo.checklist)
  const hasMeta = due !== null || progress.total > 0 || (!done && todo.priority > 0)

  return (
    <div className="group flex items-start gap-3 px-4 py-1" data-testid="task-row" data-task-id={todo.id}>
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={t('tasks.complete', { title: todo.title })}
        disabled={calendar.readOnly}
        onClick={toggle}
        className="mt-1.5 flex size-[1.125rem] shrink-0 items-center justify-center rounded-full border-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
        style={{ borderColor: calendar.color, backgroundColor: done ? calendar.color : 'transparent' }}
      >
        {done && <CheckIcon className="size-3" strokeWidth={3.5} style={{ color: readableTextColor(calendar.color) }} aria-hidden />}
      </button>
      <button
        type="button"
        onClick={() => {
          openTaskEditor({ mode: 'edit', todo })
        }}
        className="-mx-1.5 min-w-0 flex-1 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn('block text-sm [overflow-wrap:anywhere]', done && 'text-muted-foreground line-through')}>
          {todo.title || t('event.untitled')}
        </span>
        {hasMeta && (
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {due && <span className="tabular">{due}</span>}
            {!done && <PriorityChip priority={todo.priority} />}
            {progress.total > 0 && (
              <span className="tabular inline-flex items-center gap-1" aria-label={t('tasks.progress', progress)}>
                <ListChecksIcon className="size-3" aria-hidden />
                {progress.done}/{progress.total}
              </span>
            )}
          </span>
        )}
      </button>
    </div>
  )
}
