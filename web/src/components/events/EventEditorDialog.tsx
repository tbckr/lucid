import { zodResolver } from '@hookform/resolvers/zod'
import { InfoIcon } from 'lucide-react'
import { useId, useMemo } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
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
import { usePrefs } from '@/hooks/usePrefs'
import { type Calendar } from '@/lib/api/schemas'
import {
  createFormValues,
  editFormValues,
  eventFormSchema,
  formToInput,
  shiftEnd,
  type EventFormValues,
} from '@/lib/eventForm'
import { browserTimeZone } from '@/lib/locale'
import { RECURRENCE_PRESETS } from '@/lib/rrule'
import { useUi, type EditorState } from '@/stores/ui'
import { TimeSelect } from './TimeSelect'

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
        <DialogContent className="sm:max-w-xl">
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
  const tz = useMemo(() => browserTimeZone(), [])
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
  const [allDay, recurrence, startDate, startTime] = useWatch({
    control,
    name: ['allDay', 'recurrence', 'startDate', 'startTime'],
  })
  const pending = create.isPending || update.isPending

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

  if (calendars.length === 0 && !event) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t('event.new')}</DialogTitle>
          <DialogDescription>{t('event.noWritableCalendar')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onDone}>{t('common.close')}</Button>
        </DialogFooter>
      </>
    )
  }

  const endError = err('endDate')

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{event ? t('event.edit') : t('event.new')}</DialogTitle>
        <DialogDescription className="sr-only">{t('event.dialogDescription')}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-title`} className="sr-only">
          {t('event.title')}
        </Label>
        <Input
          id={`${id}-title`}
          placeholder={t('event.titlePlaceholder')}
          autoComplete="off"
          className="h-11 rounded-none border-0 border-b border-input bg-transparent px-0 font-display text-xl font-semibold shadow-none focus-visible:border-primary focus-visible:ring-0 md:text-xl"
          aria-invalid={formState.errors.title ? true : undefined}
          {...register('title')}
        />
        {err('title') && <p className="text-sm text-destructive">{err('title')}</p>}
      </div>

      <div className="grid gap-3">
        <div className="flex items-center gap-2">
          <Controller
            control={control}
            name="allDay"
            render={({ field }) => (
              <Switch id={`${id}-allday`} checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
          <Label htmlFor={`${id}-allday`}>{t('event.allDay')}</Label>
        </div>

        <fieldset className="grid gap-2">
          <legend className="sr-only">{t('event.when')}</legend>
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={`${id}-start`} className="w-10 text-muted-foreground">
              {t('event.starts')}
            </Label>
            <Input
              id={`${id}-start`}
              type="date"
              className="tabular w-[10.5rem]"
              value={startDate}
              onChange={(e) => {
                onStartChange(e.target.value, getValues('startTime'))
              }}
              required
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
            <Label htmlFor={`${id}-end`} className="w-10 text-muted-foreground">
              {t('event.ends')}
            </Label>
            <Input
              id={`${id}-end`}
              type="date"
              className="tabular w-[10.5rem]"
              aria-invalid={endError ? true : undefined}
              aria-describedby={endError ? `${id}-end-error` : undefined}
              {...register('endDate')}
              required
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
          </div>
          {endError && (
            <p id={`${id}-end-error`} className="text-sm text-destructive">
              {endError}
            </p>
          )}
          {!allDay && <p className="text-xs text-muted-foreground">{t('event.timezoneHint', { tz })}</p>}
        </fieldset>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-calendar`}>{t('event.calendar')}</Label>
          <Controller
            control={control}
            name="calendarId"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange} disabled={!!event}>
                <SelectTrigger id={`${id}-calendar`} aria-invalid={formState.errors.calendarId ? true : undefined}>
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
          {err('calendarId') && <p className="text-sm text-destructive">{err('calendarId')}</p>}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-repeat`}>{t('event.repeat')}</Label>
          <Controller
            control={control}
            name="recurrence"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id={`${id}-repeat`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECURRENCE_PRESETS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`recurrence.${r}`)}
                    </SelectItem>
                  ))}
                  {recurrence === 'custom' && <SelectItem value="custom">{t('recurrence.custom')}</SelectItem>}
                </SelectContent>
              </Select>
            )}
          />
          {recurrence === 'custom' && (
            <p className="truncate text-xs text-muted-foreground" title={getValues('customRule')}>
              {getValues('customRule')}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-location`}>{t('event.location')}</Label>
        <Input id={`${id}-location`} autoComplete="off" {...register('location')} />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-description`}>{t('event.description')}</Label>
        <Textarea id={`${id}-description`} rows={3} className="max-h-48" {...register('description')} />
      </div>

      {event?.recurring && (
        <p className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t('event.seriesNotice')}
        </p>
      )}

      <DialogFooter>
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
