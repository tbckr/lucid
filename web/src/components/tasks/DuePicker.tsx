import { CalendarIcon, ClockIcon, XIcon } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TimeSelect } from '@/components/events/TimeSelect'
import { MiniMonth } from '@/components/layout/MiniMonth'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useNow } from '@/hooks/useNow'
import { usePrefs } from '@/hooks/usePrefs'
import { type Todo, type TodoInput } from '@/lib/api/schemas'
import { dayKey, parseDayKey } from '@/lib/dates'
import { formatPickerDate } from '@/lib/format'
import { browserTimeZone } from '@/lib/locale'
import { taskToForm, withDue } from '@/lib/taskForm'
import { dueShortcuts, isOverdue } from '@/lib/tasks'

/**
 * The due date of a task in the list, changed in place (FR-14): today,
 * tomorrow or next Monday with the date each one means, a day of the month,
 * the time, or none. A day keeps the time and closes the popover; a new time
 * keeps it open, so a day can follow.
 */
export function DuePicker({
  todo,
  onChange,
  className,
}: {
  todo: Todo
  onChange: (input: TodoInput) => void
  className?: string
}) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const now = useNow()
  const tz = useMemo(() => browserTimeZone(), [])
  const timeId = useId()
  const [open, setOpen] = useState(false)
  const { dueDate, dueTime } = taskToForm(todo, tz)
  const shortcuts = dueShortcuts(now)
  const picks = [
    { label: t('tasks.today'), day: shortcuts.today },
    { label: t('tasks.tomorrow'), day: shortcuts.tomorrow },
    { label: t('tasks.nextWeek'), day: shortcuts.nextWeek },
  ]

  const pickDay = (day: Date) => {
    const input = withDue(todo, { date: dayKey(day), time: dueTime }, tz)
    onChange(input)
    // Today at a time already past leaves the task overdue: stay, with the time to change next.
    if (input.due && !input.dueAllDay && isOverdue(input, new Date())) document.getElementById(timeId)?.focus()
    else setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
      <PopoverContent align="end" className="w-64 p-2" aria-label={t('tasks.due')}>
        <div className="grid">
          {picks.map((p) => (
            <Button
              key={p.label}
              variant="ghost"
              size="sm"
              className="justify-between font-normal"
              onClick={() => {
                pickDay(p.day)
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
            onSelect={pickDay}
          />
        </div>
        {dueDate && (
          <div className="mt-2 grid gap-1 border-t pt-2">
            <div className="flex items-center gap-2 pl-2.5">
              <ClockIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <TimeSelect
                id={timeId}
                value={dueTime}
                onChange={(time) => {
                  onChange(withDue(todo, { date: dueDate, time }, tz))
                }}
                prefs={prefs}
                none={t('tasks.noTime')}
                placeholder={t('tasks.addTime')}
                aria-label={t('tasks.dueTime')}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start text-muted-foreground"
              onClick={() => {
                onChange(withDue(todo, { date: '', time: '' }, tz))
                setOpen(false)
              }}
            >
              <XIcon aria-hidden />
              {t('tasks.removeDue')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
