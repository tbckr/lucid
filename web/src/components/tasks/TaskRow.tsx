import { CheckIcon, FlagIcon, ListChecksIcon, PencilIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RecurringMark } from '@/components/events/EventItems'
import { ScopePopover } from '@/components/scope/ScopePopover'
import { Button } from '@/components/ui/button'
import { useDeleteTodo, useDetachTodo, useUpdateTodo } from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { useNow } from '@/hooks/useNow'
import { usePrefs } from '@/hooks/usePrefs'
import { useToggleTodo } from '@/hooks/useToggleTodo'
import { type Calendar, type Todo, type TodoInput } from '@/lib/api/schemas'
import { currentRepeat, recurringLabel, type TaskRepeat } from '@/lib/calendarTasks'
import {
  scopeOptions,
  taskGlyphSlots,
  taskScopeItems,
  taskScopeMissing,
  type Scope,
  type ScopeResult,
} from '@/lib/scope'
import { checklistProgress, formatDue, isDetached, priorityLevel, todoToInput } from '@/lib/tasks'
import { readableTextColor } from '@/lib/color'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'
import { ConfirmDelete } from './ConfirmDelete'
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
 * change the due date or open the editor; a done task has a trash in place of
 * the due date (FR-15). A read-only task opens the editor.
 *
 * A series shows as its current repeat, which a new title or due date
 * changes: where there is a choice, after asking which repeats it reaches
 * (FR-17). A task detached from its series is marked as such.
 */
export function TaskRow({ todo, calendar, timeOnly = false }: { todo: Todo; calendar: Calendar; timeOnly?: boolean }) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const now = useNow()
  const openTaskEditor = useUi((s) => s.openTaskEditor)
  const { done, toggle } = useToggleTodo(todo)
  // The writes of a series wait for its other writes (FR-17, NFR-26).
  const update = useUpdateTodo(todo.id)
  const detach = useDetachTodo(todo.id)
  const del = useDeleteTodo(todo.id)
  const [row, setRow] = useState<HTMLDivElement | null>(null)
  const title = todo.title || t('event.untitled')
  const labels = { today: t('tasks.today'), tomorrow: t('tasks.tomorrow'), yesterday: t('tasks.yesterday') }
  const due = formatDue(todo, now, prefs, labels, { timeOnly })
  const progress = checklistProgress(todo.checklist)
  const detached = isDetached(todo)
  const hasMeta = due !== null || progress.total > 0 || (!done && todo.priority > 0) || todo.recurring || detached
  const edit = () => {
    openTaskEditor({ mode: 'edit', todo })
  }
  const save = (input: TodoInput) => {
    update.mutate({ todo, input })
  }
  // A change of the series' current repeat, for the repeats `scope` reaches (FR-17): "only this
  // repeat" makes it a task of its own with the change, and the series goes on; "all repeats"
  // changes the series, its reach drawn in the toast.
  const saveScope = (scope: Scope, input: TodoInput, moved: boolean) => {
    const repeat = currentRepeat(todo)
    if (!repeat) return
    switch (scope) {
      case 'this':
        detach.mutate({ todo, repeat, input, moved })
        break
      case 'all':
        update.mutate({ todo, input, look: { slots: taskGlyphSlots('all', repeat.at) } })
        break
      case 'following':
        // Offered only at a later repeat, and the list shows the current one.
        break
    }
  }

  const meta = hasMeta && (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {due && <span className="tabular">{due}</span>}
      {/* FR-17: names the series' rule, e.g. "Every week on Monday and Thursday", or that the task was detached from one. */}
      <RecurringMark recurring={todo.recurring} detached={detached} label={recurringLabel(t, todo, null, prefs, now)} />
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
      ref={setRow}
      className="group grid grid-cols-[1.125rem_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-1"
      data-testid="task-row"
      data-task-id={todo.id}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={t('tasks.complete', { title: todo.title })}
        disabled={calendar.readOnly || todo.ruleUnsupported}
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
            row={row}
            onChange={save}
            onScope={(scope, input) => {
              saveScope(scope, input, false)
            }}
          />
          <div className="flex">
            {done ? (
              <ConfirmDelete
                question={t('tasks.confirmDelete')}
                action={t('tasks.delete')}
                onConfirm={() => {
                  del.mutate({ todo })
                }}
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('tasks.deleteNamed', { title })}
                  className={cn(ACTION, 'hover:text-destructive data-[state=open]:text-destructive')}
                >
                  <Trash2Icon aria-hidden />
                </Button>
              </ConfirmDelete>
            ) : (
              <DuePicker
                todo={todo}
                onChange={save}
                onScope={(scope, input) => {
                  saveScope(scope, input, true)
                }}
                className={ACTION}
              />
            )}
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

