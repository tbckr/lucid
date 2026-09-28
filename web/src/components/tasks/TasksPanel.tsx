import { useVirtualizer } from '@tanstack/react-virtual'
import { EyeIcon, EyeOffIcon, PlusIcon, XIcon } from 'lucide-react'
import { useMemo, useRef, useState, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { CorruptedEvent } from '@/components/events/CorruptedEvent'
import { useCreateTodo, useTodos, type TodosResult } from '@/hooks/queries'
import { type Calendar, type CorruptedItem, type Todo } from '@/lib/api/schemas'
import { isDone, selectTaskList, sortTodos } from '@/lib/tasks'
import { useSettings } from '@/stores/settings'
import { TaskRow } from './TaskRow'

type Row =
  | { type: 'todo'; key: string; todo: Todo; calendar: Calendar }
  | { type: 'corrupted'; key: string; item: CorruptedItem }

/** Right sidebar with the tasks of one todo calendar, chosen from all of them (FR-12..15). */
export function TasksPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const { groups, isLoading } = useTodos()
  const hideCompleted = useSettings((s) => s.hideCompletedTasks)
  const taskList = useSettings((s) => s.taskList)
  const update = useSettings((s) => s.update)
  const scrollRef = useRef<HTMLDivElement>(null)
  const list = selectTaskList(groups, taskList)

  const rows = useMemo(() => {
    if (!list) return []
    const out: Row[] = sortTodos(list.todos, hideCompleted).map((todo) => ({
      type: 'todo',
      key: `t:${todo.id}`,
      todo,
      calendar: list.calendar,
    }))
    for (const c of list.corrupted) out.push({ type: 'corrupted', key: `c:${c.key}`, item: c })
    return out
  }, [list, hideCompleted])

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is not compiler-safe yet
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
  })

  return (
    <aside aria-labelledby="tasks-heading" className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-4">
        <h2 id="tasks-heading" className="flex-1 font-display text-base font-semibold">
          {t('tasks.title')}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={hideCompleted}
          aria-label={hideCompleted ? t('tasks.showCompleted') : t('tasks.hideCompleted')}
          title={hideCompleted ? t('tasks.showCompleted') : t('tasks.hideCompleted')}
          onClick={() => {
            update({ hideCompletedTasks: !hideCompleted })
          }}
        >
          {hideCompleted ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={t('tasks.close')} onClick={onClose}>
          <XIcon aria-hidden />
        </Button>
      </div>

      {groups.length > 1 && list && (
        <TaskListSelect
          lists={groups}
          value={list.calendar.id}
          onChange={(id) => {
            update({ taskList: id })
          }}
        />
      )}
      {list && !list.calendar.readOnly && <AddTask calendar={list.calendar} />}

      {isLoading && (
        <p className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
          <Spinner /> {t('common.loading')}
        </p>
      )}
      {!isLoading && !list && (
        <p className="px-4 py-6 text-sm text-muted-foreground">{t('tasks.noCalendars')}</p>
      )}
      {!isLoading && list && rows.every((r) => r.type !== 'todo') && (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {hideCompleted ? t('tasks.allDone') : t('tasks.empty')}
        </p>
      )}

      <div ref={scrollRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" data-testid="tasks-list">
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
                {row.type === 'todo' && <TaskRow todo={row.todo} calendar={row.calendar} />}
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

/** Picks the task list shown in the panel; each entry counts its open tasks. */
function TaskListSelect({
  lists,
  value,
  onChange,
}: {
  lists: TodosResult['groups']
  value: string
  onChange: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="px-3 pb-2">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="*:data-[slot=select-value]:flex-1" aria-label={t('tasks.list')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
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
    </div>
  )
}

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
    <form onSubmit={submit} className="px-3 pb-2">
      <div className="flex items-center gap-1 rounded-lg border border-input bg-surface pr-1 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40">
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
          className="border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
        <Button type="submit" size="icon-sm" variant="ghost" aria-label={t('tasks.add')} disabled={!title.trim() || create.isPending}>
          {create.isPending ? <Spinner /> : <PlusIcon aria-hidden />}
        </Button>
      </div>
    </form>
  )
}
