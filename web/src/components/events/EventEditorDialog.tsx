import { zodResolver } from '@hookform/resolvers/zod'
import { format } from 'date-fns'
import { AlignLeftIcon, ClockIcon, MapPinIcon, RepeatIcon, XIcon } from 'lucide-react'
import { useId, useMemo, type ReactNode } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useCreateEvent, useUpdateEvent, useVisibleCalendars } from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { usePrefs } from '@/hooks/usePrefs'
import { type Calendar } from '@/lib/api/schemas'
import { parseDayKey } from '@/lib/dates'
import {
  createFormValues,
  editFormValues,
  eventFormSchema,
  formDuration,
  formToInput,
  shiftEnd,
  type EventFormValues,
} from '@/lib/eventForm'
import { formatDuration, formatMonthDay } from '@/lib/format'
import { browserTimeZone } from '@/lib/locale'
import { RECURRENCE_PRESETS } from '@/lib/rrule'
import { cn } from '@/lib/utils'
import { useUi, type EditorState } from '@/stores/ui'
import { DateField } from './DateField'
import { TimeSelect } from './TimeSelect'

// Location and description read as plain text until hovered or focused, like the details popover.
const quietField = '-ml-2 w-[calc(100%+0.5rem)] border-transparent bg-transparent px-2 hover:border-input'

/** Create/edit dialog for events (FR-09, FR-11). */
export function EventEditorDialog() {
  const editor = useUi((s) => s.editor)
  const openEditor = useUi((s) => s.openEditor)
  const { all, visible } = useVisibleCalendars()
  const writable = all.filter((c) => c.supportsEvents && !c.readOnly)
  const preferred = visible.find((c) => c.supportsEvents && !c.readOnly) ?? writable[0]

  return (
    <Dialog
      open={editor !== null}
      onOpenChange={(open) => {
        if (!open) openEditor(null)
      }}
    >
      {editor && (
        <DialogContent className="gap-0 p-0" showCloseButton={false}>
          <EditorForm
            key={editor.mode === 'edit' ? editor.event.key : 'create'}
            editor={editor}
            calendars={writable}
            defaultCalendarId={preferred?.id ?? ''}
            onDone={() => {
              openEditor(null)
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  )
}

function EditorForm({
  editor,
  calendars,
  defaultCalendarId,
  onDone,
}: {
  editor: NonNullable<EditorState>
  calendars: Calendar[]
  defaultCalendarId: string
  onDone: () => void
}) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const colorsOf = useCalendarColors()
  const tz = useMemo(() => browserTimeZone(), [])
  const now = useMemo(() => new Date(), [])
  const create = useCreateEvent()
  const update = useUpdateEvent()
  const id = useId()
  const event = editor.mode === 'edit' ? editor.event : undefined

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventFormSchema),
    defaultValues:
      editor.mode === 'edit'
        ? editFormValues(editor.event, tz)
        : createFormValues(editor.defaults, defaultCalendarId, tz),
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  })
  const { register, control, handleSubmit, setValue, getValues, formState } = form
  const [allDay, recurrence, calendarId, startDate, startTime, endDate, endTime] = useWatch({
    control,
    name: ['allDay', 'recurrence', 'calendarId', 'startDate', 'startTime', 'endDate', 'endTime'],
  })
  const pending = create.isPending || update.isPending
  const colors = colorsOf(calendarId)
  const calendar = calendars.find((c) => c.id === calendarId)
  const duration = formDuration({ allDay, startDate, startTime, endDate, endTime })
  const start = parseDayKey(startDate)

  const onStartChange = (date: string, time: string) => {
    const next = shiftEnd(getValues(), date, time)
    setValue('startDate', date, { shouldDirty: true })
    setValue('startTime', time, { shouldDirty: true })
    setValue('endDate', next.endDate, { shouldDirty: true, shouldValidate: formState.isSubmitted })
    setValue('endTime', next.endTime, { shouldDirty: true, shouldValidate: formState.isSubmitted })
  }

  const onSubmit = handleSubmit((values) => {
    const input = formToInput(values, tz, event)
    if (event) {
      update.mutate({ event, input }, { onSuccess: onDone })
    } else {
      create.mutate({ calendarId: values.calendarId, input }, { onSuccess: onDone })
    }
  })

  const err = (key: keyof EventFormValues) => {
    const m = formState.errors[key]?.message
    return m ? t(m as 'validation.date') : undefined
  }

  // The presets repeat on the start's weekday or date (FREQ only); say which.
  const presetLabel = (r: (typeof RECURRENCE_PRESETS)[number]) => {
    switch (r) {
      case 'weekly':
        return t('recurrence.weeklyOn', { weekday: format(start, 'EEEE', { locale: prefs.locale }) })
      case 'monthly':
        return t('recurrence.monthlyOn', { day: start.getDate() })
      case 'yearly':
        return t('recurrence.yearlyOn', { date: formatMonthDay(start, prefs) })
      default:
        return t(`recurrence.${r}`)
    }
  }

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

  const titleError = err('title')
  const endError = err('endDate')
  const otherZone = !allDay && event?.timezone && event.timezone !== tz ? event.timezone : null

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      {/* The event as it will appear in the calendar: its calendar's tint and bar. */}
      <div
        className="relative grid gap-2 border-l-4 pt-5 pr-14 pb-4 pl-11 transition-colors duration-200 sm:pl-[3.25rem]"
        style={{ backgroundColor: colors.tint, color: colors.onTint, borderLeftColor: colors.solid }}
      >
        <DialogTitle className="sr-only">{event ? t('event.edit') : t('event.new')}</DialogTitle>
        <DialogDescription className="sr-only">{t('event.dialogDescription')}</DialogDescription>
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
        {event?.recurring && <p className="text-sm">{t('event.seriesNotice')}</p>}
        <DialogClose className="absolute top-3 right-3 rounded-md p-1.5 transition-colors outline-none hover:bg-current/10 focus-visible:ring-[3px] focus-visible:ring-current/50 [&_svg]:size-4">
          <XIcon aria-hidden />
          <span className="sr-only">{t('common.close')}</span>
        </DialogClose>
      </div>

      <div className="grid gap-3 px-4 pt-5 pb-2 sm:px-6">
        <Row icon={<ClockIcon />}>
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
        </Row>

        <Row icon={<RepeatIcon />}>
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
                      {presetLabel(r)}
                    </SelectItem>
                  ))}
                  {recurrence === 'custom' && <SelectItem value="custom">{t('recurrence.custom')}</SelectItem>}
                </SelectContent>
              </Select>
            )}
          />
          {recurrence === 'custom' && (
            <p className="truncate pt-1 text-xs text-muted-foreground" title={getValues('customRule')}>
              {getValues('customRule')}
            </p>
          )}
        </Row>

        <Row icon={<MapPinIcon />}>
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
        </Row>

        <Row icon={<AlignLeftIcon />}>
          <Label htmlFor={`${id}-description`} className="sr-only">
            {t('event.description')}
          </Label>
          <Textarea
            id={`${id}-description`}
            placeholder={t('event.addDescription')}
            className={cn(quietField, 'max-h-48 min-h-9 resize-none')}
            {...register('description')}
          />
        </Row>
      </div>

      <DialogFooter className="sticky bottom-0 bg-surface px-4 pt-3 pb-4 sm:px-6 sm:pb-5">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner />}
          {event ? t('common.save') : t('event.createAction')}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** A row with its icon hanging in the left column, as in the details popover. */
function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1.25rem_1fr] items-start gap-x-3">
      <span className="flex h-9 items-center text-muted-foreground [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
