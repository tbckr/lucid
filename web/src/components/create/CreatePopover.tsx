import { useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { DetailClose, DetailContent } from '@/components/events/DetailParts'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useCalendars, useCreateEvent, useCreateTodo, useVisibleCalendars } from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { useNow } from '@/hooks/useNow'
import { usePrefs } from '@/hooks/usePrefs'
import { eventFormSchema, formToInput } from '@/lib/eventForm'
import { browserTimeZone } from '@/lib/locale'
import { lastKnownBox, spanBox } from '@/lib/placement'
import {
  chooseCalendar,
  eventDefaults,
  eventForm,
  eventFromTask,
  eventWhen,
  previewOf,
  taskForm,
  taskWhen,
  writableFor,
  type CreateKind,
} from '@/lib/quickCreate'
import { formToTodoInput, taskFormSchema } from '@/lib/taskForm'
import { useSettings } from '@/stores/settings'
import { useUi, type CreateState } from '@/stores/ui'
import { QuickWhen } from './QuickWhen'

// The kind switch on the tint: the chosen side as a paper pill.
const onTintItem = 'text-current/75 hover:text-current data-[state=on]:bg-surface data-[state=on]:text-foreground'

/** Popover at a click in the calendar that creates an event or a task (FR-09, FR-16). */
export function CreatePopover() {
  const create = useUi((s) => s.create)
  const openCreate = useUi((s) => s.openCreate)
  if (!create) return null
  return (
    // Modal: a click beside it only closes it, and never reaches the grid underneath.
    <Popover
      open
      modal
      onOpenChange={(open) => {
        if (!open) openCreate(null)
      }}
    >
      <CreateForm create={create} />
    </Popover>
  )
}

