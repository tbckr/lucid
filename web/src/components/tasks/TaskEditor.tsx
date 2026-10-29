import { zodResolver } from '@hookform/resolvers/zod'
import {
  AlignLeftIcon,
  CheckIcon,
  ClockIcon,
  FlagIcon,
  GlobeIcon,
  InfoIcon,
  ListChecksIcon,
  PlusIcon,
  RepeatIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConflictNotice } from '@/components/ConflictNotice'
import { KindSwitch } from '@/components/create/KindSwitch'
import { RepeatField } from '@/components/recurrence/RepeatField'
import { DateField } from '@/components/events/DateField'
import { EditorRow, quietField } from '@/components/events/EditorRow'
import { SkippedTimeNote } from '@/components/events/SkippedTimeNote'
import { TimeField } from '@/components/events/TimeField'
import { useReadableStart } from '@/components/events/useTypedField'
import { ZoneField } from '@/components/events/ZoneField'
import { ScopeChoice } from '@/components/scope/ScopeChoice'
import { ScopeGlyph } from '@/components/scope/ScopeGlyph'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogClose, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  reloadedTodoEtag,
  useCreateTodo,
  useDeleteTodo,
  useDetachTodo,
  useEndTodo,
  useSkipTodo,
  useTodoFollowing,
  useUpdateTodo,
  useVisibleCalendars,
  useZonesInUse,
} from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { useNow } from '@/hooks/useNow'
import { usePrefs } from '@/hooks/usePrefs'
import { isApiError } from '@/lib/api/client'
import { type Todo, type TodoInput } from '@/lib/api/schemas'
import {
  allRepeatsDates,
  currentRepeat,
  taskRuleStart,
  type RowZones,
  type TaskDates,
  type TaskRepeat,
} from '@/lib/calendarTasks'
import { dayAt, isFormDate, isFormTime, parseDayKey, skippedTime } from '@/lib/dates'
import { inYourZone } from '@/lib/format'
import { browserTimeZone } from '@/lib/locale'
import { chooseCalendar, switchDraft, taskForm, writableFor } from '@/lib/quickCreate'
import { buildRRule, RECURRENCE_PRESETS, type Recurrence } from '@/lib/rrule'
import {
  scopeOptions,
  taskGlyphSlots,
  taskScopeHint,
  taskScopeItems,
  taskScopeMissing,
  type Scope,
  type ScopeAction,
  type ScopeNotes,
  type ScopeResult,
} from '@/lib/scope'
import {
  buildTaskFormSchema,
  editedFields,
  formToTodoInput,
  formWithDate,
  formWithTime,
  seriesEditInput,
  taskToForm,
  taskZonesChanged,
  withTaskStartZone,
  type TaskFormValues,
} from '@/lib/taskForm'
import {
  datesChanged,
  isOverdue,
  isSeriesCompletion,
  priorityLevel,
  priorityValue,
  type PriorityLevel,
} from '@/lib/tasks'
import { unreadableNote } from '@/lib/unreadable'
import { cn } from '@/lib/utils'
import { fieldZone, sameZone } from '@/lib/zones'
import { useSettings } from '@/stores/settings'
import { useUi, type TaskEditorState } from '@/stores/ui'

const LEVELS: PriorityLevel[] = ['none', 'low', 'medium', 'high']

// A rule Lucid can't read can only be kept or removed (FR-17).
const NONE: readonly Recurrence[] = ['none']

// The chosen level in the colors of its chip in the task list.
const LEVEL_ON: Record<PriorityLevel, string> = {
  none: '',
  low: 'data-[state=on]:text-sky-800 dark:data-[state=on]:text-sky-300',
  medium: 'data-[state=on]:text-amber-800 dark:data-[state=on]:text-amber-300',
  high: 'data-[state=on]:text-destructive',
}

const DATES = {
  start: { date: 'startDate', time: 'startTime', zone: 'startZone', other: 'due' },
  due: { date: 'dueDate', time: 'dueTime', zone: 'dueZone', other: 'start' },
} as const

type Which = keyof typeof DATES

/**
 * What a save at a repeat of a series does (FR-17): the body it sends, what
 * the user did (`move` when the repeat's dates changed, `rule` when the rule
 * or a zone did, else `change`), whether the dates changed, which the toast
 * tells, which repeats it can reach, and the zones of the rows' fields before
 * and after, which "all repeats" from a later repeat moves the series by
 * (FR-18).
 */
