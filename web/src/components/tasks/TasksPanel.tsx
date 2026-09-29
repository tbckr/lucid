import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDownIcon, LockIcon, PlusIcon, XIcon } from 'lucide-react'
import { useMemo, useRef, useState, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { CorruptedEvent } from '@/components/events/CorruptedEvent'
import { useCreateTodo, useDeleteTodos, useTodos, type TodosResult } from '@/hooks/queries'
import { useNow } from '@/hooks/useNow'
import { type Calendar, type CorruptedItem, type Todo } from '@/lib/api/schemas'
import { groupTodos, isDone, selectTaskList, type TaskGroupKind } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { useSettings } from '@/stores/settings'
import { ConfirmDelete } from './ConfirmDelete'
import { TaskRow } from './TaskRow'

type Row =
  | { type: 'heading'; key: string; kind: TaskGroupKind; count: number }
  | { type: 'todo'; key: string; todo: Todo; calendar: Calendar; timeOnly: boolean }
  | { type: 'corrupted'; key: string; item: CorruptedItem }

/*
 * Right sidebar with the tasks of one todo calendar, chosen from all of them
 * (FR-12..15). The list leads with its color bar and name, and its tasks are
 * grouped by when they are due; the completed ones fold away, and can be
 * deleted all at once.
 */
export function TasksPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const now = useNow()
  const { groups: lists, isLoading } = useTodos()
  const collapsed = useSettings((s) => s.hideCompletedTasks)
  const taskList = useSettings((s) => s.taskList)
  const update = useSettings((s) => s.update)
  const deleteTodos = useDeleteTodos()
  const scrollRef = useRef<HTMLDivElement>(null)
  const list = selectTaskList(lists, taskList)
  const open = list?.todos.filter((x) => !isDone(x)).length ?? 0
  // Counts and empty states wait for the tasks, so they never claim an empty list while it loads.
  const loaded = list && !isLoading ? list : undefined

  const groups = useMemo(() => (list ? groupTodos(list.todos, now) : []), [list, now])
  const completed = groups.find((g) => g.kind === 'completed')?.todos ?? []

  const rows = useMemo(() => {
    if (!list) return []
    const out: Row[] = []
    for (const g of groups) {
      out.push({ type: 'heading', key: `g:${g.kind}`, kind: g.kind, count: g.todos.length })
      if (g.kind === 'completed' && collapsed) continue
      // Today and Tomorrow name the day in their heading, so the rows show only the time.
      const timeOnly = g.kind === 'today' || g.kind === 'tomorrow'
      for (const todo of g.todos) out.push({ type: 'todo', key: `t:${todo.id}`, todo, calendar: list.calendar, timeOnly })
    }
    for (const c of list.corrupted) out.push({ type: 'corrupted', key: `c:${c.key}`, item: c })
    return out
  }, [list, groups, collapsed])

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is not compiler-safe yet
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === 'heading' ? 42 : 48),
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
  })

  return (
    <aside aria-label={t('tasks.title')} className="flex h-full min-h-0 flex-col">
      <header className="flex items-start gap-3 pt-2 pr-2 pb-3 pl-4">
        {/* The list's color as a bar in the column of the checks, like the bar of its tasks in the calendar. */}
        <span className="flex w-[1.125rem] shrink-0 justify-center self-stretch py-1" aria-hidden>
          {list && <span className="w-1 rounded-full" style={{ backgroundColor: list.calendar.color }} />}
        </span>
        <div className="min-w-0 flex-1">
          {list && lists.length > 1 ? (
            <>
              <h2 className="sr-only">{list.calendar.name}</h2>
              <TaskListSelect
                lists={lists}
                value={list.calendar.id}
                name={list.calendar.name}
                onChange={(id) => {
                  update({ taskList: id })
                }}
              />
            </>
          ) : (
            <h2 className="truncate font-display text-xl leading-8 font-semibold tracking-tight">
              {list?.calendar.name ?? t('tasks.title')}
            </h2>
          )}
          {list && (
            <p className="flex h-5 items-center gap-3 text-[0.8125rem] text-muted-foreground">
              {loaded && <span className="tabular">{t('tasks.openCount', { count: open })}</span>}
              {list.calendar.readOnly && (
                <span className="inline-flex items-center gap-1">
                  <LockIcon className="size-3" aria-hidden />
                  {t('calendars.readOnly')}
                </span>
              )}
            </p>
          )}
        </div>
        <Button variant="ghost" size="icon-sm" className="mt-1" aria-label={t('tasks.close')} onClick={onClose}>
          <XIcon aria-hidden />
        </Button>
      </header>

      {list && !list.calendar.readOnly && <AddTask calendar={list.calendar} />}

      {isLoading && (
        <p className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
          <Spinner /> {t('common.loading')}
        </p>
      )}
      {!isLoading && !list && <p className="px-4 py-3 text-sm text-muted-foreground">{t('tasks.noCalendars')}</p>}
      {loaded?.todos.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">{t('tasks.empty')}</p>}
      {loaded && loaded.todos.length > 0 && open === 0 && (
        <p className="px-4 pt-3 text-sm text-muted-foreground">{t('tasks.allDone')}</p>
      )}

      <div ref={scrollRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pb-4" data-testid="tasks-list">
        <ul className="relative" style={{ height: virtualizer.getTotalSize() }} aria-label={t('tasks.title')}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            if (!row) return null
            return (
              <li
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row.type === 'heading' && (
                  <GroupHeading
                    kind={row.kind}
                    count={row.count}
                    collapsed={collapsed}
                    onToggle={() => {
                      update({ hideCompletedTasks: !collapsed })
                    }}
                    {...(list && !list.calendar.readOnly
                      ? {
                          deleting: deleteTodos.isPending,
                          onDeleteAll: () => {
                            deleteTodos.mutate(completed)
                          },
                        }
                      : {})}
                  />
                )}
                {row.type === 'todo' && <TaskRow todo={row.todo} calendar={row.calendar} timeOnly={row.timeOnly} />}
                {row.type === 'corrupted' && (
                  <div className="px-4 py-1">
                    <CorruptedEvent reason={row.item.reason} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </aside>
  )
}

/** Overdue in red and Today in iris, like the current day in the calendar; the rest stays quiet. */
const GROUP_COLOR: Record<TaskGroupKind, string> = {
  overdue: 'text-destructive',
  today: 'text-primary',
  tomorrow: 'text-muted-foreground',
  later: 'text-muted-foreground',
  noDue: 'text-muted-foreground',
  completed: 'text-muted-foreground',
}

/**
 * A group's heading; the completed group folds, and its count says what is
 * folded away. In a writable list it deletes its tasks, quietly until asked.
 */
function GroupHeading({
  kind,
  count,
  collapsed,
  onToggle,
  deleting = false,
  onDeleteAll,
}: {
  kind: TaskGroupKind
  count: number
  collapsed: boolean
  onToggle: () => void
  deleting?: boolean
  onDeleteAll?: () => void
}) {
  const { t } = useTranslation()
  const label = t(`tasks.groups.${kind}`)
  const box = 'px-4 pt-5 pb-0.5'
  const heading = cn('font-display text-sm font-semibold', GROUP_COLOR[kind])
  if (kind !== 'completed') return <h3 className={cn(box, heading)}>{label}</h3>
  return (
    <div className={cn(box, 'flex items-baseline justify-between gap-3')}>
      <h3 className={heading}>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="-mx-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {label}{' '}
          <span className="tabular font-sans font-normal">{count}</span>
          <ChevronDownIcon className={cn('size-4 transition-transform', collapsed && '-rotate-90')} aria-hidden />
        </button>
      </h3>
      {onDeleteAll && (
        <ConfirmDelete
          question={t('tasks.confirmDeleteCompleted', { count })}
          note={t('tasks.deleteCompletedNote', { count })}
          action={t('tasks.deleteCompleted')}
          onConfirm={onDeleteAll}
        >
          {/* Its text ends where the icons of the rows end. */}
          <button
            type="button"
            aria-label={t('tasks.deleteCompletedLabel')}
            disabled={deleting}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[0.8125rem] text-muted-foreground outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=open]:text-destructive"
          >
            {deleting && <Spinner />}
            {t('tasks.deleteCompleted')}
          </button>
        </ConfirmDelete>
      )}
    </div>
  )
}

/** The list's name, which picks the list shown in the panel; each entry counts its open tasks. */
function TaskListSelect({
  lists,
  value,
  name,
  onChange,
}: {
  lists: TodosResult['groups']
  value: string
  name: string
  onChange: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className="-ml-1.5 h-8 w-auto max-w-full justify-start gap-1 border-0 bg-transparent px-1.5 py-0 font-display text-xl font-semibold tracking-tight hover:bg-muted"
        aria-label={t('tasks.list')}
      >
        <SelectValue>{name}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        {lists.map(({ calendar, todos }) => {
          const open = todos.filter((x) => !isDone(x)).length
          return (
            <SelectItem key={calendar.id} value={calendar.id} className="*:[span]:last:flex-1">
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: calendar.color }} aria-hidden />
              <span className="truncate">{calendar.name}</span>
              <span className="tabular ml-auto text-muted-foreground" aria-hidden>
                {open}
              </span>
              <span className="sr-only">{t('tasks.openCount', { count: open })}</span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

/** A new task as the list's next row: the plus in the column of the checks adds it. */
function AddTask({ calendar }: { calendar: Calendar }) {
  const { t } = useTranslation()
  const create = useCreateTodo()
  const [title, setTitle] = useState('')

  const submit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault()
    const text = title.trim()
    if (!text) return
    create.mutate(
      {
        calendarId: calendar.id,
        input: {
          title: text,
          description: '',
          checklist: [],
          start: null,
          startAllDay: false,
          due: null,
          dueAllDay: false,
          priority: 0,
          status: 'NEEDS-ACTION',
        },
      },
      {
        onSuccess: () => {
          setTitle('')
        },
      },
    )
  }

  return (
    <form onSubmit={submit} className="px-2">
      {/* Reads as a row of the list until hovered or focused, like the quiet fields of the editors. */}
      <div className="flex items-center gap-3 rounded-md border border-transparent px-2 hover:border-input focus-within:border-ring focus-within:bg-surface focus-within:ring-[3px] focus-within:ring-ring/40">
        <button
          type="submit"
          aria-label={t('tasks.add')}
          disabled={!title.trim() || create.isPending}
          className="flex size-[1.125rem] shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none enabled:text-primary focus-visible:ring-2 focus-visible:ring-ring"
        >
          {create.isPending ? <Spinner /> : <PlusIcon className="size-4" aria-hidden />}
        </button>
        <label htmlFor="new-task" className="sr-only">
          {t('tasks.add')}
        </label>
        <Input
          id="new-task"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
          }}
          placeholder={t('tasks.addPlaceholder')}
          maxLength={1024}
          autoComplete="off"
          className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </div>
    </form>
  )
}
