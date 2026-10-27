import { CalendarIcon, ClockIcon, XIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TimeField } from '@/components/events/TimeField'
import { MiniMonth } from '@/components/layout/MiniMonth'
import { ScopeChoice } from '@/components/scope/ScopeChoice'
import { ScopeGlyph } from '@/components/scope/ScopeGlyph'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { useNow } from '@/hooks/useNow'
import { usePrefs } from '@/hooks/usePrefs'
import { type Todo, type TodoInput } from '@/lib/api/schemas'
import { currentRepeat, type TaskRepeat } from '@/lib/calendarTasks'
import { dayKey, parseDayKey } from '@/lib/dates'
import { formatPickerDate } from '@/lib/format'
import { browserTimeZone } from '@/lib/locale'
import {
  scopeOptions,
  taskScopeHint,
  taskScopeItems,
  taskScopeMissing,
  type GlyphSlot,
  type Scope,
  type ScopeResult,
} from '@/lib/scope'
import { type ShiftReason } from '@/lib/seriesShift'
import { taskToForm, withDue } from '@/lib/taskForm'
import { datesChanged, dueShortcuts, isOverdue } from '@/lib/tasks'
import { isFormTime, unreadableNote } from '@/lib/unreadable'

/**
 * Where a change in the picker came from, which decides what follows once it
 * is saved (FR-14): a `day` closes the picker, unless it leaves the task
 * overdue today, where the time comes next; a `time` keeps it open, so a day
 * can follow; a `removal` of the due date closes it.
 */
type Source = 'day' | 'time' | 'removal'

/** A change of a series' current repeat waiting for the answer which repeats it reaches (FR-17). */
interface Asking {
  input: TodoInput
  source: Source
  repeat: TaskRepeat
  result: ScopeResult
}

/**
 * The due date of a task in the list, changed in place (FR-14): today,
 * tomorrow or next Monday with the date each one means, a day of the month,
 * the time, or none. A day keeps the time and closes the popover; a new time
 * keeps it open, so a day can follow.
 *
 * A time typed is saved once: on Enter or a pick in its list at once; left
 * for the rest of the picker, with the day, shortcut or removal picked next,
 * as one change (one question for a series), or else as the picker closes.
 * It stays typed until it is saved, through a question cancelled or a move
 * the series refuses; Escape drops it. Text the time field can't read is
 * said below it and holds every save back: a day, a shortcut, a removal or a
 * close leaves the picker open, on the time.
 *
 * With `onScope`, a series moves at its current repeat, the one the list
 * shows (FR-17). Where the move has a choice, the popover asks in place of
 * the month which repeats it reaches, and `onScope` reports the answer; where
 * it has one option, `onScope` reports that one at once; where it has none,
 * the line below the month says why and nothing is saved. Where the answer
 * does not depend on the day, that line says beforehand what a move reaches.
 * A task that does not repeat, and the last repeat, are saved as they are
 * through `onChange`, as is every task without `onScope`. A series without a
 * start keeps its due date, the date it repeats from.
 */
