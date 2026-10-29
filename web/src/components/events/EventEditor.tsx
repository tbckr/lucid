import { zodResolver } from '@hookform/resolvers/zod'
import { AlignLeftIcon, ClockIcon, GlobeIcon, MapPinIcon, RepeatIcon, XIcon } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { ConflictNotice } from '@/components/ConflictNotice'
import { KindSwitch } from '@/components/create/KindSwitch'
import { RepeatField } from '@/components/recurrence/RepeatField'
import { ScopeChoice } from '@/components/scope/ScopeChoice'
import { ScopeGlyph } from '@/components/scope/ScopeGlyph'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  reloadedEventEtag,
  useCreateEvent,
  useUpdateEvent,
  useUpdateFollowing,
  useUpdateOccurrence,
  useVisibleCalendars,
  useZonesInUse,
} from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { usePrefs } from '@/hooks/usePrefs'
import { isApiError } from '@/lib/api/client'
import { type Calendar, type EventInput } from '@/lib/api/schemas'
import { dayAt, dayKey, isFormDate, isFormTime, parseDayKey, skippedTime } from '@/lib/dates'
import {
  editFormValues,
  eventFormSchema,
  formDuration,
  formToInput,
  keepsRuleAndAllDay,
  occurrenceInput,
  shiftEnd,
  withStartZone,
  zonesChanged,
  type EventFormValues,
} from '@/lib/eventForm'
import { type CalEvent } from '@/lib/events'
import { formatDuration, inYourZone } from '@/lib/format'
import { browserTimeZone } from '@/lib/locale'
import { chooseCalendar, eventForm, switchDraft, writableFor } from '@/lib/quickCreate'
import { eventOffRule } from '@/lib/recurrence'
import { RECURRENCE_PRESETS } from '@/lib/rrule'
import { eventRuleStart } from '@/lib/seriesShift'
import {
  eventScopeHint,
  eventScopeItems,
  eventScopeMissing,
  scopeOptions,
  type Scope,
  type ScopeAction,
  type ScopeNotes,
  type ScopeResult,
} from '@/lib/scope'
import { unreadableNote } from '@/lib/unreadable'
import { cn } from '@/lib/utils'
import { fieldZone, sameZone } from '@/lib/zones'
import { useUi, type EditorState } from '@/stores/ui'
import { DateField } from './DateField'
import { EditorRow, quietField } from './EditorRow'
import { SkippedTimeNote } from './SkippedTimeNote'
import { TimeField } from './TimeField'
import { useReadableStart } from './useTypedField'
import { ZoneField } from './ZoneField'

/** Creates and edits events in the editor dialog (FR-09, FR-11). */
export function EventEditor({
  editor,
  canSwitch,
  onDone,
  onScopeOpenChange,
}: {
  editor: NonNullable<EditorState>
  /** A new entry can be switched to a task. */
  canSwitch: boolean
  onDone: () => void
  /**
   * Reports how to cancel the save scope question while it is open, or
   * `null` once it isn't, so the surrounding dialog can route Escape to it
   * instead of closing (NFR-27): Radix's dismissable layer handles Escape on
   * the document before this component's own handler would run.
   */
  onScopeOpenChange?: (cancel: (() => void) | null) => void
}) {
  const { all, visible } = useVisibleCalendars()
  const calendars = useMemo(() => writableFor('event', all), [all])
  const current = editor.mode === 'create' ? editor.draft.calendarId : ''
  const preferred = chooseCalendar('event', { all, visible, taskList: '', current })
  return (
    <EditorForm
      editor={editor}
      calendars={calendars}
      defaultCalendarId={preferred?.id ?? ''}
      canSwitch={canSwitch}
      onDone={onDone}
      onScopeOpenChange={onScopeOpenChange}
    />
  )
}

