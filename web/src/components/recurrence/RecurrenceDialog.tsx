import { addMonths, getDaysInMonth, startOfDay } from 'date-fns'
import { InfoIcon, TriangleAlertIcon } from 'lucide-react'
import { useId, useMemo, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { DateField } from '@/components/events/DateField'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { usePrefs } from '@/hooks/usePrefs'
import { dayKey } from '@/lib/dates'
import { formatPickerDate } from '@/lib/format'
import {
  modelFromRule,
  nextDates,
  ruleFromModel,
  skipHint,
  startMatches,
  type Frequency,
  type MonthPattern,
  type Nth,
  type NthDay,
  type OffRule,
  type RepeatEnd,
  type RuleModel,
} from '@/lib/recurrence'
import { describeRRule } from '@/lib/rrule'

export interface RecurrenceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The rule the editor opens with; "" opens a weekly repeat on the start. */
  rule: string
  /** The series' start: an event's, a task's start, else its due date. */
  start: Date
  /**
   * Where `rule` recurs from, if not from `start`: the series' own rule, which a task series keeps on its days,
   * while it starts a changed one over at `start` (FR-17). The editor opens on the days it falls on there.
   */
  opensFrom?: Date
  timeZone: string
  /** The rule on Done; the dialog closes after it. */
  onDone: (rule: string) => void
  /**
   * Writes every day part, also those the start implies: for an existing series, whose rule
   * applies from its own start, which may lie elsewhere than the shown one (FR-17).
   */
  explicit?: boolean
  /** The repeat came from another app and is not `rule`, e.g. a series of dates: Done replaces it. */
  foreign?: boolean
  /**
   * What happens to `start` where the repeat doesn't fall on it (FR-17, #11): a new series or a task counts it as
   * the first date (`counts`, the default); an event of an existing series moves to the repeat's next date
   * (`moves`), which the preview starts at and an end may not precede; an exception, an extra date and a start set
   * off the old repeat stay (`stays`).
   */
  offRule?: OffRule
  /** Where the focus goes when the dialog closes; it has no trigger of its own to go back to. */
  onCloseAutoFocus?: (event: Event) => void
}

const FREQUENCIES: readonly Frequency[] = ['daily', 'weekly', 'monthly', 'yearly']
const UNITS = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' } as const
const NTHS: readonly Nth[] = [1, 2, 3, 4, 5, -1]
const ORDINALS = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', [-1]: 'last' } as const
const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => i + 1)
const PREVIEW = 5
// A chosen day stands out in iris, as a picked day does in the month (`MiniMonth`).
const CHOSEN = 'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground'

/** A count from 1 to 999, else null. */
function toCount(text: string): number | null {
  return /^\d{1,3}$/.test(text) && Number(text) >= 1 ? Number(text) : null
}

// The start as the nth weekday of its month; its fifth is its last.
function nthOfStart(start: Date): { nth: Nth; day: NthDay } {
  const n = Math.ceil(start.getDate() / 7)
  return { nth: n >= 5 ? -1 : (n as Nth), day: start.getDay() }
}

// Days in the month, in a leap year, so that February 29 can be picked.
const monthLength = (month: number) => getDaysInMonth(new Date(2000, month, 1))

/**
 * The repeat editor (FR-17): builds a repeat beyond the presets, shows it as a
 * sentence and lists its next dates, with hints where a repeat would surprise.
 */
export function RecurrenceDialog(props: RecurrenceDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="gap-5 sm:max-w-md" aria-describedby={undefined} onCloseAutoFocus={props.onCloseAutoFocus}>
        {/* The sentence below changes with every input; the dialog keeps a steady name. */}
        <DialogTitle className="sr-only">{t('recurrence.editor.title')}</DialogTitle>
        <RecurrenceForm {...props} />
      </DialogContent>
    </Dialog>
  )
}

