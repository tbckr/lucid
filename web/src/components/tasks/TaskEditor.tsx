import { zodResolver } from '@hookform/resolvers/zod'
import { AlignLeftIcon, CheckIcon, ClockIcon, FlagIcon, ListChecksIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { KindSwitch } from '@/components/create/KindSwitch'
import { DateField } from '@/components/events/DateField'
import { EditorRow, quietField } from '@/components/events/EditorRow'
import { TimeSelect } from '@/components/events/TimeSelect'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogClose, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useCreateTodo, useDeleteTodo, useUpdateTodo, useVisibleCalendars } from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { useNow } from '@/hooks/useNow'
import { usePrefs } from '@/hooks/usePrefs'
import { parseDayKey } from '@/lib/dates'
import { browserTimeZone } from '@/lib/locale'
import { chooseCalendar, switchDraft, taskForm, writableFor } from '@/lib/quickCreate'
import { formToTodoInput, taskFormSchema, taskToForm, type TaskFormValues } from '@/lib/taskForm'
import { isOverdue, priorityLevel, priorityValue, type PriorityLevel } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { useSettings } from '@/stores/settings'
import { useUi, type TaskEditorState } from '@/stores/ui'

const LEVELS: PriorityLevel[] = ['none', 'low', 'medium', 'high']

// The chosen level in the colors of its chip in the task list.
const LEVEL_ON: Record<PriorityLevel, string> = {
  none: '',
  low: 'data-[state=on]:text-sky-800 dark:data-[state=on]:text-sky-300',
  medium: 'data-[state=on]:text-amber-800 dark:data-[state=on]:text-amber-300',
  high: 'data-[state=on]:text-destructive',
}

const DATES = {
  start: { date: 'startDate', time: 'startTime', other: 'due' },
  due: { date: 'dueDate', time: 'dueTime', other: 'start' },
} as const

type Which = keyof typeof DATES

/**
 * Edits a task in the editor dialog: title, notes, start and due date,
 * priority, checklist (FR-13, FR-14, FR-15, FR-16). Also creates one, from the
 * create popover or switched from a new event.
 */