function EditorForm({
  editor,
  calendars,
  defaultCalendarId,
  canSwitch,
  onDone,
  onScopeOpenChange,
}: {
  editor: NonNullable<EditorState>
  calendars: Calendar[]
  defaultCalendarId: string
  canSwitch: boolean
  onDone: () => void
  onScopeOpenChange?: (cancel: (() => void) | null) => void
}) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const colorsOf = useCalendarColors()
  const tz = useMemo(() => browserTimeZone(), [])
  const now = useMemo(() => new Date(), [])
  const event = editor.mode === 'edit' ? editor.event : undefined
  // Only an occurrence of a series asks which events a save changes, or says it beforehand (FR-17).
  const occurrence = event?.recurring && event.recurrenceId ? event : undefined
  // A save of a series waits for its other writes, and takes the ETag they got (FR-17).
  const series = event?.recurring ? event.id : undefined
  const create = useCreateEvent()
  // The editor says a conflict itself, in its footer (FR-09).
  const update = useUpdateEvent(series, { conflictNotice: true })
  const updateOccurrence = useUpdateOccurrence(series, { conflictNotice: true })
  const updateFollowing = useUpdateFollowing(series, { conflictNotice: true })
  const id = useId()
  const qc = useQueryClient()
  const openTaskEditor = useUi((s) => s.openTaskEditor)
  const kindRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const askedBefore = useRef(false)
  // The editor's values when it opened, to tell whether the rule, the all-day flag or a zone changed (FR-17, FR-18).
  const initial = event ? editFormValues(event, tz) : null
  // What a changed repeat does to this event where it doesn't fall on it, which the repeat editor says (#11), its
  // old rule read in the zone the series' start was in (FR-18).
  const offRule = eventOffRule(event, prefs.weekStartsOn, fieldZone(initial?.startZone ?? '', tz))
  // The zones of the events and tasks loaded, which the zone fields' lists offer first (FR-18).
  const inUse = useZonesInUse(tz)
  // The zone fields (FR-18): shown from the start for an event with a zone other than the browser's in a row, else
  // after "Other time zone", and then until the editor closes, also once every ✕ is used, so nothing jumps.
  const [zonesShown, setZonesShown] = useState(
    () => !!initial && !initial.allDay && [initial.startZone, initial.endZone].some((z) => z !== '' && !sameZone(z, tz)),
  )
  // "Other time zone" puts the focus in the start's zone field with its list open, as it shows the field: once, not
  // again where All day hides the field and shows it anew (NFR-27).
  const [revealing, setRevealing] = useState(false)
  // After a save refused as a conflict (FR-09): the ETag the event has now, `undefined` where the
  // reloaded calendar no longer holds it. The form keeps what was entered.
  const [conflict, setConflict] = useState<{ etag: string | undefined } | null>(null)
  const overwrites = conflict?.etag !== undefined
  // A save of a series waiting for the answer which events change (FR-17): what it saves, the
  // options, two or more, what took "This and following events" away, and what the notes say it
  // does.
  const [asking, setAsking] = useState<{
    input: EventInput
    options: Scope[]
    missing?: ScopeResult['missing']
    notes: ScopeNotes
  } | null>(null)

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventFormSchema),
    defaultValues:
      editor.mode === 'edit'
        ? editFormValues(editor.event, tz)
        : { ...eventForm(editor.draft.title, defaultCalendarId, editor.draft.event), description: editor.draft.description },
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  })
  const { register, control, handleSubmit, setValue, getValues, setFocus, subscribe, trigger, formState } = form
  const [allDay, recurrence, customRule, calendarId, startDate, startTime, endDate, endTime, startZone, endZone] = useWatch({
    control,
    name: ['allDay', 'recurrence', 'customRule', 'calendarId', 'startDate', 'startTime', 'endDate', 'endTime', 'startZone', 'endZone'],
  })
  const pending = create.isPending || update.isPending || updateOccurrence.isPending || updateFollowing.isPending
  const colors = colorsOf(calendarId)
  const calendar = calendars.find((c) => c.id === calendarId)
  const duration = formDuration({ allDay, startDate, startTime, endDate, endTime, startZone, endZone }, tz)
  // The start as far as it can be read: while its field holds text it couldn't read, the last one that
  // could, which the end keeps its length from (FR-09).
  const readStart = useReadableStart(startDate, startTime, isFormDate(startDate) && (allDay || isFormTime(startTime)))
  // Where the repeat recurs from, with its time: a rule's hours repeat at its minute (FR-17). For an
  // occurrence its place in the rule, as far from there as the form moves it, where a save moves the
  // series (`eventRuleStart`), not where an exception moved it; else the start as the form shows it.
  // Without a start that could be read, as after a switch of the kind with a start date its field
  // couldn't read, the end, else today: never the day such text falls back to, 1 January 1970 (FR-09).
  const anchor =
    readStart ?? (isFormDate(endDate) ? { date: endDate, time: endTime } : { date: dayKey(now), time: startTime })
  // The fields' wall clock, in the zone of the start's fields, where the repeat is read and built (FR-18).
  const ruleZone = fieldZone(startZone, tz)
  const entered = allDay ? parseDayKey(anchor.date) : dayAt(anchor.date, anchor.time)
  // A time summer time skips on its date in its row's zone, and the one it is saved as, said under its row (#10,
  // FR-18).
  const startSaved = allDay ? null : skippedTime(startDate, startTime, ruleZone)
  const endSaved = allDay ? null : skippedTime(endDate, endTime, fieldZone(endZone, tz))
  const start = occurrence ? eventRuleStart(occurrence, entered, allDay, ruleZone) : entered
  // The zone fields go with the times, which All day hides (FR-18). A field All day hid takes no focus as it shows
  // again.
  const zoneFields = zonesShown && !allDay
  if (allDay && revealing) setRevealing(false)

  // A new entry starts in its title, not in the switch before it; after a switch, the focus stays there (NFR-27).
  useEffect(() => {
    if (editor.mode !== 'create') return
    if (editor.switched) kindRef.current?.focus()
    else setFocus('title')
  }, [editor, setFocus])

  // The footer's scope question takes the focus itself; once it closes again, the focus goes back
  // to Save (NFR-27).
  useEffect(() => {
    if (asking) {
      askedBefore.current = true
    } else if (askedBefore.current) {
      saveRef.current?.focus()
      askedBefore.current = false
    }
  }, [asking])

  const toTask = () => {
    if (editor.mode !== 'create') return
    const v = getValues()
    // A calendar the user chose goes along; the editor's own choice follows the kind (`chooseCalendar`).
    const chosen = v.calendarId === formState.defaultValues?.calendarId ? editor.draft.calendarId : v.calendarId
    const when = { allDay, startDate, startTime, endDate, endTime }
    const draft = { ...editor.draft, title: v.title, description: v.description, calendarId: chosen, event: when }
    openTaskEditor({ mode: 'create', switched: true, draft: switchDraft(draft, 'task') })
  }

  // Moving the start keeps the length, from the last start that could be read; without one, the end stays
  // (FR-09).
  const onStartChange = (date: string, time: string) => {
    const from = readStart ? { startDate: readStart.date, startTime: readStart.time } : {}
    const next = shiftEnd({ ...getValues(), ...from }, date, time, tz)
    setValue('startDate', date, { shouldDirty: true })
    setValue('startTime', time, { shouldDirty: true })
    setValue('endDate', next.endDate, { shouldDirty: true, shouldValidate: formState.isSubmitted })
    setValue('endTime', next.endTime, { shouldDirty: true, shouldValidate: formState.isSubmitted })
  }

  // A zone change keeps the clock times of the fields (FR-18); the start's takes the end along while that is in the
  // start's zone (`withStartZone`). Where the end was said to lie before the start, that is judged anew.
  const onZonesChange = (zones: Pick<EventFormValues, 'startZone' | 'endZone'>) => {
    setValue('startZone', zones.startZone, { shouldDirty: true })
    setValue('endZone', zones.endZone, { shouldDirty: true })
    if (formState.isSubmitted) void trigger('endDate')
  }

  // Leaves the scope question and tells the surrounding dialog it no longer needs to catch
  // Escape for it (NFR-27).
  const cancelAsk = useCallback(() => {
    setAsking(null)
    onScopeOpenChange?.(null)
  }, [onScopeOpenChange])

  // The question is about the values Save was pressed with (FR-17): any change to the form
  // while it is open cancels it, and the next Save asks again about the new values, or saves
  // them right away. The focus stays where the change is made.
  useEffect(() => {
    if (!asking) return
    return subscribe({
      formState: { values: true },
      callback: () => {
        askedBefore.current = false
        cancelAsk()
      },
    })
  }, [asking, subscribe, cancelAsk])

  // What a save of `values` does to the series (FR-17): a changed rule, all-day flag or zone is a `rule`
  // change, as a series has one zone for all its events (FR-18), anything else a `change`.
  const saveAction = (values: EventFormValues): ScopeAction =>
    initial && keepsRuleAndAllDay(values, initial) && !zonesChanged(values, initial) ? 'change' : 'rule'

  // Which events of a series a save of `values` (sent as `input`) can reach (FR-17): a changed
  // rule, all-day flag or zone this and the following events' or the whole series', and a day the
  // series can't follow only this event's. Empty for anything but an occurrence of a series.
  const saveScopes = (values: EventFormValues, input: EventInput): ScopeResult =>
    occurrence
      ? scopeOptions({ kind: 'event', action: saveAction(values), item: occurrence, to: new Date(input.start) })
      : { options: [] }

  // A refused save says so, and the next one goes with the ETag the event has now: it replaces the
  // other change, as the footer says beforehand (FR-09).
  const written = (e: CalEvent): CalEvent => (conflict?.etag !== undefined ? { ...e, etag: conflict.etag } : e)
  const saved = {
    onSuccess: onDone,
    onError: (error: unknown) => {
      if (!event || !isApiError(error, 'conflict')) return
      void reloadedEventEtag(qc, event).then((etag) => {
        setConflict({ etag })
      })
    },
  }

  // "Only this event" saves an override of the occurrence; "This and following events" splits the
  // series there, and "All events" saves the series (FR-17).
  const saveScope = (scope: Scope, e: CalEvent, input: EventInput) => {
    switch (scope) {
      case 'this':
        updateOccurrence.mutate({ event: written(e), input: occurrenceInput(input) }, saved)
        break
      case 'following':
        updateFollowing.mutate({ event: written(e), input }, saved)
        break
      case 'all':
        update.mutate({ event: written(e), input }, saved)
        break
    }
  }

  const onSubmit = handleSubmit((values) => {
    const input = formToInput(values, tz, event)
    if (event) {
      // A series asks which events to change only when there is a choice (FR-17). The one thing
      // a save can do, it does right away; the footer has said which beforehand.
      const { options, missing } = saveScopes(values, input)
      const [only] = options
      if (options.length > 1) {
        // Without a rule, the series' events but this one go, from here on or all (FR-17).
        const notes = saveAction(values) === 'rule' && values.recurrence === 'none' ? 'ruleRemoved' : 'change'
        setAsking({ input, options, missing, notes })
        onScopeOpenChange?.(cancelAsk)
        return
      }
      if (only) {
        saveScope(only, event, input)
        return
      }
    }
    if (event) {
      update.mutate({ event: written(event), input }, saved)
    } else {
      create.mutate({ calendarId: values.calendarId, input }, { onSuccess: onDone })
    }
  })

  const onChooseScope = (scope: Scope) => {
    if (!event || !asking) return
    saveScope(scope, event, asking.input)
    cancelAsk()
  }

  const err = (key: keyof EventFormValues) => {
    const m = formState.errors[key]?.message
    return m ? t(m as 'validation.date') : undefined
  }

  const repeatOpts = { shouldDirty: true, shouldValidate: formState.isSubmitted }

  if (calendars.length === 0 && !event) {
    return (
      <div className="grid gap-4 p-6">
        <DialogHeader>
          <DialogTitle>{t('event.new')}</DialogTitle>
          <DialogDescription>{t('event.noWritableCalendar')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onDone}>{t('common.close')}</Button>
        </DialogFooter>
      </div>
    )
  }

  // What to type where a date or time field holds text it couldn't read, said below its row at once,
  // not only after Save (FR-09). A time All day hides isn't asked for. Each note is about one field and
  // describes it alone: where both can't be read, the date's comes first (NFR-27).
  const notesOf = (date: string, time: string) => ({
    date: unreadableNote(t, prefs, now, [{ date }]),
    time: allDay ? undefined : unreadableNote(t, prefs, now, [{ time }]),
  })
  const startNotes = notesOf(startDate, startTime)
  const endNotes = notesOf(endDate, endTime)
  const unread = [startNotes.date, startNotes.time, endNotes.date, endNotes.time].some(Boolean)
  // The values as a save would send them, read only while every date and time shown can be (FR-09).
  const formValues = getValues()
  const readable = isFormDate(startDate) && isFormDate(endDate) && (allDay || (isFormTime(startTime) && isFormTime(endTime)))
  const entry = !unread && readable ? formToInput(formValues, tz, event) : null

  // What Save reaches when there is no choice (FR-17), said in the footer before it is pressed. Live
  // with the form: the watched fields above re-render the editor whenever the answer can change.
  // Only for an occurrence of a series, and while every field can be read.
  const hint = occurrence && entry ? eventScopeHint(t, saveScopes(formValues, entry), recurrence === 'none') : null
  // Where the event lies for the browser, while a row's fields are in another zone (FR-18): the instants a save
  // writes, once the times can be read and the end isn't before the start.
  const yourZone =
    !allDay && entry && duration
      ? inYourZone(t, prefs, now, {
          zones: [startZone, endZone],
          browserZone: tz,
          start: new Date(entry.start),
          end: new Date(entry.end),
        })
      : null
  // A new zone is the whole series', all events' or the following ones' (FR-17, FR-18), said before Save asks.
  const seriesZone = !!occurrence && !allDay && !!initial && zonesChanged({ startZone, endZone }, initial)
  const zoneNotes = described(yourZone && `${id}-in-your-zone`, seriesZone && `${id}-series-zone`)
  // The ✕ of a zone field: no zone for a single event, the browser's for a series, which needs one (FR-18). A row
  // without a zone has no ✕: a save gives it none in a single event and the browser's in a series, as the ✕ would.
  const clearZoneTo = (zone: string) => (recurrence !== 'none' && zone !== '' ? tz : '')

  const titleError = err('title')
  // An end before the start, which is only judged once every date and time can be read; an end date the
  // field couldn't read is said by its note.
  const endOrder = formState.errors.endDate?.message === 'validation.endBeforeStart' ? err('endDate') : undefined

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      {/* The event as it will appear in the calendar: its calendar's tint and bar. */}
      <div
        className="relative grid gap-2 border-l-4 pt-5 pr-14 pb-4 pl-11 transition-colors duration-200 sm:pl-[3.25rem]"
        style={{ backgroundColor: colors.tint, color: colors.onTint, borderLeftColor: colors.solid }}
      >
        <DialogTitle className="sr-only">{event ? t('event.edit') : t('event.new')}</DialogTitle>
        <DialogDescription className="sr-only">{t('event.dialogDescription')}</DialogDescription>
        {!event && canSwitch && <KindSwitch ref={kindRef} kind="event" onSwitch={toTask} className="mb-0.5" />}
        <Label htmlFor={`${id}-title`} className="sr-only">
          {t('event.title')}
        </Label>
        <input
          id={`${id}-title`}
          placeholder={t('event.titlePlaceholder')}
          autoComplete="off"
          className="w-full border-b-2 border-transparent bg-transparent pb-0.5 font-display text-2xl leading-tight font-semibold tracking-tight outline-none placeholder:text-current placeholder:opacity-60 focus-visible:border-current aria-invalid:border-destructive"
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? `${id}-title-error` : undefined}
          {...register('title')}
        />
        {titleError && (
          <p id={`${id}-title-error`} className="text-sm font-medium text-destructive">
            {titleError}
          </p>
        )}
        {event ? (
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: colors.solid }} aria-hidden />
            <span className="sr-only">{t('event.calendar')}: </span>
            {calendar?.name ?? t('event.unknownCalendar')}
          </p>
        ) : (
          <div className="flex">
            <Label htmlFor={`${id}-calendar`} className="sr-only">
              {t('event.calendar')}
            </Label>
            <Controller
              control={control}
              name="calendarId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger
                    id={`${id}-calendar`}
                    className="-ml-2 h-8 w-auto border-transparent bg-transparent px-2 font-medium text-current hover:border-current/25 data-[placeholder]:text-current"
                    aria-invalid={formState.errors.calendarId ? true : undefined}
                  >
                    <SelectValue placeholder={t('event.chooseCalendar')} />
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
            />
          </div>
        )}
        {err('calendarId') && <p className="text-sm font-medium text-destructive">{err('calendarId')}</p>}
        <DialogClose className="absolute top-3 right-3 rounded-md p-1.5 transition-colors outline-none hover:bg-current/10 focus-visible:ring-[3px] focus-visible:ring-current/50 [&_svg]:size-4">
          <XIcon aria-hidden />
          <span className="sr-only">{t('common.close')}</span>
        </DialogClose>
      </div>

      <div className="grid gap-3 px-4 pt-5 pb-2 sm:px-6">
        <EditorRow icon={<ClockIcon />}>
          <fieldset className="grid gap-2">
            <legend className="sr-only">{t('event.when')}</legend>
            {/* Narrow screens drop the visible Start/End labels, like mobile calendars; the order says it. What wraps,
                such as a zone field (FR-18), lines up with the fields, not the label. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:pl-14">
              <span id={`${id}-starts`} className="w-12 text-sm text-muted-foreground max-sm:sr-only sm:-ml-14">
                {t('event.starts')}
              </span>
              <DateField
                id={`${id}-start`}
                labelledBy={`${id}-starts`}
                label={t('event.startDate')}
                value={startDate}
                onChange={(d) => {
                  onStartChange(d, getValues('startTime'))
                }}
                prefs={prefs}
                now={now}
                describedBy={startNotes.date && `${id}-start-date-error`}
              />
              {!allDay && (
                <TimeField
                  value={startTime}
                  onChange={(v) => {
                    onStartChange(getValues('startDate'), v)
                  }}
                  prefs={prefs}
                  describedBy={described(startNotes.time && `${id}-start-time-error`, startSaved && `${id}-start-skipped`)}
                  aria-label={t('event.startTime')}
                />
              )}
              {/* The zone follows the time in its row, and wraps with it (FR-18). */}
              {zoneFields && (
                <ZoneField
                  value={startZone}
                  onChange={(zone) => {
                    onZonesChange(withStartZone(getValues(), zone))
                  }}
                  clearTo={clearZoneTo(startZone)}
                  browserZone={tz}
                  date={startDate}
                  inUse={inUse}
                  prefs={prefs}
                  autoFocus={revealing}
                  describedBy={zoneNotes}
                  aria-label={t('event.startZone')}
                />
              )}
            </div>
            <UnreadNotes notes={startNotes} id={`${id}-start`} />
            {startSaved && (
              <SkippedTimeNote
                id={`${id}-start-skipped`}
                time={startTime}
                saved={startSaved}
                prefs={prefs}
                className="text-muted-foreground"
              />
            )}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:pl-14">
              <span id={`${id}-ends`} className="w-12 text-sm text-muted-foreground max-sm:sr-only sm:-ml-14">
                {t('event.ends')}
              </span>
              <Controller
                control={control}
                name="endDate"
                render={({ field }) => (
                  <DateField
                    id={`${id}-end`}
                    labelledBy={`${id}-ends`}
                    label={t('event.endDate')}
                    value={field.value}
                    onChange={(d) => {
                      field.onChange(d)
                    }}
                    prefs={prefs}
                    now={now}
                    quiet={field.value === startDate}
                    invalid={!!endOrder}
                    describedBy={described(endNotes.date && `${id}-end-date-error`, endOrder && `${id}-end-order`)}
                  />
                )}
              />
              {!allDay && (
                <Controller
                  control={control}
                  name="endTime"
                  render={({ field }) => (
                    <TimeField
                      value={field.value}
                      onChange={(v) => {
                        field.onChange(v)
                      }}
                      prefs={prefs}
                      invalid={!!endOrder}
                      describedBy={described(
                        endNotes.time && `${id}-end-time-error`,
                        endOrder && `${id}-end-order`,
                        endSaved && `${id}-end-skipped`,
                      )}
                      aria-label={t('event.endTime')}
                    />
                  )}
                />
              )}
              {zoneFields && (
                <ZoneField
                  value={endZone}
                  onChange={(zone) => {
                    onZonesChange({ startZone: getValues('startZone'), endZone: zone })
                  }}
                  clearTo={clearZoneTo(endZone)}
                  browserZone={tz}
                  date={endDate}
                  inUse={inUse}
                  prefs={prefs}
                  describedBy={zoneNotes}
                  aria-label={t('event.endZone')}
                />
              )}
              {duration && !('days' in duration && duration.days === 1) && (
                <span className="tabular pl-1 text-sm text-muted-foreground">{formatDuration(duration, prefs)}</span>
              )}
            </div>
            {endSaved && (
              <SkippedTimeNote
                id={`${id}-end-skipped`}
                time={endTime}
                saved={endSaved}
                prefs={prefs}
                className="text-muted-foreground"
              />
            )}
            <UnreadNotes notes={endNotes} id={`${id}-end`} />
            {endOrder && (
              <p id={`${id}-end-order`} className="text-sm text-destructive">
                {endOrder}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
              <div className="flex items-center gap-2">
                <Controller
                  control={control}
                  name="allDay"
                  render={({ field }) => (
                    <Switch id={`${id}-allday`} checked={field.value} onCheckedChange={field.onChange} />
                  )}
                />
                <Label htmlFor={`${id}-allday`} className="font-normal">
                  {t('event.allDay')}
                </Label>
              </div>
              {/* Quiet, while no zone field shows: an event in the browser's zone looks as it always did (FR-18). */}
              {!zonesShown && !allDay && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-my-1 font-normal text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setZonesShown(true)
                    setRevealing(true)
                  }}
                >
                  <GlobeIcon aria-hidden />
                  {t('zone.other')}
                </Button>
              )}
            </div>
            {yourZone && (
              <p id={`${id}-in-your-zone`} className="tabular text-sm text-muted-foreground">
                {yourZone}
              </p>
            )}
            {seriesZone && (
              <p id={`${id}-series-zone`} className="text-sm text-muted-foreground">
                {t('zone.seriesEvent')}
              </p>
            )}
          </fieldset>
        </EditorRow>

        <EditorRow icon={<RepeatIcon />}>
          <Label htmlFor={`${id}-repeat`} className="sr-only">
            {t('event.repeat')}
          </Label>
          <RepeatField
            id={`${id}-repeat`}
            value={{ recurrence, customRule }}
            onChange={(v) => {
              setValue('recurrence', v.recurrence, repeatOpts)
              setValue('customRule', v.customRule, repeatOpts)
            }}
            start={start}
            timeZone={ruleZone}
            presets={RECURRENCE_PRESETS}
            customizable
            explicit={event?.recurring ?? false}
            offRule={offRule}
          />
        </EditorRow>

        <EditorRow icon={<MapPinIcon />}>
          <Label htmlFor={`${id}-location`} className="sr-only">
            {t('event.location')}
          </Label>
          <Input
            id={`${id}-location`}
            autoComplete="off"
            placeholder={t('event.addLocation')}
            className={quietField}
            {...register('location')}
          />
        </EditorRow>

        <EditorRow icon={<AlignLeftIcon />}>
          <Label htmlFor={`${id}-description`} className="sr-only">
            {t('event.description')}
          </Label>
          <Textarea
            id={`${id}-description`}
            placeholder={t('event.addDescription')}
            className={cn(quietField, 'max-h-48 min-h-9 resize-none')}
            {...register('description')}
          />
        </EditorRow>
      </div>

      <DialogFooter className="sticky bottom-0 bg-surface px-4 pt-3 pb-4 sm:flex-wrap sm:px-6 sm:pb-5">
        <ConflictNotice id={`${id}-conflict`} state={conflict && (overwrites ? 'replace' : 'reopen')} />
        {asking && event ? (
          // Replaces Cancel/Save in place while a save asks which events of the series to
          // change (FR-17, spec §4); Escape cancels just this, not the editor dialog (NFR-27).
          <div className="w-full">
            <ScopeChoice
              question={t('scope.event.change')}
              items={eventScopeItems(t, event, asking.options, prefs, now, asking.notes)}
              color={colors.solid}
              // A save without a rule deletes events, and asks like a delete (FR-17).
              tone={asking.notes === 'ruleRemoved' ? 'destructive' : 'default'}
              missing={eventScopeMissing(t, asking)}
              onChoose={onChooseScope}
              onCancel={cancelAsk}
            />
          </div>
        ) : (
          <>
            {hint && (
              // Left of the buttons; on narrow screens, where they stack, above them. Save names it
              // as its description (NFR-27).
              <p id={`${id}-hint`} className="mr-auto flex items-center gap-2 text-xs font-medium text-muted-foreground max-sm:order-last">
                <ScopeGlyph slots={hint.slots} tone={hint.tone} color={colors.solid} className="shrink-0" />
                {hint.text}
              </p>
            )}
            <Button type="button" variant="ghost" onClick={onDone}>
              {t('common.cancel')}
            </Button>
            <Button
              ref={saveRef}
              type="submit"
              disabled={pending}
              aria-describedby={[conflict && `${id}-conflict`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined}
            >
              {pending && <Spinner />}
              {event ? (overwrites ? t('common.saveAnyway') : t('common.save')) : t('event.createAction')}
            </Button>
          </>
        )}
      </DialogFooter>
    </form>
  )
}

/**
 * What to type in the date and the time field of a row that couldn't read their text (FR-09), the date's
 * first, each by the id its field is described by: `id` with `-date-error` or `-time-error`.
 */
function UnreadNotes({ notes, id }: { notes: { date?: string | undefined; time?: string | undefined }; id: string }) {
  return (
    <>
      {notes.date && (
        <p id={`${id}-date-error`} className="text-sm text-destructive">
          {notes.date}
        </p>
      )}
      {notes.time && (
        <p id={`${id}-time-error`} className="text-sm text-destructive">
          {notes.time}
        </p>
      )}
    </>
  )
}

/** The ids of the notes that describe a field, or none. */
function described(...ids: (string | false | null | undefined)[]): string | undefined {
  return ids.filter(Boolean).join(' ') || undefined
}