export function DuePicker({
  todo,
  onChange,
  onScope,
  className,
}: {
  todo: Todo
  /** Saves `input` as a single task. */
  onChange: (input: TodoInput) => void
  /** Saves `input` for the repeats of the series `scope` reaches from its current one. */
  onScope?: (scope: Scope, input: TodoInput) => void
  className?: string
}) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const now = useNow()
  const tz = useMemo(() => browserTimeZone(), [])
  const timeId = useId()
  const content = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState<Asking | null>(null)
  // Why the series can't follow the last pick, said below the month (FR-17).
  const [refused, setRefused] = useState<ShiftReason | null>(null)
  // A time typed and not saved yet, saved with what follows (FR-14), or text the field couldn't read, said
  // below it, which saves nothing (FR-09). In a ref too: the click after the field's blur reads it before a
  // render.
  const pending = useRef<string | null>(null)
  const [typed, setTyped] = useState<string | null>(null)
  // Whether the time field passed a commit up in the key press or click under way: on Enter or a pick of the
  // value it has already, it passes none, and the time typed and not saved yet is saved then (FR-14).
  const committed = useRef(false)
  // Where the focus goes once the question gives way to the month again (NFR-27).
  const back = useRef<HTMLElement | null>(null)
  const { dueDate, dueTime } = taskToForm(todo, tz)
  const shortcuts = dueShortcuts(now)
  const picks = [
    { label: t('tasks.today'), day: shortcuts.today },
    { label: t('tasks.tomorrow'), day: shortcuts.tomorrow },
    { label: t('tasks.nextWeek'), day: shortcuts.nextWeek },
  ]
  // The repeat a change moves: the series' current one, which the list shows (FR-17).
  const repeat = onScope ? currentRepeat(todo) : null
  // What a move reaches, said before a pick where the day doesn't decide it, as on fixed days it may.
  const hint =
    open && repeat && !todo.fixedDays
      ? taskScopeHint(t, scopeOptions({ kind: 'task', action: 'move', item: repeat }), 'move', false, repeat.at)
      : null

  useEffect(() => {
    if (asking) return
    back.current?.focus()
    back.current = null
  }, [asking])

  const unreadNote = unreadableNote(t, prefs, now, [{ time: typed ?? '' }])

  const time = () => document.getElementById(timeId)

  const hold = (value: string | null) => {
    pending.current = value
    setTyped(value)
  }

  // The time a change saves (FR-14): the one typed and not saved yet, else the saved one. Null while the
  // typed text can't be read: nothing is saved, and the focus goes to the time, which says what to type.
  const typedTime = (): string | null => {
    const value = pending.current
    if (value === null) return dueTime
    if (value !== '' && !isFormTime(value)) {
      time()?.focus()
      return null
    }
    return value
  }

  // Saves `input` for the repeats `scope` reaches, or as a single task; a time typed went with it.
  const send = (scope: Scope | null, input: TodoInput) => {
    if (scope) onScope?.(scope, input)
    else onChange(input)
    hold(null)
  }

  // Where a saved change leaves the picker: on the time, or closed (null). A repeat made a task of
  // its own leaves the series' next repeat here, which the user didn't pick, so the picker closes.
  const stay = (input: TodoInput, source: Source, scope: Scope | null): HTMLElement | null => {
    if (scope === 'this' || source === 'removal') return null
    // Today at a time already past leaves the task overdue: stay, with the time to change next.
    if (source === 'time' || (input.due && !input.dueAllDay && isOverdue(input, new Date()))) return time()
    return null
  }

  // Leaves the picker as a change saved without asking leaves it; a new time has the focus already.
  const settle = (input: TodoInput, source: Source, scope: Scope | null) => {
    const next = stay(input, source, scope)
    if (!next) setOpen(false)
    else if (source === 'day') next.focus()
  }

  // Saves a change, or asks first which repeats of a series it reaches (FR-14, FR-17); `from` takes
  // the focus back if the question is cancelled. False while it asks, or where nothing moves; a time
  // typed then stays typed.
  const save = (input: TodoInput, source: Source, from: HTMLElement | null): boolean => {
    setRefused(null)
    if (!repeat) {
      send(null, input)
      settle(input, source, null)
      return true
    }
    // The dates it has already: "only this repeat" would still make a task of its own of it.
    if (!datesChanged(repeat.shown, input)) {
      settle(input, source, null)
      return true
    }
    const result = scopeOptions({ kind: 'task', action: 'move', item: repeat, to: input })
    const [only] = result.options
    if (result.options.length > 1) {
      back.current = from
      setAsking({ input, source, repeat, result })
      return false
    } else if (only) {
      send(only, input)
      settle(input, source, only)
    } else if (result.reason) {
      // Nothing moves: the day stays unpicked, and the line below the month says why.
      setRefused(result.reason)
      return false
    } else {
      // The last repeat acts as a single task.
      send(null, input)
      settle(input, source, null)
    }
    return true
  }

  // A day takes a time typed and not saved yet along: one save, one question for a series (FR-14, FR-17).
  const pickDay = (day: Date, from: HTMLElement | null) => {
    const at = typedTime()
    if (at === null) return
    save(withDue(todo, { date: dayKey(day), time: at }, tz), 'day', from)
  }

  // Whether the picker may close, which leaves the time field (FR-14): a time typed and not saved yet is
  // saved, alone, and it closes, unless the save asks first or nothing moves (FR-17); text that can't be
  // read keeps it open.
  const leave = (): boolean => {
    if (pending.current === null) return true
    // Asked about it already: the question stays until it is answered or cancelled.
    if (asking) return false
    const at = typedTime()
    if (at === null) return false
    return save(withDue(todo, { date: dueDate, time: at }, tz), 'time', time())
  }

  const choose = (scope: Scope) => {
    if (!asking) return
    const { input, source } = asking
    send(scope, input)
    back.current = stay(input, source, scope)
    if (!back.current) setOpen(false)
    setAsking(null)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Its button closes it before the click reaches `onInteractOutside`, so the time field is left here too.
        if (!next && !leave()) return
        setOpen(next)
        setAsking(null)
        setRefused(null)
        hold(null)
        back.current = null
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('tasks.changeDue', { title: todo.title || t('event.untitled') })}
          className={className}
          disabled={todo.ruleUnsupported}
        >
          <CalendarIcon aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        align="end"
        className={asking ? 'w-80' : 'w-64 p-2'}
        aria-label={t('tasks.due')}
        onEscapeKeyDown={(e) => {
          // Escape closes the picker without a time typed and left (FR-14).
          if (!asking) {
            hold(null)
            return
          }
          // Escape leaves the question for the month, not the picker (NFR-27).
          e.preventDefault()
          setAsking(null)
        }}
        onInteractOutside={(e) => {
          // A press outside that kept the focus in the time field leaves it here, so its text is read first.
          const field = time()
          if (field && field === document.activeElement) field.blur()
          if (!leave()) e.preventDefault()
        }}
      >
        {asking && (
          <PickerQuestion
            asking={asking}
            onChoose={choose}
            onCancel={() => {
              setAsking(null)
            }}
          />
        )}
        {/* Hidden, not gone, while the question asks: the month it shows and the focus come back with it. */}
        <div hidden={asking !== null}>
          <div className="grid">
            {picks.map((p) => (
              <Button
                key={p.label}
                variant="ghost"
                size="sm"
                className="justify-between font-normal"
                onClick={(e) => {
                  pickDay(p.day, e.currentTarget)
                }}
              >
                {p.label}{' '}
                <span className="tabular text-muted-foreground">{formatPickerDate(p.day, prefs, now)}</span>
              </Button>
            ))}
          </div>
          <div className="mt-2 border-t pt-2">
            <MiniMonth
              date={dueDate ? parseDayKey(dueDate) : now}
              now={now}
              range={null}
              prefs={prefs}
              emphasis="selected"
              onSelect={(day) => {
                pickDay(day, content.current?.querySelector<HTMLElement>(`[data-day="${dayKey(day)}"]`) ?? null)
              }}
              footer={
                repeat && (
                  // Said as it changes, after a pick no option moves (NFR-27).
                  <div aria-live="polite">
                    {refused ? (
                      <p className="px-2 pt-2 text-xs font-medium text-muted-foreground">
                        {t('scope.hint.none', { reason: t(`scope.reason.${refused}`) })}
                      </p>
                    ) : (
                      hint && <PickerHint calendarId={todo.calendarId} slots={hint.slots} text={hint.text} />
                    )}
                  </div>
                )
              }
            />
          </div>
          {dueDate && (
            <div className="mt-2 grid gap-1 border-t pt-2">
              {/* Enter in the field or a pick in its list (React passes the click on out of the list's portal) on the
                  time pending: the field passes nothing up for the value it has, so the row saves it, as a close
                  would (FR-14). */}
              {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- listens to the time field inside, which takes the keyboard itself (NFR-27) */}
              <div
                className="flex items-center gap-2 pl-2.5"
                onKeyDownCapture={() => {
                  committed.current = false
                }}
                onClickCapture={() => {
                  committed.current = false
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && !committed.current) leave()
                }}
                onClick={(e) => {
                  if (e.target instanceof Element && e.target.closest('[role="option"]') && !committed.current) leave()
                }}
              >
                <ClockIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <TimeField
                  id={timeId}
                  value={typed ?? dueTime}
                  onChange={(value, via) => {
                    // Typed until saved (FR-14): Enter or a pick saves a time at once; left, it waits for a
                    // day, a shortcut, a removal or the close that follows; text the field can't read waits to
                    // be corrected. Typed back to the saved time, it has nothing to save.
                    committed.current = true
                    const changed = value !== dueTime
                    hold(changed ? value : null)
                    if (via !== 'blur' && changed && (value === '' || isFormTime(value))) {
                      save(withDue(todo, { date: dueDate, time: value }, tz), 'time', time())
                    }
                  }}
                  prefs={prefs}
                  none={t('tasks.noTime')}
                  placeholder={t('tasks.addTime')}
                  describedBy={unreadNote ? `${timeId}-error` : undefined}
                  aria-label={t('tasks.dueTime')}
                />
              </div>
              {unreadNote && (
                <p id={`${timeId}-error`} className="pl-8.5 text-xs font-medium text-destructive">
                  {unreadNote}
                </p>
              )}
              {/* A repeating task needs a date to repeat from: a series without a start keeps its due date (FR-17). */}
              {!(todo.recurring && !todo.start) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start text-muted-foreground"
                  onClick={(e) => {
                    // Without the due date, a time typed goes too: one save, but not while it can't be read.
                    if (typedTime() === null) return
                    save(withDue(todo, { date: '', time: '' }, tz), 'removal', e.currentTarget)
                  }}
                >
                  <XIcon aria-hidden />
                  {t('tasks.removeDue')}
                </Button>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The question which repeats a move of the series' current repeat reaches,
 * in place of the month (FR-17). Shown only while it asks, so the closed
 * pickers of the list look up no calendar colors.
 */
function PickerQuestion({
  asking,
  onChoose,
  onCancel,
}: {
  asking: Asking
  onChoose: (scope: Scope) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const now = useNow()
  const { repeat, result } = asking
  const color = useCalendarColors()(repeat.todo.calendarId).solid
  return (
    <ScopeChoice
      question={t('scope.task.move')}
      items={taskScopeItems(t, repeat, result.options, prefs, now, 'change')}
      color={color}
      missing={taskScopeMissing(t, result)}
      onChoose={onChoose}
      onCancel={onCancel}
    />
  )
}

/** What a move reaches, said below the month before a pick, with its reach glyph in the series' color (FR-17). */
function PickerHint({ calendarId, slots, text }: { calendarId: string; slots: GlyphSlot[]; text: string }) {
  const color = useCalendarColors()(calendarId).solid
  return (
    <p className="grid grid-cols-[44px_1fr] items-start gap-x-2 px-2 pt-2 text-xs font-medium text-muted-foreground">
      <ScopeGlyph slots={slots} color={color} className="mt-[3px]" />
      {text}
    </p>
  )
}