function RecurrenceForm({
  rule,
  start,
  opensFrom,
  timeZone,
  onDone,
  onOpenChange,
  explicit = false,
  foreign = false,
  offRule = 'counts',
}: RecurrenceDialogProps) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const id = useId()
  const now = useMemo(() => new Date(), [])
  const [opened] = useState(() => modelFromRule(rule, opensFrom ?? start, timeZone))
  const initial = opened.model

  const [freq, setFreq] = useState(initial.freq)
  // Number fields keep what is typed; the model keeps the last valid number.
  const [intervalText, setIntervalText] = useState(String(initial.interval))
  const [every, setEvery] = useState(initial.interval)
  const [weekdays, setWeekdays] = useState(initial.weekdays)
  const [by, setBy] = useState(initial.monthly.by)
  const [days, setDays] = useState(initial.monthly.by === 'days' ? initial.monthly.days : [start.getDate()])
  const [nth, setNth] = useState(initial.monthly.by === 'nth' ? { nth: initial.monthly.nth, day: initial.monthly.day } : nthOfStart(start))
  const [month, setMonth] = useState(initial.month)
  const [endKind, setEndKind] = useState(initial.end.kind)
  const [countText, setCountText] = useState(String(initial.end.kind === 'count' ? initial.end.count : 10))
  const [count, setCount] = useState(initial.end.kind === 'count' ? initial.end.count : 10)
  const [until, setUntil] = useState(initial.end.kind === 'until' ? initial.end.date : dayKey(addMonths(start, 3)))

  // The yearly editor offers one day of the chosen month.
  const yearDay = Math.min(days.find((d) => d > 0) ?? start.getDate(), monthLength(month))
  const monthly: MonthPattern = by === 'nth' ? { by: 'nth', ...nth } : { by: 'days', days: freq === 'yearly' ? [yearDay] : days }
  const end: RepeatEnd =
    endKind === 'count' ? { kind: 'count', count } : endKind === 'until' ? { kind: 'until', date: until } : { kind: 'never' }
  const model: RuleModel = { freq, interval: every, weekdays, monthly, month, end, ...(initial.wkst ? { wkst: initial.wkst } : {}) }
  const written = ruleFromModel(model, start, prefs.weekStartsOn, explicit)
  const lands = startMatches(model, start, prefs.weekStartsOn)
  // Where the event moves to the repeat's next date, the dates start there (#11).
  const moves = offRule === 'moves' && !lands
  const { dates, more } = nextDates(model, start, prefs.weekStartsOn, PREVIEW, !moves)
  const next = moves ? nextDates({ ...model, end: { kind: 'never' } }, start, prefs.weekStartsOn, 1, false).dates[0] : undefined

  const intervalInvalid = toCount(intervalText) === null
  const countInvalid = endKind === 'count' && toCount(countText) === null
  const untilBeforeNext = endKind === 'until' && next !== undefined && until < dayKey(next)
  const untilInvalid = (endKind === 'until' && until < dayKey(start)) || untilBeforeNext

  const weekOrder = Array.from({ length: 7 }, (_, i) => (prefs.weekStartsOn + i) % 7)
  // 2023-01-01 was a Sunday.
  const dayName = (d: number, weekday: 'long' | 'short') =>
    new Intl.DateTimeFormat(prefs.tag, { weekday }).format(new Date(2023, 0, 1 + d))
  const kindName = (d: NthDay) => (typeof d === 'number' ? dayName(d, 'long') : t(`recurrence.dayKind.${d}`))
  const monthName = (m: number) => new Intl.DateTimeFormat(prefs.tag, { month: 'long' }).format(new Date(2000, m, 1))

  const hints: string[] = []
  const skip = skipHint(model)
  if (skip?.kind === 'monthDay') hints.push(t('recurrence.editor.skipMonthDay', { day: skip.day }))
  if (skip?.kind === 'shortMonths') hints.push(t('recurrence.editor.skipShortMonths'))
  if (skip?.kind === 'leapDay') hints.push(t('recurrence.editor.skipLeapDay'))
  if (skip?.kind === 'fifth') hints.push(t('recurrence.editor.skipFifth', { day: kindName(skip.day) }))
  if (!lands) {
    const date = formatPickerDate(start, prefs, now)
    if (offRule === 'stays') hints.push(t('recurrence.editor.startStays'))
    else if (next) hints.push(t('recurrence.editor.startMoves', { date, next: formatPickerDate(next, prefs, now) }))
    else hints.push(t('recurrence.editor.startOffRule', { date }))
  }

  const done = () => {
    // An untouched rule goes back as it came: a task's series would start over on new text (FR-17).
    const untouched = opened.exact && rule.trim() !== '' && written === ruleFromModel(initial, start, prefs.weekStartsOn, explicit)
    onDone(untouched ? rule : written)
    onOpenChange(false)
  }

  const numberField = (text: string, setText: (v: string) => void, setValue: (n: number) => void) => ({
    type: 'number',
    inputMode: 'numeric' as const,
    min: 1,
    max: 999,
    value: text,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setText(e.target.value)
      const n = toCount(e.target.value)
      if (n !== null) setValue(n)
    },
  })
  // Labels sit left of their fields; on narrow screens, above them.
  const label = 'text-sm leading-none text-muted-foreground sm:pt-2.5'

  return (
    <>
      <div className="grid gap-2 pr-8">
        <p aria-live="polite" className="font-display text-xl leading-snug font-semibold tracking-tight text-pretty">
          {describeRRule(written, start, prefs, now, t)}
        </p>
        {(!opened.exact || foreign) && (
          <p className="flex gap-2 text-sm">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            {t('recurrence.editor.inexact')}
          </p>
        )}
      </div>

      <div className="grid items-start gap-x-4 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)]">
        <Label htmlFor={`${id}-every`} className={`${label} font-normal`}>
          {t('recurrence.editor.every')}
        </Label>
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <Input
              id={`${id}-every`}
              className="w-20"
              aria-invalid={intervalInvalid || undefined}
              aria-describedby={intervalInvalid ? `${id}-every-error` : undefined}
              {...numberField(intervalText, setIntervalText, setEvery)}
            />
            <Select value={freq} onValueChange={(v) => setFreq(v as Frequency)}>
              <SelectTrigger className="w-auto min-w-28" aria-label={t('recurrence.editor.unitLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FREQUENCIES.map((f) => (
                  <SelectItem key={f} value={f}>
                    {t(`recurrence.editor.unit.${UNITS[f]}`, { count: every })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {intervalInvalid && (
            <p id={`${id}-every-error`} role="alert" className="text-sm text-destructive">
              {t('recurrence.editor.number')}
            </p>
          )}
        </div>

        {freq === 'weekly' && (
          <>
            <span className={label}>{t('recurrence.editor.onDays')}</span>
            <ToggleGroup
              type="multiple"
              aria-label={t('recurrence.editor.weekdaysLabel')}
              className="w-fit flex-wrap"
              value={weekdays.map(String)}
              onValueChange={(v) => {
                // One weekday stays chosen: a weekly repeat falls on at least one.
                if (v.length > 0) setWeekdays(v.map(Number).sort((a, b) => a - b))
              }}
            >
              {weekOrder.map((d) => (
                <ToggleGroupItem key={d} value={String(d)} aria-label={dayName(d, 'long')} className={`w-9 px-0 ${CHOSEN}`}>
                  {dayName(d, 'short')}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </>
        )}

        {freq === 'yearly' && (
          <>
            <Label htmlFor={`${id}-month`} className={`${label} font-normal`}>
              {t('recurrence.editor.inMonth')}
            </Label>
            <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
              <SelectTrigger id={`${id}-month`} className="w-auto min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 12 }, (_, m) => (
                  <SelectItem key={m} value={String(m)}>
                    {monthName(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}

        {(freq === 'monthly' || freq === 'yearly') && (
          <RadioGroup
            aria-label={t('recurrence.editor.patternLabel')}
            value={by}
            onValueChange={(v) => setBy(v as MonthPattern['by'])}
            className="gap-2 sm:col-start-2"
          >
            <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
              <RadioGroupItem value="days" id={`${id}-by-days`} />
              <Label htmlFor={`${id}-by-days`} className="font-normal">
                {t('recurrence.editor.byDay')}
              </Label>
              {freq === 'yearly' && (
                <Select
                  value={String(yearDay)}
                  onValueChange={(v) => {
                    setDays([Number(v)])
                    setBy('days')
                  }}
                >
                  <SelectTrigger className="w-auto min-w-18" aria-label={t('recurrence.editor.yearDayLabel')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DAYS_OF_MONTH.slice(0, monthLength(month)).map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {String(d)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {freq === 'monthly' && by === 'days' && (
              <ToggleGroup
                type="multiple"
                aria-label={t('recurrence.editor.monthDaysLabel')}
                className="ml-7 grid max-w-[17rem] grid-cols-7"
                value={days.map(String)}
                onValueChange={(v) => {
                  // One day stays chosen: a monthly repeat falls on at least one.
                  if (v.length > 0) setDays(v.map(Number))
                }}
              >
                {DAYS_OF_MONTH.map((d) => (
                  <ToggleGroupItem key={d} value={String(d)} className={`h-8 min-w-0 px-0 tabular-nums ${CHOSEN}`}>
                    {d}
                  </ToggleGroupItem>
                ))}
                <ToggleGroupItem value="-1" aria-label={t('recurrence.editor.lastDayLabel')} className={`col-span-4 h-8 ${CHOSEN}`}>
                  {t('recurrence.editor.lastDay')}
                </ToggleGroupItem>
              </ToggleGroup>
            )}
            <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
              <RadioGroupItem value="nth" id={`${id}-by-nth`} />
              <Label htmlFor={`${id}-by-nth`} className="font-normal">
                {t('recurrence.editor.byNth')}
              </Label>
              <Select
                value={String(nth.nth)}
                onValueChange={(v) => {
                  setNth({ ...nth, nth: Number(v) as Nth })
                  setBy('nth')
                }}
              >
                <SelectTrigger className="w-auto" aria-label={t('recurrence.editor.nthLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NTHS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {t(`recurrence.ordinal.${ORDINALS[n]}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={String(nth.day)}
                onValueChange={(v) => {
                  setNth({ ...nth, day: v === 'weekday' || v === 'weekendDay' ? v : Number(v) })
                  setBy('nth')
                }}
              >
                <SelectTrigger className="w-auto" aria-label={t('recurrence.editor.dayLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[...weekOrder, 'weekday' as const, 'weekendDay' as const].map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {kindName(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </RadioGroup>
        )}

        <span id={`${id}-ends`} className={label}>
          {t('recurrence.editor.ends')}
        </span>
        <RadioGroup aria-labelledby={`${id}-ends`} value={endKind} onValueChange={(v) => setEndKind(v as RepeatEnd['kind'])} className="gap-2">
          <div className="flex min-h-9 items-center gap-3">
            <RadioGroupItem value="never" id={`${id}-never`} />
            <Label htmlFor={`${id}-never`} className="font-normal">
              {t('recurrence.editor.never')}
            </Label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <RadioGroupItem value="until" id={`${id}-until`} />
            <Label id={`${id}-until-label`} htmlFor={`${id}-until`} className="font-normal">
              {t('recurrence.editor.onDate')}
            </Label>
            <DateField
              id={`${id}-until-date`}
              labelledBy={`${id}-until-label`}
              label={t('recurrence.editor.endDate')}
              value={until}
              onChange={(d) => {
                setUntil(d)
                setEndKind('until')
              }}
              prefs={prefs}
              now={now}
              isDisabled={(day) => day < startOfDay(start)}
              invalid={untilInvalid}
              describedBy={untilInvalid ? `${id}-until-error` : undefined}
            />
          </div>
          {untilInvalid && (
            <p id={`${id}-until-error`} role="alert" className="ml-7 text-sm text-destructive">
              {untilBeforeNext
                ? t('recurrence.editor.untilBeforeNext', { next: formatPickerDate(next, prefs, now) })
                : t('recurrence.editor.untilBeforeStart')}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <RadioGroupItem value="count" id={`${id}-count`} />
            <Label htmlFor={`${id}-count`} className="font-normal">
              {t('recurrence.editor.after')}
            </Label>
            <Input
              className="w-20"
              aria-label={t('recurrence.editor.countLabel')}
              aria-invalid={countInvalid || undefined}
              aria-describedby={countInvalid ? `${id}-count-error` : undefined}
              {...numberField(
                countText,
                (text) => {
                  // Typing a count chooses it; the focus alone, on the way to Done, does not (NFR-27).
                  setCountText(text)
                  setEndKind('count')
                },
                setCount,
              )}
            />
            <span className="text-sm">{t('recurrence.editor.times', { count })}</span>
          </div>
          {countInvalid && (
            <p id={`${id}-count-error`} role="alert" className="ml-7 text-sm text-destructive">
              {t('recurrence.editor.number')}
            </p>
          )}
        </RadioGroup>
      </div>

      <section aria-labelledby={`${id}-next`} className="grid gap-2 border-t pt-4">
        <h3 id={`${id}-next`} className="text-sm font-medium">
          {t('recurrence.editor.next')}
        </h3>
        <ol className="grid gap-1 text-sm tabular-nums">
          {dates.map((d) => (
            <li key={d.getTime()}>{formatPickerDate(d, prefs, now)}</li>
          ))}
        </ol>
        {!more && <p className="text-xs text-muted-foreground">{t('recurrence.editor.noMore')}</p>}
        {hints.map((hint) => (
          <p key={hint} className="flex gap-2 text-xs text-muted-foreground">
            <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden />
            {hint}
          </p>
        ))}
      </section>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          {t('common.cancel')}
        </Button>
        <Button type="button" disabled={intervalInvalid || countInvalid || untilInvalid} onClick={done}>
          {t('recurrence.editor.done')}
        </Button>
      </DialogFooter>
    </>
  )
}
