import { CheckIcon, FlagIcon, ListChecksIcon, PencilIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useUpdateTodo } from '@/hooks/queries'
import { useNow } from '@/hooks/useNow'
import { usePrefs } from '@/hooks/usePrefs'
import { useToggleTodo } from '@/hooks/useToggleTodo'
import { type Calendar, type Todo } from '@/lib/api/schemas'
import { checklistProgress, formatDue, priorityLevel, todoToInput } from '@/lib/tasks'
import { readableTextColor } from '@/lib/color'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'
import { DuePicker } from './DuePicker'

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

// Row actions show on hover or focus, and always where there is no hover to find them.
const ACTION =
  'size-7 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100'

/**
 * A task in the sidebar; `timeOnly` where the group heading already names the
 * day (FR-14). A click on the title edits it in place, the actions beside it
 * change the due date or open the editor; a read-only task opens the editor.
 */
export function TaskRow({ todo, calendar, timeOnly = false }: { todo: Todo; calendar: Calendar; timeOnly?: boolean }) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const now = useNow()
  const openTaskEditor = useUi((s) => s.openTaskEditor)
  const { done, toggle } = useToggleTodo(todo)
  const update = useUpdateTodo(todo.id)
  const title = todo.title || t('event.untitled')
  const labels = { today: t('tasks.today'), tomorrow: t('tasks.tomorrow'), yesterday: t('tasks.yesterday') }
  const due = formatDue(todo, now, prefs, labels, { timeOnly })
  const progress = checklistProgress(todo.checklist)
  const hasMeta = due !== null || progress.total > 0 || (!done && todo.priority > 0)
  const edit = () => {
    openTaskEditor({ mode: 'edit', todo })
  }

  const meta = hasMeta && (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {due && <span className="tabular">{due}</span>}
      {!done && <PriorityChip priority={todo.priority} />}
      {progress.total > 0 && (
        <span className="tabular inline-flex items-center gap-1" aria-label={t('tasks.progress', progress)}>
          <ListChecksIcon className="size-3" aria-hidden />
          {progress.done}/{progress.total}
        </span>
      )}
    </span>
  )

  return (
    <div
      className="group grid grid-cols-[1.125rem_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-1"
      data-testid="task-row"
      data-task-id={todo.id}
    >
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
      {calendar.readOnly ? (
        <button
          type="button"
          onClick={edit}
          className="col-span-2 -mx-1.5 min-w-0 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className={cn('block text-sm [overflow-wrap:anywhere]', done && 'text-muted-foreground line-through')}>
            {title}
          </span>
          {meta && <span className="mt-0.5 block">{meta}</span>}
        </button>
      ) : (
        <>
          <TitleField
            todo={todo}
            done={done}
            onSave={(text) => {
              update.mutate({ todo, input: todoToInput(todo, { title: text }) })
            }}
          />
          <div className="flex">
            <DuePicker
              todo={todo}
              onChange={(input) => {
                update.mutate({ todo, input })
              }}
              className={ACTION}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('tasks.editNamed', { title })}
              className={ACTION}
              onClick={edit}
            >
              <PencilIcon aria-hidden />
            </Button>
          </div>
          {meta && <div className="col-span-2 col-start-2 mt-0.5 pb-1">{meta}</div>}
        </>
      )}
    </div>
  )
}

// The field and its hidden copy share every measure: the copy sizes the field, so a long title wraps instead of scrolling.
const TITLE_BOX =
  'col-start-1 row-start-1 rounded-md border px-[5px] py-[3px] text-sm whitespace-pre-wrap [overflow-wrap:anywhere]'

/**
 * The title as a field that reads as text until hovered or focused, like the
 * row that adds a task (FR-12). Enter or leaving it saves; Escape and an empty
 * title bring back the saved one. Line breaks become spaces.
 */
function TitleField({ todo, done, onSave }: { todo: Todo; done: boolean; onSave: (title: string) => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(todo.title)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(todo.title)
  // Follow the task while nothing is typed: a reload or the editor may have renamed it.
  if (todo.title !== saved) {
    setSaved(todo.title)
    if (!dirty) setDraft(todo.title)
  }

  const revert = () => {
    setDraft(todo.title)
    setDirty(false)
  }
  const commit = () => {
    const text = draft.trim()
    if (!text) {
      revert()
      return
    }
    setDraft(text)
    setDirty(false)
    if (text !== todo.title) onSave(text)
  }

  return (
    <div className="-mx-1.5 grid min-w-0">
      <span aria-hidden className={cn(TITLE_BOX, 'invisible border-transparent')}>
        {draft}{' '}
      </span>
      <textarea
        rows={1}
        value={draft}
        maxLength={1024}
        aria-label={t('tasks.titleLabel')}
        onChange={(e) => {
          setDraft(e.target.value.replace(/\s*\r?\n\s*/g, ' '))
          setDirty(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            revert()
          }
        }}
        onBlur={commit}
        className={cn(
          TITLE_BOX,
          'resize-none overflow-hidden border-transparent bg-transparent outline-none hover:border-input focus:border-ring focus:bg-surface focus:ring-[3px] focus:ring-ring/40',
          done && 'text-muted-foreground line-through focus:text-foreground focus:no-underline',
        )}
      />
    </div>
  )
}
