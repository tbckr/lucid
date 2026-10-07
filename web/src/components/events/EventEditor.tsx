import { zodResolver } from '@hookform/resolvers/zod'
import { AlignLeftIcon, ClockIcon, MapPinIcon, RepeatIcon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { KindSwitch } from '@/components/create/KindSwitch'
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
  useCreateEvent,
  useUpdateEvent,
  useUpdateFollowing,
  useUpdateOccurrence,
  useVisibleCalendars,
} from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { usePrefs } from '@/hooks/usePrefs'
import { type Calendar, type EventInput } from '@/lib/api/schemas'
import { parseDayKey } from '@/lib/dates'
import {
  editFormValues,
  eventFormSchema,
  formDuration,
  formToInput,
  keepsRuleAndAllDay,
  occurrenceInput,
  shiftEnd,
  type EventFormValues,
} from '@/lib/eventForm'
import { type CalEvent } from '@/lib/events'
import { formatDuration } from '@/lib/format'
import { browserTimeZone } from '@/lib/locale'
import { chooseCalendar, eventForm, switchDraft, writableFor } from '@/lib/quickCreate'
import { buildRRule, describeRRule, RECURRENCE_PRESETS } from '@/lib/rrule'
import {
  eventScopeHint,
  eventScopeItems,
  eventScopeMissing,
  glyphSlots,
  scopeOptions,
  type Scope,
  type ScopeAction,
  type ScopeNotes,
  type ScopeResult,
} from '@/lib/scope'
import { cn } from '@/lib/utils'
import { useUi, type EditorState } from '@/stores/ui'
import { DateField } from './DateField'
import { EditorRow, quietField } from './EditorRow'
import { TimeSelect } from './TimeSelect'

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
  const update = useUpdateEvent(series)
  const updateOccurrence = useUpdateOccurrence(series)
  const updateFollowing = useUpdateFollowing(series)
  const id = useId()
  const openTaskEditor = useUi((s) => s.openTaskEditor)
  const kindRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const askedBefore = useRef(false)
  // The editor's values when it opened, to tell whether the rule or the all-day flag changed (FR-17).
  const initial = event ? editFormValues(event, tz) : null
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
  const { register, control, handleSubmit, setValue, getValues, setFocus, subscribe, formState } = form
  const [allDay, recurrence, calendarId, startDate, startTime, endDate, endTime] = useWatch({
    control,
    name: ['allDay', 'recurrence', 'calendarId', 'startDate', 'startTime', 'endDate', 'endTime'],
  })
  const pending = create.isPending || update.isPending || updateOccurrence.isPending || updateFollowing.isPending
  const colors = colorsOf(calendarId)
  const calendar = calendars.find((c) => c.id === calendarId)
  const duration = formDuration({ allDay, startDate, startTime, endDate, endTime })
  const start = parseDayKey(startDate)

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

  const onStartChange = (date: string, time: string) => {
    const next = shiftEnd(getValues(), date, time)
    setValue('startDate', date, { shouldDirty: true })
    setValue('startTime', time, { shouldDirty: true })
    setValue('endDate', next.endDate, { shouldDirty: true, shouldValidate: formState.isSubmitted })
    setValue('endTime', next.endTime, { shouldDirty: true, shouldValidate: formState.isSubmitted })
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

  // What a save of `values` does to the series (FR-17): a changed rule or all-day flag is a `rule`
  // change, anything else a `change`.
  const saveAction = (values: EventFormValues): ScopeAction =>
    initial && keepsRuleAndAllDay(values, initial) ? 'change' : 'rule'

  // Which events of a series a save of `values` (sent as `input`) can reach (FR-17): a changed
  // rule or all-day flag this and the following events' or the whole series', and a day the
  // series can't follow only this event's. Empty for anything but an occurrence of a series.
  const saveScopes = (values: EventFormValues, input: EventInput): ScopeResult =>
    occurrence
      ? scopeOptions({ kind: 'event', action: saveAction(values), item: occurrence, to: new Date(input.start), tz })
      : { options: [] }

  // "Only this event" saves an override of the occurrence; "This and following events" splits the
  // series there, and "All events" saves the series (FR-17).
  const saveScope = (scope: Scope, e: CalEvent, input: EventInput) => {
    switch (scope) {
      case 'this':
        updateOccurrence.mutate({ event: e, input: occurrenceInput(input) }, { onSuccess: onDone })
        break
      case 'following':
        updateFollowing.mutate({ event: e, input }, { onSuccess: onDone })
        break
      case 'all':
        update.mutate({ event: e, input }, { onSuccess: onDone })
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
      update.mutate({ event, input }, { onSuccess: onDone })
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

  // The presets repeat on the start's weekday or date (FREQ only); say which. A custom rule
  // reads the same way where it can.
  const repeatText = (rule: string) => describeRRule(rule, start, prefs, now, t)
  const customRule = recurrence === 'custom' ? getValues('customRule') : ''

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

  // What Save reaches when there is no choice (FR-17), said in the footer before it is pressed. Live
  // with the form: the watched fields above re-render the editor whenever the answer can change.
  // Only for an occurrence of a series, so a single event's values aren't read before they are
  // validated.
  const formValues = getValues()
  const hint = occurrence
    ? eventScopeHint(t, saveScopes(formValues, formToInput(formValues, tz, occurrence)), recurrence === 'none')
    : null

  const titleError = err('title')
  const endError = err('endDate')
  // For a series, saving only moves the time zone while the rule or the all-day flag changes
  // too (spec §4); until then, both "Only this event" and "All events" keep the series' own
  // zone, so the notice would be misleading.
  const seriesZoneFixed = !!(event?.recurring && initial && keepsRuleAndAllDay(getValues(), initial))
  const otherZone = !allDay && event?.timezone && event.timezone !== tz && !seriesZoneFixed ? event.timezone : null

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
            {/* Narrow screens drop the visible Start/End labels, like mobile calendars; the order says it. */}
            <div className="flex flex-wrap items-center gap-2">
              <span id={`${id}-starts`} className="w-12 text-sm text-muted-foreground max-sm:sr-only">
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
              />
              {!allDay && (
                <TimeSelect
                  value={startTime}
                  onChange={(v) => {
                    onStartChange(getValues('startDate'), v)
                  }}
                  prefs={prefs}
                  aria-label={t('event.startTime')}
                />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span id={`${id}-ends`} className="w-12 text-sm text-muted-foreground max-sm:sr-only">
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
                    onChange={field.onChange}
                    prefs={prefs}
                    now={now}
                    quiet={field.value === startDate}
                    invalid={!!endError}
                    describedBy={endError ? `${id}-end-error` : undefined}
                  />
                )}
              />
              {!allDay && (
                <Controller
                  control={control}
                  name="endTime"
                  render={({ field }) => (
                    <TimeSelect
                      value={field.value}
                      onChange={field.onChange}
                      prefs={prefs}
                      invalid={!!endError}
                      aria-label={t('event.endTime')}
                    />
                  )}
                />
              )}
              {duration && !('days' in duration && duration.days === 1) && (
                <span className="tabular pl-1 text-sm text-muted-foreground">{formatDuration(duration, prefs)}</span>
              )}
            </div>
            {endError && (
              <p id={`${id}-end-error`} className="text-sm text-destructive">
                {endError}
              </p>
            )}
            <div className="flex items-center gap-2 pt-1">
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
            {otherZone && <p className="text-xs text-muted-foreground">{t('event.timezoneOther', { tz, from: otherZone })}</p>}
          </fieldset>
        </EditorRow>

        <EditorRow icon={<RepeatIcon />}>
          <Label htmlFor={`${id}-repeat`} className="sr-only">
            {t('event.repeat')}
          </Label>
          <Controller
            control={control}
            name="recurrence"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id={`${id}-repeat`} className="w-auto min-w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECURRENCE_PRESETS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {repeatText(buildRRule(r))}
                    </SelectItem>
                  ))}
                  {recurrence === 'custom' && <SelectItem value="custom">{t('recurrence.custom')}</SelectItem>}
                </SelectContent>
              </Select>
            )}
          />
          {customRule && (
            <p className="truncate pt-1 text-xs text-muted-foreground" title={customRule}>
              {repeatText(customRule) ?? customRule}
            </p>
          )}
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

      <DialogFooter className="sticky bottom-0 bg-surface px-4 pt-3 pb-4 sm:px-6 sm:pb-5">
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
                <ScopeGlyph slots={glyphSlots(hint.reach)} tone={hint.tone} color={colors.solid} className="shrink-0" />
                {hint.text}
              </p>
            )}
            <Button type="button" variant="ghost" onClick={onDone}>
              {t('common.cancel')}
            </Button>
            <Button ref={saveRef} type="submit" disabled={pending} aria-describedby={hint ? `${id}-hint` : undefined}>
              {pending && <Spinner />}
              {event ? t('common.save') : t('event.createAction')}
            </Button>
          </>
        )}
      </DialogFooter>
    </form>
  )
}