function CreateForm({ create }: { create: CreateState }) {
  const { t } = useTranslation()
  const id = useId()
  const prefs = usePrefs()
  const now = useNow()
  const tz = useMemo(() => browserTimeZone(), [])
  const { data: loaded } = useCalendars()
  const { all, visible } = useVisibleCalendars()
  const taskList = useSettings((s) => s.taskList)
  const colorsOf = useCalendarColors()
  const openCreate = useUi((s) => s.openCreate)
  const openEditor = useUi((s) => s.openEditor)
  const openTaskEditor = useUi((s) => s.openTaskEditor)
  const setCreatePreview = useUi((s) => s.setCreatePreview)
  const createEvent = useCreateEvent()
  const createTodo = useCreateTodo()
  const titleRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const { origin, anchor, span, returnFocus } = create

  const [chosenKind, setKind] = useState<CreateKind>('event')
  const [title, setTitle] = useState('')
  const [event, setEvent] = useState(() => eventWhen(origin, tz))
  const [task, setTask] = useState(() => taskWhen(eventWhen(origin, tz), origin))
  const [calendarId, setCalendarId] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const eventCalendars = useMemo(() => writableFor('event', all), [all])
  const taskLists = useMemo(() => writableFor('task', all), [all])
  // Where only one kind can be created, the popover creates that one.
  const kind: CreateKind = eventCalendars.length === 0 && taskLists.length > 0 ? 'task' : chosenKind
  const both = eventCalendars.length > 0 && taskLists.length > 0
  // The chosen calendar while it takes the kind, else the default; follows the list as it loads or changes.
  const calendar = chooseCalendar(kind, { all, visible, taskList, current: calendarId })
  const target = calendar?.id ?? ''
  const colors = colorsOf(target)
  const when = kind === 'event' ? event : task
  const pending = createEvent.isPending || createTodo.isPending

  useEffect(() => {
    setCreatePreview(previewOf(kind, when, target, title, tz))
  }, [kind, when, target, title, tz, setCreatePreview])

  // Point at the slot of the new event in its day column, not at the whole day.
  const measure = useMemo(() => {
    if (!span) return undefined
    const box = lastKnownBox(anchor)
    return () => spanBox(box(), span.startMin, span.endMin)
  }, [anchor, span])

  const values = kind === 'event' ? eventForm(title, target, event) : taskForm(title, task)
  const result = kind === 'event' ? eventFormSchema.safeParse(values) : taskFormSchema.safeParse(values)
  const errorOf = (...paths: string[]) => {
    if (!submitted || result.success) return undefined
    const m = result.error.issues.find((i) => paths.includes(String(i.path[0])))?.message
    return m ? t(m as 'validation.date') : undefined
  }
  const titleError = errorOf('title')
  const whenError = errorOf('endDate', 'startDate', 'dueDate')

  const switchTo = (next: string) => {
    // Radix reports "" when the chosen item is clicked again.
    if ((next !== 'event' && next !== 'task') || next === kind) return
    if (next === 'task') setTask(taskWhen(event, origin))
    else setEvent(eventFromTask(task, event))
    setKind(next)
  }

  const close = () => {
    openCreate(null)
  }

  const submit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSubmitted(true)
    if (!result.success || !target) return
    if (kind === 'event') {
      createEvent.mutate(
        { calendarId: target, input: formToInput(eventForm(title, target, event), tz) },
        { onSuccess: close },
      )
      return
    }
    createTodo.mutate(
      { calendarId: target, input: formToTodoInput(taskForm(title, task), tz) },
      {
        onSuccess: () => {
          toast.success(t('tasks.created'))
          close()
        },
      },
    )
  }

  const more = () => {
    if (kind === 'event') {
      openEditor({ mode: 'create', defaults: { ...eventDefaults(event, tz), title, ...(target ? { calendarId: target } : {}) } })
    } else {
      openTaskEditor({ mode: 'create', defaults: { ...task, title, calendarId: target } })
    }
  }

  // Nothing to create in: say so instead of a form that cannot be sent.
  const none = loaded !== undefined && eventCalendars.length === 0 && taskLists.length === 0

  return (
    <DetailContent
      anchor={anchor}
      measure={measure}
      returnFocus={returnFocus}
      label={kind === 'event' ? t('event.new') : t('tasks.new')}
      initialFocus={() => titleRef.current ?? closeRef.current}
    >
      {none ? (
        <div className="grid gap-3 p-4">
          <p className="text-sm">{t('event.noWritableCalendar')}</p>
          <div className="flex justify-end">
            <Button ref={closeRef} size="sm" onClick={close}>
              {t('common.close')}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          {/* The entry as it will appear in the calendar: its calendar's tint and bar, and a task's round check. */}
          <div
            className="relative grid grid-cols-[1.25rem_1fr] items-start gap-x-3 gap-y-1 border-l-4 pt-3 pr-12 pb-3.5 pl-3 transition-colors duration-200"
            style={{ backgroundColor: colors.tint, color: colors.onTint, borderLeftColor: colors.solid }}
          >
            {both && (
              <ToggleGroup
                type="single"
                aria-label={t('create.kind')}
                value={kind}
                onValueChange={switchTo}
                className="col-start-2 mb-1.5 justify-self-start bg-current/10"
              >
                <ToggleGroupItem value="event" className={onTintItem}>
                  {t('create.event')}
                </ToggleGroupItem>
                <ToggleGroupItem value="task" className={onTintItem}>
                  {t('create.task')}
                </ToggleGroupItem>
              </ToggleGroup>
            )}
            {kind === 'task' && (
              <span
                className="col-start-1 mt-[3px] size-6 justify-self-center rounded-full border-2 animate-in duration-150 fade-in zoom-in-50"
                style={{ borderColor: colors.solid }}
                aria-hidden
              />
            )}
            <Label htmlFor={`${id}-title`} className="sr-only">
              {t('event.title')}
            </Label>
            <input
              ref={titleRef}
              id={`${id}-title`}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
              }}
              placeholder={t('event.titlePlaceholder')}
              autoComplete="off"
              maxLength={1024}
              className="col-start-2 w-full min-w-0 border-b-2 border-transparent bg-transparent pb-0.5 font-display text-2xl leading-tight font-semibold tracking-tight outline-none placeholder:text-current placeholder:opacity-60 focus-visible:border-current aria-invalid:border-destructive"
              aria-invalid={titleError ? true : undefined}
              aria-describedby={titleError ? `${id}-title-error` : undefined}
            />
            {titleError && (
              <p id={`${id}-title-error`} className="col-start-2 text-sm font-medium text-destructive">
                {titleError}
              </p>
            )}
            <div className="col-start-2 min-w-0">
              <QuickWhen
                kind={kind}
                event={event}
                task={task}
                onEvent={setEvent}
                onTask={setTask}
                prefs={prefs}
                now={now}
                invalid={!!whenError}
                describedBy={whenError ? `${id}-when-error` : undefined}
              />
            </div>
            {whenError && (
              <p id={`${id}-when-error`} className="col-start-2 text-sm font-medium text-destructive">
                {whenError}
              </p>
            )}
            <div className="col-start-2 flex">
              <Label htmlFor={`${id}-calendar`} className="sr-only">
                {kind === 'event' ? t('event.calendar') : t('tasks.list')}
              </Label>
              <Select value={target} onValueChange={setCalendarId}>
                <SelectTrigger
                  id={`${id}-calendar`}
                  className="-ml-2 h-8 w-auto border-transparent bg-transparent px-2 font-medium text-current hover:border-current/25 data-[placeholder]:text-current"
                >
                  <SelectValue placeholder={kind === 'event' ? t('event.chooseCalendar') : t('tasks.chooseList')} />
                </SelectTrigger>
                <SelectContent>
                  {(kind === 'event' ? eventCalendars : taskLists).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: c.color }} aria-hidden />
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DetailClose ref={closeRef} onClose={close} />
          </div>

          <div className="flex items-center justify-between gap-2 p-4">
            {/* Hangs like "Delete" in the details popover. */}
            <Button type="button" size="sm" variant="ghost" className="-ml-2.5" onClick={more}>
              {t('create.more')}
            </Button>
            <Button type="submit" size="sm" disabled={pending || !target}>
              {pending && <Spinner />}
              {kind === 'event' ? t('event.createAction') : t('tasks.createAction')}
            </Button>
          </div>
        </form>
      )}
    </DetailContent>
  )
}
