import { useVirtualizer } from '@tanstack/react-virtual'
import { EyeIcon, EyeOffIcon, PlusIcon, XIcon } from 'lucide-react'
import { useMemo, useRef, useState, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { CorruptedEvent } from '@/components/events/CorruptedEvent'
import { useCreateTodo, useTodos } from '@/hooks/queries'
import { type Calendar, type CorruptedItem, type Todo } from '@/lib/api/schemas'
import { sortTodos } from '@/lib/tasks'
import { useSettings } from '@/stores/settings'
import { TaskRow } from './TaskRow'

type Row =
  | { type: 'header'; key: string; calendar: Calendar; open: number }
  | { type: 'todo'; key: string; todo: Todo; calendar: Calendar }
  | { type: 'corrupted'; key: string; item: CorruptedItem }

/** Right sidebar with tasks of all todo calendars (FR-12..15). */
export function TasksPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const { groups, isLoading } = useTodos()
  const hideCompleted = useSettings((s) => s.hideCompletedTasks)
  const update = useSettings((s) => s.update)
  const scrollRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const out: Row[] = []
    for (const g of groups) {
      const sorted = sortTodos(g.todos, hideCompleted)
      const open = g.todos.filter((x) => x.status !== 'COMPLETED' && x.status !== 'CANCELLED').length
      if (groups.length > 1) out.push({ type: 'header', key: `h:${g.calendar.id}`, calendar: g.calendar, open })
      for (const todo of sorted) out.push({ type: 'todo', key: `t:${todo.id}`, todo, calendar: g.calendar })
      for (const c of g.corrupted) out.push({ type: 'corrupted', key: `c:${c.key}`, item: c })
    }
    return out
  }, [groups, hideCompleted])

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is not compiler-safe yet
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === 'header' ? 40 : 52),
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
  })

  const calendars = groups.map((g) => g.calendar).filter((c) => !c.readOnly)

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

      {calendars.length > 0 && <AddTask calendars={calendars} />}

      {isLoading && (
        <p className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
          <Spinner /> {t('common.loading')}
        </p>
      )}
      {!isLoading && groups.length === 0 && (
        <p className="px-4 py-6 text-sm text-muted-foreground">{t('tasks.noCalendars')}</p>
      )}
      {!isLoading && groups.length > 0 && rows.every((r) => r.type !== 'todo') && (
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
                {row.type === 'header' && (
                  <h3 className="flex items-center gap-2 px-4 pt-4 pb-1 text-xs font-semibold text-muted-foreground">
                    <span className="size-2.5 rounded-full" style={{ backgroundColor: row.calendar.color }} aria-hidden />
                    <span className="truncate">{row.calendar.name}</span>
                    <span className="tabular ml-auto font-normal">{row.open}</span>
                  </h3>
                )}
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

function AddTask({ calendars }: { calendars: Calendar[] }) {
  const { t } = useTranslation()
  const create = useCreateTodo()
  const [title, setTitle] = useState('')
  const [calendarId, setCalendarId] = useState<string>('')
  const target = calendars.find((c) => c.id === calendarId) ?? calendars[0]

  const submit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault()
    const text = title.trim()
    if (!text || !target) return
    create.mutate(
      {
        calendarId: target.id,
        input: {
          title: text,
          description: '',
          checklist: [],
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
    <form onSubmit={submit} className="grid gap-2 px-3 pb-2">
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
      {calendars.length > 1 && target && (
        <Select value={target.id} onValueChange={setCalendarId}>
          <SelectTrigger className="h-8 text-xs" aria-label={t('tasks.list')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {calendars.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                <span className="size-2.5 rounded-full" style={{ backgroundColor: c.color }} aria-hidden />
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </form>
  )
}