/** A new title waiting for the answer which repeats of the series it reaches (FR-17). */
interface Asking {
  input: TodoInput
  repeat: TaskRepeat
  result: ScopeResult
}

/**
 * The title as a field that reads as text until hovered or focused, like the
 * row that adds a task (FR-12). Enter or leaving it saves; Escape and an empty
 * title bring back the saved one. Line breaks become spaces.
 *
 * A new title of a series' current repeat asks below its `row` which repeats
 * it reaches where there is a choice, and `onScope` reports the answer; with
 * one option, `onScope` reports that one at once (FR-17). Cancelling the
 * question brings back the saved title. A task that does not repeat, and the
 * last repeat, are saved through `onChange`.
 */
function TitleField({
  todo,
  done,
  row,
  onChange,
  onScope,
}: {
  todo: Todo
  done: boolean
  /** The task's row, which the question points at: below it, the question leaves the row's meta line in view. */
  row: HTMLElement | null
  onChange: (input: TodoInput) => void
  onScope: (scope: Scope, input: TodoInput) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(todo.title)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(todo.title)
  const [asking, setAsking] = useState<Asking | null>(null)
  const [field, setField] = useState<HTMLTextAreaElement | null>(null)
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
    // The question takes the focus from the field: that saves nothing until it is answered.
    if (asking) return
    const text = draft.trim()
    if (!text) {
      revert()
      return
    }
    setDraft(text)
    if (text === todo.title) {
      setDirty(false)
      return
    }
    const input = todoToInput(todo, { title: text })
    const repeat = currentRepeat(todo)
    const result: ScopeResult = repeat ? scopeOptions({ kind: 'task', action: 'change', item: repeat }) : { options: [] }
    const [only] = result.options
    if (repeat && result.options.length > 1) {
      setAsking({ input, repeat, result })
      return
    }
    setDirty(false)
    if (only) onScope(only, input)
    else onChange(input)
  }
  const choose = (scope: Scope) => {
    if (!asking) return
    onScope(scope, asking.input)
    // A repeat made a task of its own takes the new title along; the series keeps its own.
    if (scope === 'this') setDraft(todo.title)
    setDirty(false)
    setAsking(null)
  }
  const cancel = () => {
    revert()
    setAsking(null)
  }

  return (
    <div className="-mx-1.5 grid min-w-0">
      <span aria-hidden className={cn(TITLE_BOX, 'invisible border-transparent')}>
        {draft}{' '}
      </span>
      <textarea
        ref={setField}
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
      {asking && <RenameQuestion anchor={row ?? field} field={field} asking={asking} onChoose={choose} onCancel={cancel} />}
    </div>
  )
}

/**
 * The question which repeats a new title reaches, in a popover at `anchor`
 * (FR-17). Escape, Cancel and a press beside it cancel it; the focus then
 * goes back to the title `field`, as after an answer (NFR-27).
 */
function RenameQuestion({
  anchor,
  field,
  asking,
  onChoose,
  onCancel,
}: {
  anchor: HTMLElement | null
  field: HTMLTextAreaElement | null
  asking: Asking
  onChoose: (scope: Scope) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const now = useNow()
  const { repeat, result } = asking
  // Looked up only while it asks, so the many rows of the list look up no calendar colors.
  const color = useCalendarColors()(repeat.todo.calendarId).solid
  return (
    <ScopePopover
      anchor={anchor}
      returnFocus={() => field}
      question={t('scope.task.change')}
      items={taskScopeItems(t, repeat, result.options, prefs, now, 'change')}
      color={color}
      missing={taskScopeMissing(t, result)}
      onChoose={onChoose}
      onCancel={onCancel}
    />
  )
}