export function TaskEditor({
  state,
  canSwitch,
  onDone,
}: {
  state: NonNullable<TaskEditorState>
  /** A new entry can be switched to an event. */
  canSwitch: boolean
  onDone: () => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const prefs = usePrefs()
  const now = useNow()
  const todo = state.mode === 'edit' ? state.todo : undefined
  const { all, visible, byId } = useVisibleCalendars()
  const taskList = useSettings((s) => s.taskList)
  // The list the user chose for a new task; while there is none, the editor chooses (`chooseCalendar`).
  const [chosen, setChosen] = useState(state.mode === 'create' ? state.draft.calendarId : '')
  const calendarId = todo ? todo.calendarId : (chooseCalendar('task', { all, visible, taskList, current: chosen })?.id ?? '')
  const colors = useCalendarColors()(calendarId)
  const tz = useMemo(() => browserTimeZone(), [])
  const lists = useMemo(() => writableFor('task', all), [all])
  const list = byId.get(calendarId)
  const readOnly = todo ? (list?.readOnly ?? false) : false
  const update = useUpdateTodo()
  const create = useCreateTodo()
  const del = useDeleteTodo()
  const [newItem, setNewItem] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const asked = useRef(false)
  const openEditor = useUi((s) => s.openEditor)
  const kindRef = useRef<HTMLButtonElement>(null)

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues:
      state.mode === 'edit'
        ? taskToForm(state.todo, tz)
        : { ...taskForm(state.draft.title, state.draft.task), description: state.draft.description },
  })
  const { register, control, handleSubmit, formState, setValue, getValues, setFocus } = form
  const checklist = useFieldArray({ control, name: 'checklist' })
  const [completed, startDate, startTime, dueDate, dueTime, items] = useWatch({
    control,
    name: ['completed', 'startDate', 'startTime', 'dueDate', 'dueTime', 'checklist'],
  })
  const values = { start: { date: startDate, time: startTime }, due: { date: dueDate, time: dueTime } }
  // Overdue as the task list will show it once saved (FR-14).
  const overdue = isOverdue(formToTodoInput({ ...getValues(), completed, dueDate, dueTime }, tz), now)
  const setOpts = { shouldDirty: true, shouldValidate: formState.isSubmitted }

  useEffect(() => {
    // The footer asks in place: focus its "Cancel", and "Delete task" again once it is back (NFR-27).
    if (confirmDelete) keepRef.current?.focus()
    else if (asked.current) deleteRef.current?.focus()
    asked.current = confirmDelete
  }, [confirmDelete])

  // A new entry starts in its title, not in the switch before it; after a switch, the focus stays there (NFR-27).
  useEffect(() => {
    if (state.mode !== 'create') return
    if (state.switched) kindRef.current?.focus()
    else setFocus('title')
  }, [state, setFocus])

  const toEvent = () => {
    if (state.mode !== 'create') return
    const v = getValues()
    const when = { startDate, startTime, dueDate, dueTime }
    const draft = { ...state.draft, title: v.title, description: v.description, calendarId: chosen, task: when }
    openEditor({ mode: 'create', switched: true, draft: switchDraft(draft, 'event') })
  }

  const addItem = () => {
    const text = newItem.trim()
    if (!text) return
    checklist.append({ text, done: false })
    setNewItem('')
  }

  const onSubmit = handleSubmit((v) => {
    if (todo) {
      update.mutate({ todo, input: formToTodoInput(v, tz, todo) }, { onSuccess: onDone })
      return
    }
    create.mutate(
      { calendarId, input: formToTodoInput(v, tz) },
      {
        onSuccess: () => {
          toast.success(t('tasks.created'))
          onDone()
        },
      },
    )
  })
  const pending = update.isPending || create.isPending

  const setDate = (which: Which, date: string) => {
    const f = DATES[which]
    const other = DATES[f.other]
    // A new date takes the other date's time: RFC 5545 wants a time on both or neither.
    if (!getValues(f.date)) setValue(f.time, getValues(other.time), setOpts)
    setValue(f.date, date, setOpts)
  }

  const clearDate = (which: Which) => {
    setValue(DATES[which].date, '', setOpts)
    setValue(DATES[which].time, '', setOpts)
  }

  const msg = (m: string | undefined) => (m ? t(m as 'validation.date') : undefined)
  const titleError = msg(formState.errors.title?.message)
  const itemError = msg(formState.errors.checklist?.message ?? formState.errors.checklist?.find?.((e) => e?.text)?.text?.message)

  const dateRow = (which: Which) => {
    const { date, time } = values[which]
    const other = values[DATES[which].other].date
    const error = msg(formState.errors[DATES[which].date]?.message)
    // The label keeps its own column, so on narrow screens the time wraps below the date.
    return (
      <div className="grid grid-cols-[3rem_1fr] items-start gap-x-2 gap-y-1">
        <span id={`${id}-${which}-label`} className="flex h-9 items-center text-sm text-muted-foreground">
          {t(`tasks.${which}Label`)}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <DateField
            id={`${id}-${which}`}
            labelledBy={`${id}-${which}-label`}
            label={t(`tasks.${which}`)}
            value={date}
            onChange={(d) => {
              setDate(which, d)
            }}
            onClear={{
              label: which === 'start' ? t('tasks.removeStart') : t('tasks.removeDue'),
              clear: () => {
                clearDate(which)
              },
            }}
            placeholder={readOnly ? t('tasks.noDate') : t('tasks.addDate')}
            month={other ? parseDayKey(other) : undefined}
            prefs={prefs}
            now={now}
            invalid={!!error}
            describedBy={error ? `${id}-${which}-error` : undefined}
          />
          {date && (
            <TimeSelect
              value={time}
              onChange={(v) => {
                setValue(DATES[which].time, v, setOpts)
              }}
              none={t('tasks.noTime')}
              placeholder={t('tasks.addTime')}
              prefs={prefs}
              invalid={!!error}
              aria-label={t(`tasks.${which}Time`)}
            />
          )}
          {which === 'due' && overdue && <span className="text-sm font-medium text-destructive">{t('tasks.overdue')}</span>}
        </div>
        {error && (
          <p id={`${id}-${which}-error`} className="col-start-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    )
  }

  return (
    <form
      onSubmit={(e) => {
        // An item typed but not yet added is part of what the user saves.
        addItem()
        void onSubmit(e)
      }}
      noValidate
    >
      {/* The task as it appears in its list: the list's tint and bar, and the round check that completes it. */}
      <div
        className="relative grid grid-cols-[1.25rem_1fr] items-start gap-x-3 border-l-4 pt-5 pr-14 pb-4 pl-3 transition-colors duration-200 sm:pl-5"
        style={{ backgroundColor: colors.tint, color: colors.onTint, borderLeftColor: colors.solid }}
      >
        <DialogTitle className="sr-only">{todo ? t('tasks.edit') : t('tasks.new')}</DialogTitle>
        <DialogDescription className="sr-only">{todo ? t('tasks.editDescription') : t('tasks.newDescription')}</DialogDescription>
        {!todo && canSwitch && <KindSwitch ref={kindRef} kind="task" onSwitch={toEvent} className="col-start-2 mb-2.5" />}
        {/* A new task shows the check as its shape only: there is nothing to complete yet. */}
        {todo ? (
          <Controller
            control={control}
            name="completed"
            render={({ field }) => (
              <button
                type="button"
                role="checkbox"
                aria-checked={field.value}
                aria-label={t('tasks.markCompleted')}
                disabled={readOnly}
                onClick={() => {
                  field.onChange(!field.value)
                }}
                className="mt-1 flex size-6 items-center justify-center justify-self-center rounded-full border-2 transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-current/50 disabled:opacity-50"
                style={{ borderColor: colors.solid, backgroundColor: field.value ? colors.solid : 'transparent' }}
              >
                {field.value && <CheckIcon className="size-4" strokeWidth={3.5} style={{ color: colors.onSolid }} aria-hidden />}
              </button>
            )}
          />
        ) : (
          <span
            className="mt-1 size-6 justify-self-center rounded-full border-2 transition-colors"
            style={{ borderColor: colors.solid }}
            aria-hidden
          />
        )}
        <div className="grid min-w-0 gap-2">
          <Label htmlFor={`${id}-title`} className="sr-only">
            {t('tasks.titleLabel')}
          </Label>
          <input
            id={`${id}-title`}
            placeholder={t('event.titlePlaceholder')}
            autoComplete="off"
            readOnly={readOnly}
            className={cn(
              'w-full border-b-2 border-transparent bg-transparent pb-0.5 font-display text-2xl leading-tight font-semibold tracking-tight outline-none placeholder:text-current placeholder:opacity-60 focus-visible:border-current aria-invalid:border-destructive',
              completed && 'line-through decoration-2 opacity-70',
            )}
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? `${id}-title-error` : undefined}
            {...register('title')}
          />
          {titleError && (
            <p id={`${id}-title-error`} className="text-sm font-medium text-destructive">
              {titleError}
            </p>
          )}
          {todo ? (
            <p className="flex items-center gap-2 text-sm font-medium">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: colors.solid }} aria-hidden />
              <span className="sr-only">{t('tasks.list')}: </span>
              {list?.name ?? t('event.unknownCalendar')}
            </p>
          ) : (
            <div className="flex">
              <Label htmlFor={`${id}-list`} className="sr-only">
                {t('tasks.list')}
              </Label>
              <Select value={calendarId} onValueChange={setChosen}>
                <SelectTrigger
                  id={`${id}-list`}
                  className="-ml-2 h-8 w-auto border-transparent bg-transparent px-2 font-medium text-current hover:border-current/25 data-[placeholder]:text-current"
                >
                  <SelectValue placeholder={t('tasks.chooseList')} />
                </SelectTrigger>
                <SelectContent>
                  {lists.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: c.color }} aria-hidden />
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {readOnly && <p className="text-sm">{t('tasks.readOnlyNotice')}</p>}
        </div>
        <DialogClose className="absolute top-3 right-3 rounded-md p-1.5 transition-colors outline-none hover:bg-current/10 focus-visible:ring-[3px] focus-visible:ring-current/50 [&_svg]:size-4">
          <XIcon aria-hidden />
          <span className="sr-only">{t('common.close')}</span>
        </DialogClose>
      </div>

      <fieldset disabled={readOnly} className="grid gap-3 px-4 pt-5 pb-2 sm:px-6">
        <EditorRow icon={<ClockIcon />}>
          <fieldset className="grid gap-2">
            <legend className="sr-only">{t('tasks.when')}</legend>
            {dateRow('start')}
            {dateRow('due')}
          </fieldset>
        </EditorRow>

        <EditorRow icon={<FlagIcon />}>
          <Controller
            control={control}
            name="priority"
            render={({ field }) => (
              <ToggleGroup
                type="single"
                aria-label={t('tasks.priority')}
                className="mt-0.5"
                value={priorityLevel(field.value)}
                onValueChange={(level) => {
                  // Radix deselects on a second click (""); keep the exact RFC 5545 value while the level stays.
                  if (level && level !== priorityLevel(field.value)) field.onChange(priorityValue(level as PriorityLevel))
                }}
              >
                {LEVELS.map((l) => (
                  <ToggleGroupItem key={l} value={l} className={LEVEL_ON[l]}>
                    {t(`priority.${l}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
          />
        </EditorRow>

        <EditorRow icon={<ListChecksIcon />}>
          <fieldset className="grid">
            <legend className="sr-only">{t('tasks.checklist')}</legend>
            {checklist.fields.length > 0 && (
              <ul className="grid">
                {checklist.fields.map((f, i) => (
                  <li key={f.id} className="group flex items-center gap-1">
                    <Controller
                      control={control}
                      name={`checklist.${i}.done`}
                      render={({ field }) => (
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={(v) => {
                            field.onChange(v === true)
                          }}
                          aria-label={t('tasks.itemDone', { text: f.text })}
                        />
                      )}
                    />
                    <Input
                      className={cn(
                        'h-8 border-transparent bg-transparent px-2 hover:border-input',
                        items[i]?.done && 'text-muted-foreground line-through',
                      )}
                      aria-label={t('tasks.itemText', { index: i + 1 })}
                      aria-invalid={formState.errors.checklist?.[i]?.text ? true : undefined}
                      {...register(`checklist.${i}.text`)}
                    />
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        // Shown on hover or focus where there is a pointer to hover with.
                        className="text-muted-foreground pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100"
                        aria-label={t('tasks.removeItem', { text: f.text })}
                        onClick={() => {
                          checklist.remove(i)
                        }}
                      >
                        <XIcon aria-hidden />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && (
              <div className="flex items-center gap-1">
                <PlusIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <Input
                  className="h-8 border-transparent bg-transparent px-2 hover:border-input"
                  value={newItem}
                  placeholder={t('tasks.addItemPlaceholder')}
                  aria-label={t('tasks.addItem')}
                  onChange={(e) => {
                    setNewItem(e.target.value)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addItem()
                    }
                  }}
                />
              </div>
            )}
            {itemError && <p className="pt-1 text-sm text-destructive">{itemError}</p>}
          </fieldset>
        </EditorRow>

        <EditorRow icon={<AlignLeftIcon />}>
          <Label htmlFor={`${id}-notes`} className="sr-only">
            {t('tasks.notes')}
          </Label>
          <Textarea
            id={`${id}-notes`}
            placeholder={readOnly ? undefined : t('tasks.addNotes')}
            className={cn(quietField, 'max-h-48 min-h-9 resize-none')}
            {...register('description')}
          />
        </EditorRow>
      </fieldset>

      <DialogFooter className="sticky bottom-0 bg-surface px-4 pt-3 pb-4 sm:justify-between sm:px-6 sm:pb-5">
        {confirmDelete ? (
          <div role="alert" className="flex w-full flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{t('tasks.confirmDelete')}</p>
            <div className="flex gap-2">
              <Button
                ref={keepRef}
                type="button"
                variant="ghost"
                onClick={() => {
                  setConfirmDelete(false)
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={del.isPending}
                onClick={() => {
                  if (todo) del.mutate(todo, { onSuccess: onDone })
                }}
              >
                {del.isPending && <Spinner />}
                {t('tasks.delete')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {readOnly || !todo ? (
              <span />
            ) : (
              <Button
                ref={deleteRef}
                type="button"
                variant="ghost"
                className="text-destructive"
                onClick={() => {
                  setConfirmDelete(true)
                }}
              >
                <Trash2Icon aria-hidden />
                {t('tasks.delete')}
              </Button>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" onClick={onDone}>
                {readOnly ? t('common.close') : t('common.cancel')}
              </Button>
              {!readOnly && (
                <Button type="submit" disabled={pending || !calendarId}>
                  {pending && <Spinner />}
                  {todo ? t('common.save') : t('tasks.createAction')}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogFooter>
    </form>
  )
}