interface SavePlan {
  input: TodoInput
  action: ScopeAction
  moved: boolean
  result: ScopeResult
  zones: Record<Which, RowZones>
}

/**
 * Edits a task in the editor dialog: title, notes, start and due date,
 * repeat, priority, checklist (FR-13, FR-14, FR-15, FR-16, FR-17). Also
 * creates one, from the create popover or switched from a new event.
 *
 * A series opens at a repeat: the one clicked, else its current one, with
 * that repeat's dates and title. Saving or deleting it asks in the footer
 * which repeats it reaches where there is a choice, says so beforehand where
 * there is one, and blocks Save with the reason where the series can't follow
 * the new dates (FR-17).
 */
export function TaskEditor({
  state,
  canSwitch,
  onDone,
  onScopeOpenChange,
}: {
  state: NonNullable<TaskEditorState>
  /** A new entry can be switched to an event. */
  canSwitch: boolean
  onDone: () => void
  /**
   * Reports how to cancel the footer question while it is open, or `null`
   * once it isn't, so the surrounding dialog can route Escape to it instead
   * of closing (NFR-27), as for the event editor.
   */
  onScopeOpenChange?: (cancel: (() => void) | null) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const prefs = usePrefs()
  const now = useNow()
  const todo = state.mode === 'edit' ? state.todo : undefined
  // The repeat of the series the editor is at (FR-17): the one clicked, else the current one; none
  // for a new task, one that does not repeat, and a series without an open repeat.
  const repeat = useMemo<TaskRepeat | null>(() => {
    if (state.mode !== 'edit') return null
    return state.repeat ? { ...state.repeat, todo: state.todo } : currentRepeat(state.todo)
  }, [state])
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
  // The writes of a series wait for its other writes (FR-17, NFR-26).
  // The editor says a conflict itself, in its footer (FR-09).
  const update = useUpdateTodo(todo?.id, { conflictNotice: true })
  const detach = useDetachTodo(todo?.id, { conflictNotice: true })
  const following = useTodoFollowing(todo?.id, { conflictNotice: true })
  const create = useCreateTodo()
  const del = useDeleteTodo(todo?.id)
  const skip = useSkipTodo(todo?.id)
  const end = useEndTodo(todo?.id)
  const qc = useQueryClient()
  // After a save refused as a conflict (FR-09): the ETag the task has now, `undefined` where its
  // reloaded list no longer holds it. The form keeps what was entered.
  const [conflict, setConflict] = useState<{ etag: string | undefined } | null>(null)
  const overwrites = conflict?.etag !== undefined
  const [newItem, setNewItem] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  // A save of a series waiting for the answer which repeats it reaches (FR-17): two options or more.
  const [asking, setAsking] = useState<{ plan: SavePlan; notes: ScopeNotes } | null>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const asked = useRef(false)
  const askedBefore = useRef(false)
  const openEditor = useUi((s) => s.openEditor)
  const kindRef = useRef<HTMLButtonElement>(null)

  // The values the editor opened with: at a repeat, its dates and its own title; the notes,
  // checklist, priority and repeat are the series' (FR-17).
  const [opened] = useState<TaskFormValues>(() =>
    state.mode === 'edit'
      ? taskToForm(repeat ? { ...state.todo, ...repeat.shown, title: repeat.title } : state.todo, tz, state.todo)
      : { ...taskForm(state.draft.title, state.draft.task), description: state.draft.description },
  )
  // The dates the editor opened with, which `opened` holds as fields: a save sends one back as it
  // is while its fields stay (#10, FR-18).
  const openedDates: TaskDates | undefined = repeat?.shown ?? todo
  const form = useForm<TaskFormValues>({
    resolver: zodResolver(buildTaskFormSchema(todo && { original: todo })),
    defaultValues: opened,
  })
  const { register, control, handleSubmit, formState, setValue, getValues, setFocus, subscribe, trigger } = form
  const checklist = useFieldArray({ control, name: 'checklist' })
  const [completed, startDate, startTime, dueDate, dueTime, items, recurrence, customRule, startZone, dueZone] = useWatch({
    control,
    name: [
      'completed',
      'startDate',
      'startTime',
      'dueDate',
      'dueTime',
      'checklist',
      'recurrence',
      'customRule',
      'startZone',
      'dueZone',
    ],
  })
  const values = {
    start: { date: startDate, time: startTime, zone: startZone },
    due: { date: dueDate, time: dueTime, zone: dueZone },
  }
  // A date or time field holding text it couldn't read (FR-09): the form can't be saved, and nothing is
  // read from it until it can.
  const readableDate = (date: string, time: string) => (date === '' || isFormDate(date)) && (time === '' || isFormTime(time))
  const readable = readableDate(startDate, startTime) && readableDate(dueDate, dueTime)
  // Overdue as the task list will show it once saved (FR-14).
  const entered = readable
    ? formToTodoInput({ ...getValues(), completed, startDate, startTime, dueDate, dueTime }, tz, undefined, openedDates)
    : null
  const overdue = entered !== null && isOverdue(entered, now)
  const setOpts = { shouldDirty: true, shouldValidate: formState.isSubmitted }

  // A rule Lucid can't read can't be completed or moved here, only removed (FR-17).
  const ruleUnsupported = todo?.ruleUnsupported ?? false
  // A repeat recurs from the start, else the due date; the presets and the repeat editor follow it, from the
  // last one that could be read while its field holds text it couldn't (FR-09). Without one, as after a switch of
  // the kind with a date its field couldn't read, from the other date, else today: never from the day such text
  // falls back to, 1 January 1970.
  const [anchorDate, anchorTime, otherDate, otherTime] = startDate
    ? [startDate, startTime, dueDate, dueTime]
    : [dueDate, dueTime, startDate, startTime]
  const readAnchor = useReadableStart(anchorDate, anchorTime, readableDate(anchorDate, anchorTime))
  const anchor = readAnchor ?? (isFormDate(otherDate) ? { date: otherDate, time: otherTime } : { date: '', time: '' })
  const anchorDay = anchor.date ? dayAt(anchor.date, anchor.time) : now
  // The series' rule as it opened recurs from the repeat's place in the rule instead, as far from there as the
  // form moves the repeat, as a save that keeps the rule moves the series (`taskRuleStart`), not where an override
  // moved it; a changed rule starts over at the dates entered (FR-17), as does one for a series of dates.
  const keptRule = buildRRule(opened.recurrence, opened.customRule)
  // Read on the wall clock of the zone the anchor's fields are in, which the series recurs in, and where the repeat
  // editor reads and builds the rule (FR-18).
  const anchorZone = fieldZone(startDate ? startZone : dueZone, tz)
  const keptStart = repeat && keptRule && entered ? taskRuleStart(repeat, entered, anchorZone) : null
  const kept = keptStart ? { rule: keptRule, start: keptStart } : undefined
  // The zones of the events and tasks loaded, which the zone fields' lists offer first (FR-18).
  const inUse = useZonesInUse(tz)
  // The rows with a time, which have a zone; a date has none (FR-18).
  const timedRows = (['start', 'due'] as const).filter((which) => values[which].time !== '')
  // The zone fields (FR-18): shown from the start for a task with a zone other than the browser's in a row, else
  // after "Other time zone", and then until the editor closes, also once every ✕ is used, so nothing jumps; each
  // while its row has a time.
  const [zonesShown, setZonesShown] = useState(
    () => !!todo && [opened.startZone, opened.dueZone].some((z) => z !== '' && !sameZone(z, tz)),
  )
  // "Other time zone" puts the focus in the zone field of the first row with a time, with its list open, as it shows
  // the field: once, not again where the row loses its time and gets one anew (NFR-27).
  const [revealing, setRevealing] = useState<Which | null>(null)
  if (revealing && values[revealing].time === '') setRevealing(null)
  // Whether a save gives a row with a time a new zone, which a series has one of for all its repeats: a change of the
  // rule's kind, `rule` (FR-17, FR-18).
  const zonesMoved = (v: TaskFormValues) => (v.startTime !== '' || v.dueTime !== '') && taskZonesChanged(v, opened)

  useEffect(() => {
    // The footer asks in place: focus its "Cancel", and "Delete task" again once it is back (NFR-27).
    if (confirmDelete) keepRef.current?.focus()
    else if (asked.current) deleteRef.current?.focus()
    asked.current = confirmDelete
  }, [confirmDelete])

  // The question which repeats a save reaches takes the focus itself; once it closes again, the
  // focus goes back to Save (NFR-27).
  useEffect(() => {
    if (asking) {
      askedBefore.current = true
    } else if (askedBefore.current) {
      saveRef.current?.focus()
      askedBefore.current = false
    }
  }, [asking])

  // Leaves the footer's question, of a save or a delete (FR-17).
  const cancelQuestion = useCallback(() => {
    setAsking(null)
    setConfirmDelete(false)
  }, [])

  // While the footer asks, Escape cancels the question rather than the editor: the surrounding
  // dialog routes it here (NFR-27).
  useEffect(() => {
    if (!asking && !confirmDelete) return
    onScopeOpenChange?.(cancelQuestion)
    return () => {
      onScopeOpenChange?.(null)
    }
  }, [asking, confirmDelete, cancelQuestion, onScopeOpenChange])

  // The question is about the values Save was pressed with (FR-17): any change to the form while
  // it is open cancels it, and the next Save asks again. The focus stays where the change is made.
  useEffect(() => {
    if (!asking) return
    return subscribe({
      formState: { values: true },
      callback: () => {
        askedBefore.current = false
        setAsking(null)
      },
    })
  }, [asking, subscribe])

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

  // The body of a save of `v`: for a series, with its own values where the user left them alone,
  // so a repeat's own title shown here is not taken for a change (FR-17).
  const editInput = (v: TaskFormValues): TodoInput => {
    const input = formToTodoInput(v, tz, todo, openedDates)
    return todo?.recurring ? seriesEditInput(todo, input, editedFields(opened, v)) : input
  }

  // What a save of `v` does at the repeat (FR-17), or null where it asks nothing: a task that is
  // not a series' repeat, and completing the current repeat, which goes on as before.
  const planSave = (v: TaskFormValues): SavePlan | null => {
    if (!todo || !repeat) return null
    const input = editInput(v)
    if (isSeriesCompletion(todo, input)) return null
    const moved = datesChanged(repeat.shown, input)
    // A new zone is the series', for all repeats or the following ones, as a new rule is (FR-17, FR-18).
    const action: ScopeAction = input.rrule !== undefined || zonesMoved(v) ? 'rule' : moved ? 'move' : 'change'
    const zones = {
      start: { shown: fieldZone(opened.startZone, tz), entered: fieldZone(v.startZone, tz) },
      due: { shown: fieldZone(opened.dueZone, tz), entered: fieldZone(v.dueZone, tz) },
    }
    return { input, action, moved, result: scopeOptions({ kind: 'task', action, item: repeat, to: input }), zones }
  }

  // A refused save says so, and the next one goes with the ETag the task has now: it replaces the
  // other change, as the footer says beforehand (FR-09).
  const written = (item: Todo): Todo => (conflict?.etag !== undefined ? { ...item, etag: conflict.etag } : item)
  const saved = {
    onSuccess: onDone,
    onError: (error: unknown) => {
      if (!todo || !isApiError(error, 'conflict')) return
      void reloadedTodoEtag(qc, todo).then((etag) => {
        setConflict({ etag })
      })
    },
  }

  // "Only this repeat" detaches the current repeat with the changes; "This and following repeats"
  // splits the series at a later one, from its new dates; "All repeats" saves the series, which
  // from a later repeat moves as far as that repeat moved (FR-17), into a new zone on its wall clock (FR-18).
  const saveScope = (scope: Scope, { input, moved, zones }: SavePlan) => {
    if (!todo || !repeat) return
    switch (scope) {
      case 'this':
        detach.mutate({ todo: written(todo), repeat, input, moved }, saved)
        break
      case 'following':
        following.mutate({ todo: written(todo), repeat, input, moved }, saved)
        break
      case 'all': {
        const later = repeat.at === 'upcoming'
        update.mutate(
          {
            todo: written(todo),
            input: later ? { ...input, ...allRepeatsDates(repeat, input, zones) } : input,
            byUpcoming: later,
            look: { slots: taskGlyphSlots('all', repeat.at) },
          },
          saved,
        )
        break
      }
    }
  }

  const onSubmit = handleSubmit((v) => {
    if (todo) {
      const plan = planSave(v)
      if (!plan) {
        update.mutate({ todo: written(todo), input: editInput(v) }, saved)
        return
      }
      // A save that changes nothing at a repeat writes nothing: "only this repeat" would make a task
      // of its own of it and move the series on (FR-17).
      if (plan.action === 'change' && !Object.values(editedFields(opened, v)).some(Boolean)) {
        onDone()
        return
      }
      // A series asks which repeats a save reaches only where there is a choice; the one thing it
      // can do, it does right away, as the footer said beforehand (FR-17).
      const { options, reason } = plan.result
      const [only] = options
      if (options.length > 1) {
        // Without a rule, the repeats after this one go.
        setAsking({ plan, notes: plan.action === 'rule' && plan.input.rrule?.trim() === '' ? 'ruleRemoved' : 'change' })
        return
      }
      if (only) {
        saveScope(only, plan)
        return
      }
      // Dates the series can't follow save nothing; the date field says why.
      if (reason) return
      // The last repeat acts as a single task.
      update.mutate({ todo: written(todo), input: plan.input }, saved)
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
  const pending = update.isPending || create.isPending || detach.isPending || following.isPending
  const deleting = del.isPending || skip.isPending || end.isPending

  const onChooseScope = (scope: Scope) => {
    if (!asking) return
    saveScope(scope, asking.plan)
    cancelQuestion()
  }

  // Which repeats deleting at the repeat can reach (FR-17): "only this repeat" skips the current
  // one, "this and following repeats" ends the series before a later one, "all repeats" deletes it.
  const deleteChoice: ScopeResult = repeat
    ? scopeOptions({ kind: 'task', action: 'delete', item: repeat })
    : { options: [] }
  const onChooseDelete = (scope: Scope) => {
    if (!todo || !repeat) return
    switch (scope) {
      case 'this':
        skip.mutate({ todo, repeat }, { onSuccess: onDone })
        break
      case 'following':
        end.mutate({ todo, repeat }, { onSuccess: onDone })
        break
      case 'all':
        del.mutate({ todo, look: { slots: taskGlyphSlots('all', repeat.at) } }, { onSuccess: onDone })
        break
    }
    setConfirmDelete(false)
  }

  // What Save reaches where there is no choice, said in the footer before it is pressed, or why the
  // series can't follow the dates, said under them (FR-17). Live with the form: the watched dates,
  // repeat and check re-render the editor whenever the answer can change.
  const live = readOnly || !readable ? null : planSave(getValues())
  const hint =
    live && repeat ? taskScopeHint(t, live.result, live.action, live.input.rrule?.trim() === '', repeat.at) : null
  const refused = live?.result.options.length === 0 ? live.result.reason : undefined
  const refusedRow: Which | null = refused ? (startDate ? 'start' : 'due') : null

  const setDate = (which: Which, date: string) => {
    const f = DATES[which]
    // A new date takes the other date's time, in its zone: RFC 5545 wants a time on both or neither (FR-18).
    const next = formWithDate(getValues(), which, date)
    setValue(f.time, next[f.time], setOpts)
    setValue(f.zone, next[f.zone], setOpts)
    setValue(f.date, date, setOpts)
  }

  const setTime = (which: Which, time: string) => {
    const other = DATES[DATES[which].other]
    // A time given or taken goes for the other date too, in its zone: RFC 5545 wants a time on both or neither
    // (FR-18).
    const next = formWithTime(getValues(), which, time)
    setValue(other.time, next[other.time], setOpts)
    setValue(other.zone, next[other.zone], setOpts)
    setValue(DATES[which].time, time, setOpts)
  }

  // A zone change keeps the clock times of the fields (FR-18); the start's takes the due along while that is in the
  // start's zone (`withTaskStartZone`). Where the start was said to lie after the due, that is judged anew.
  const setZone = (which: Which, zone: string) => {
    const v = getValues()
    const next = which === 'start' ? withTaskStartZone(v, zone) : { ...v, dueZone: zone }
    setValue('startZone', next.startZone, { shouldDirty: true })
    setValue('dueZone', next.dueZone, { shouldDirty: true })
    if (formState.isSubmitted) void trigger('startDate')
  }

  const clearDate = (which: Which) => {
    setValue(DATES[which].date, '', setOpts)
    setValue(DATES[which].time, '', setOpts)
  }

  // The values as a save would send them, read only while every date and time shown can be (FR-09), and only for a
  // row with a time.
  const current = { ...getValues(), completed, startDate, startTime, dueDate, dueTime, startZone, dueZone }
  const entry = readable && timedRows.length > 0 ? formToTodoInput(current, tz, todo, openedDates) : null
  const instant = (iso: string | null | undefined, allDay: boolean) => (iso && !allDay ? new Date(iso) : null)
  const startAt = entry && instant(entry.start, entry.startAllDay)
  const dueAt = entry && instant(entry.due, entry.dueAllDay)
  // Where the task lies for the browser, while a row with a time is in another zone (FR-18): from its start to its
  // due, or at the one of them it has, as a save writes them, once they can be read and the due isn't before the
  // start.
  const first = startAt ?? dueAt
  const yourZone = first
    ? inYourZone(t, prefs, now, {
        zones: timedRows.map((which) => values[which].zone),
        browserZone: tz,
        start: first,
        end: dueAt ?? first,
      })
    : null
  // A new zone is the whole series', all repeats' or the following ones' (FR-17, FR-18), said before Save asks.
  const seriesZone = !!repeat && zonesMoved(current)
  const zoneNotes =
    [yourZone && `${id}-in-your-zone`, seriesZone && `${id}-series-zone`].filter(Boolean).join(' ') || undefined
  // "Other time zone", quiet, while a row has a time and no zone field shows: a task in the browser's zone looks as
  // it always did (FR-18).
  const otherZone = !zonesShown && timedRows.length > 0 && !readOnly && !ruleUnsupported

  const msg = (m: string | undefined) => (m ? t(m as 'validation.date') : undefined)
  const titleError = msg(formState.errors.title?.message)
  const repeatError = msg(formState.errors.recurrence?.message)
  const itemError = msg(formState.errors.checklist?.message ?? formState.errors.checklist?.find?.((e) => e?.text)?.text?.message)

  const dateRow = (which: Which) => {
    const { date, time, zone } = values[which]
    const other = values[DATES[which].other].date
    // What to type where the date or the time can't be read, at once, not only after Save (FR-09): a note about
    // each, describing its field alone, the date's first where both can't be read (NFR-27).
    const dateUnread = unreadableNote(t, prefs, now, [{ date }])
    const timeUnread = date ? unreadableNote(t, prefs, now, [{ time }]) : undefined
    // An error of the dates, such as a start after the due; a date the field couldn't read is said by its note.
    const raw = formState.errors[DATES[which].date]?.message
    const error = raw === 'validation.date' ? undefined : msg(raw)
    // Why the series can't follow the dates: a limit, not an error, so said muted, with the field unmarked (FR-17).
    const refusal =
      !error && refused && which === refusedRow ? t('scope.hint.none', { reason: t(`scope.reason.${refused}`) }) : undefined
    const note = error ?? refusal
    // A time summer time skips on its date in its row's zone, and the one it is saved as (#10, FR-18).
    const saved = time ? skippedTime(date, time, fieldZone(zone, tz)) : null
    // The label keeps its own column, so on narrow screens the time wraps below the date, and the zone (FR-18) below
    // them where it doesn't fit; closer within the row than to the next one.
    return (
      <div className="grid grid-cols-[3rem_1fr] items-start gap-x-2 gap-y-1">
        <span id={`${id}-${which}-label`} className="flex h-9 items-center text-sm text-muted-foreground">
          {t(`tasks.${which}Label`)}
        </span>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
            placeholder={readOnly || ruleUnsupported ? t('tasks.noDate') : t('tasks.addDate')}
            month={isFormDate(other) ? parseDayKey(other) : undefined}
            prefs={prefs}
            now={now}
            invalid={!!error}
            describedBy={
              [dateUnread && `${id}-${which}-date-unread`, note && `${id}-${which}-error`].filter(Boolean).join(' ') ||
              undefined
            }
          />
          {date && (
            <TimeField
              value={time}
              onChange={(v) => {
                setTime(which, v)
              }}
              clearLabel={which === 'start' ? t('tasks.removeStartTime') : t('tasks.removeDueTime')}
              placeholder={t('tasks.addTime')}
              prefs={prefs}
              invalid={!!error}
              describedBy={
                [timeUnread && `${id}-${which}-time-unread`, error && `${id}-${which}-error`, saved && `${id}-${which}-skipped`]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
              aria-label={t(`tasks.${which}Time`)}
            />
          )}
          {/* The zone follows the time in its row, and wraps with it (FR-18). */}
          {zonesShown && time !== '' && (
            <ZoneField
              value={zone}
              onChange={(next) => {
                setZone(which, next)
              }}
              // The ✕: no zone for a single task, the browser's for a series, which needs one (FR-18). A row without a
              // zone has no ✕: a save gives it none in a single task and the browser's in a series, as the ✕ would.
              clearTo={recurrence !== 'none' && zone !== '' ? tz : ''}
              browserZone={tz}
              date={date}
              inUse={inUse}
              prefs={prefs}
              autoFocus={revealing === which}
              describedBy={zoneNotes}
              aria-label={t(`tasks.${which}Zone`)}
            />
          )}
          {which === 'due' && overdue && <span className="text-sm font-medium text-destructive">{t('tasks.overdue')}</span>}
        </div>
        {dateUnread && (
          <p id={`${id}-${which}-date-unread`} className="col-start-2 text-sm text-destructive">
            {dateUnread}
          </p>
        )}
        {timeUnread && (
          <p id={`${id}-${which}-time-unread`} className="col-start-2 text-sm text-destructive">
            {timeUnread}
          </p>
        )}
        {note && (
          <p id={`${id}-${which}-error`} className={cn('col-start-2 text-sm', error ? 'text-destructive' : 'text-muted-foreground')}>
            {note}
          </p>
        )}
        {saved && (
          <SkippedTimeNote
            id={`${id}-${which}-skipped`}
            time={time}
            saved={saved}
            prefs={prefs}
            className="col-start-2 text-muted-foreground"
          />
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
                // Repeats are completed in order: a later one only once the ones before it are done (FR-17).
                disabled={readOnly || ruleUnsupported || repeat?.at === 'upcoming'}
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
          {ruleUnsupported && <p className="text-sm">{t('tasks.ruleUnsupported')}</p>}
        </div>
        <DialogClose className="absolute top-3 right-3 rounded-md p-1.5 transition-colors outline-none hover:bg-current/10 focus-visible:ring-[3px] focus-visible:ring-current/50 [&_svg]:size-4">
          <XIcon aria-hidden />
          <span className="sr-only">{t('common.close')}</span>
        </DialogClose>
      </div>

      {/* A read-only list disables the fields, but not the ⓘ: the repeat row stays outside the disabled fieldsets. */}
      <div className="grid gap-3 px-4 pt-5 pb-2 sm:px-6">
        <EditorRow icon={<ClockIcon />}>
          <fieldset className="grid gap-2" disabled={readOnly || ruleUnsupported}>
            <legend className="sr-only">{t('tasks.when')}</legend>
            {dateRow('start')}
            {dateRow('due')}
            {/* Under the rows, in the fields' column: quiet, as the zone fields only show where they say something. */}
            {otherZone && (
              <div className="grid grid-cols-[3rem_1fr] gap-x-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="col-start-2 justify-self-start font-normal text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setZonesShown(true)
                    setRevealing(timedRows[0] ?? null)
                  }}
                >
                  <GlobeIcon aria-hidden />
                  {t('zone.other')}
                </Button>
              </div>
            )}
            {/* About all the rows, under them, as in the event editor. */}
            {yourZone && (
              <p id={`${id}-in-your-zone`} className="tabular text-sm text-muted-foreground">
                {yourZone}
              </p>
            )}
            {seriesZone && (
              <p id={`${id}-series-zone`} className="text-sm text-muted-foreground">
                {t('zone.seriesTask')}
              </p>
            )}
          </fieldset>
        </EditorRow>

        <EditorRow icon={<RepeatIcon />}>
          <div className="flex items-center gap-1">
            <Label htmlFor={`${id}-repeat`} className="sr-only">
              {t('tasks.repeat')}
            </Label>
            <RepeatField
              id={`${id}-repeat`}
              value={{ recurrence, customRule }}
              onChange={(v) => {
                setValue('recurrence', v.recurrence, setOpts)
                setValue('customRule', v.customRule, setOpts)
              }}
              start={anchorDay}
              timeZone={anchorZone}
              presets={ruleUnsupported ? NONE : RECURRENCE_PRESETS}
              customizable={!ruleUnsupported && !readOnly}
              kept={kept}
              explicit={todo?.recurring ?? false}
              disabled={readOnly}
              invalid={!!repeatError}
              describedBy={repeatError ? `${id}-repeat-error` : undefined}
            />
            {/* How repeating tasks behave, for those who want to know; the rest of the UI only shows it (FR-17). */}
            {recurrence !== 'none' && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label={t('tasks.repeatInfo')}
                  >
                    <InfoIcon aria-hidden />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="grid gap-2 text-sm" aria-labelledby={`${id}-repeat-info`}>
                  <h3 id={`${id}-repeat-info`} className="font-semibold">
                    {t('tasks.repeatInfo')}
                  </h3>
                  <p>{t('tasks.repeatInfoDone')}</p>
                  <p>{t('tasks.repeatInfoOrder')}</p>
                </PopoverContent>
              </Popover>
            )}
          </div>
          {repeatError && (
            <p id={`${id}-repeat-error`} className="pt-1 text-sm text-destructive">
              {repeatError}
            </p>
          )}
        </EditorRow>

        <fieldset disabled={readOnly} className="grid gap-3">
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
      </div>

      <DialogFooter className="sticky bottom-0 bg-surface px-4 pt-3 pb-4 sm:flex-wrap sm:justify-between sm:px-6 sm:pb-5">
        <ConflictNotice id={`${id}-conflict`} state={conflict && !confirmDelete ? (overwrites ? 'replace' : 'reopen') : null} />
        {asking && repeat ? (
          // Replaces the buttons in place while a save asks which repeats it reaches (FR-17);
          // Escape cancels just this, not the editor (NFR-27).
          <div className="w-full">
            <ScopeChoice
              question={t(asking.plan.action === 'move' ? 'scope.task.move' : 'scope.task.change')}
              items={taskScopeItems(t, repeat, asking.plan.result.options, prefs, now, asking.notes)}
              color={colors.solid}
              // A save without a rule removes the upcoming repeats, and asks like a delete (FR-17).
              tone={asking.notes === 'ruleRemoved' ? 'destructive' : 'default'}
              missing={taskScopeMissing(t, asking.plan.result)}
              onChoose={onChooseScope}
              onCancel={cancelQuestion}
            />
          </div>
        ) : confirmDelete && repeat && deleteChoice.options.length > 1 ? (
          <div className="w-full">
            <ScopeChoice
              question={t('scope.task.delete')}
              items={taskScopeItems(t, repeat, deleteChoice.options, prefs, now, 'delete')}
              color={colors.solid}
              tone="destructive"
              missing={taskScopeMissing(t, deleteChoice)}
              onChoose={onChooseDelete}
              onCancel={cancelQuestion}
            />
          </div>
        ) : confirmDelete ? (
          <div role="alert" className="flex w-full flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {/* The last repeat is deleted like a single task; a series where deleting reaches all repeats says so. */}
              {todo?.recurring && !repeat?.last ? t('tasks.confirmDeleteSeries') : t('tasks.confirmDelete')}
            </p>
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
                  if (todo) del.mutate({ todo }, { onSuccess: onDone })
                }}
              >
                {del.isPending && <Spinner />}
                {t('tasks.delete')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {hint && (
              // A line of its own above the buttons, with "Delete task" beside them; on narrow
              // screens, where they stack, above them too. Save names it as its description (NFR-27).
              <p
                id={`${id}-hint`}
                className="flex items-center gap-2 text-xs font-medium text-muted-foreground max-sm:order-last sm:basis-full"
              >
                <ScopeGlyph slots={hint.slots} tone={hint.tone} color={colors.solid} className="shrink-0" />
                {hint.text}
              </p>
            )}
            {readOnly || !todo ? (
              <span />
            ) : (
              <Button
                ref={deleteRef}
                type="button"
                variant="ghost"
                className="text-destructive"
                disabled={deleting}
                onClick={() => {
                  setConfirmDelete(true)
                }}
              >
                {deleting ? <Spinner /> : <Trash2Icon aria-hidden />}
                {t('tasks.delete')}
              </Button>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" onClick={onDone}>
                {readOnly ? t('common.close') : t('common.cancel')}
              </Button>
              {!readOnly && (
                <Button
                  ref={saveRef}
                  type="submit"
                  // Dates the series can't follow save nothing until they change (FR-17).
                  disabled={pending || !calendarId || refused !== undefined}
                  aria-describedby={
                    [conflict && `${id}-conflict`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined
                  }
                >
                  {pending && <Spinner />}
                  {todo ? (overwrites ? t('common.saveAnyway') : t('common.save')) : t('tasks.createAction')}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogFooter>
    </form>
  )
}
