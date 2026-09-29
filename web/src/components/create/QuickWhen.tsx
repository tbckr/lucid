import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DateField } from '@/components/events/DateField'
import { TimeSelect } from '@/components/events/TimeSelect'
import { shiftEnd } from '@/lib/eventForm'
import { type FormatPrefs } from '@/lib/format'
import { shiftTask, type CreateKind, type EventWhen, type TaskWhen } from '@/lib/quickCreate'
import { cn } from '@/lib/utils'

/**
 * When the new entry happens, as the sentence the details popover shows
 * ("Wed, Sep 30 10:15 AM – 11:15 AM", "Due Wed, Sep 30 10:15 AM"), each part a
 * quiet field on the tint. Moving the start keeps the length (FR-09, FR-16).
 */
export function QuickWhen({
  kind,
  event,
  task,
  onEvent,
  onTask,
  prefs,
  now,
  invalid,
  describedBy,
}: {
  kind: CreateKind
  event: EventWhen
  task: TaskWhen
  onEvent: (when: EventWhen) => void
  onTask: (when: TaskWhen) => void
  prefs: FormatPrefs
  now: Date
  invalid?: boolean
  describedBy?: string | undefined
}) {
  const { t } = useTranslation()
  const id = useId()
  // An end or due date on another day shows as a field, and stays once shown: set back to
  // the start's day, it would vanish under the focus.
  const endDiffers = event.endDate !== event.startDate
  const dueDiffers = task.startDate !== '' && task.dueDate !== '' && task.dueDate !== task.startDate
  const [shown, setShown] = useState({ end: endDiffers, due: dueDiffers })
  if ((endDiffers && !shown.end) || (dueDiffers && !shown.due)) {
    setShown({ end: shown.end || endDiffers, due: shown.due || dueDiffers })
  }
  const tint = 'tint' as const
  // Every part has the fields' padding, so the text of each line starts under the title's.
  const line = 'tabular -ml-1.5 flex flex-wrap items-center text-base font-medium'
  // A time range wraps after the date as a whole.
  const range = 'flex items-center whitespace-nowrap'

  if (kind === 'event') {
    const moveStart = (date: string, time: string) => {
      onEvent({ ...event, startDate: date, startTime: time, ...shiftEnd(event, date, time) })
    }
    return (
      <div className={line}>
        <DateField
          id={`${id}-start`}
          labelledBy={`${id}-starts`}
          label={t('event.startDate')}
          value={event.startDate}
          onChange={(d) => {
            moveStart(d, event.startTime)
          }}
          prefs={prefs}
          now={now}
          tone={tint}
        />
        {event.allDay ? (
          <span className="px-1.5">{t('event.allDay')}</span>
        ) : (
          // A range ending on another day may break at its dash; others wrap as a whole.
          <span className={cn(range, shown.end && 'flex-wrap')}>
            <TimeSelect
              value={event.startTime}
              onChange={(v) => {
                moveStart(event.startDate, v)
              }}
              prefs={prefs}
              aria-label={t('event.startTime')}
              tone={tint}
            />
            <span aria-hidden>–</span>
            {shown.end && (
              <DateField
                id={`${id}-end`}
                labelledBy={`${id}-ends`}
                label={t('event.endDate')}
                value={event.endDate}
                onChange={(d) => {
                  onEvent({ ...event, endDate: d })
                }}
                prefs={prefs}
                now={now}
                invalid={invalid}
                describedBy={describedBy}
                tone={tint}
              />
            )}
            <TimeSelect
              value={event.endTime}
              onChange={(v) => {
                onEvent({ ...event, endTime: v })
              }}
              prefs={prefs}
              invalid={invalid}
              aria-label={t('event.endTime')}
              tone={tint}
            />
          </span>
        )}
        <span id={`${id}-starts`} className="sr-only">
          {t('event.starts')}
        </span>
        <span id={`${id}-ends`} className="sr-only">
          {t('event.ends')}
        </span>
      </div>
    )
  }

  // A span keeps one date for start and due unless they differ.
  if (task.startDate && task.dueDate) {
    return (
      <div className={line}>
        <DateField
          id={`${id}-date`}
          labelledBy={`${id}-date-label`}
          label={t('tasks.start')}
          value={task.startDate}
          onChange={(d) => {
            onTask(shiftTask(task, d, task.startTime))
          }}
          prefs={prefs}
          now={now}
          tone={tint}
        />
        <span className={cn(range, shown.due && 'flex-wrap')}>
          {task.startTime && (
            <TimeSelect
              value={task.startTime}
              onChange={(v) => {
                onTask(shiftTask(task, task.startDate, v))
              }}
              prefs={prefs}
              aria-label={t('tasks.startTime')}
              tone={tint}
            />
          )}
          <span aria-hidden>–</span>
          {shown.due && (
            <DateField
              id={`${id}-due`}
              labelledBy={`${id}-due-label`}
              label={t('tasks.due')}
              value={task.dueDate}
              onChange={(d) => {
                onTask({ ...task, dueDate: d })
              }}
              prefs={prefs}
              now={now}
              invalid={invalid}
              describedBy={describedBy}
              tone={tint}
            />
          )}
          {task.dueTime && (
            <TimeSelect
              value={task.dueTime}
              onChange={(v) => {
                onTask({ ...task, dueTime: v })
              }}
              prefs={prefs}
              invalid={invalid}
              aria-label={t('tasks.dueTime')}
              tone={tint}
            />
          )}
        </span>
        <span id={`${id}-date-label`} className="sr-only">
          {t('create.date')}
        </span>
        <span id={`${id}-due-label`} className="sr-only">
          {t('tasks.dueLabel')}
        </span>
      </div>
    )
  }

  // A single date: due, or the start a task from elsewhere may have instead.
  const which = task.dueDate || !task.startDate ? 'due' : 'start'
  const date = which === 'due' ? task.dueDate : task.startDate
  const time = which === 'due' ? task.dueTime : task.startTime
  return (
    <div className={line}>
      <span id={`${id}-label`} className="px-1.5">
        {which === 'due' ? t('tasks.dueLabel') : t('tasks.startLabel')}
      </span>
      <DateField
        id={`${id}-date`}
        labelledBy={`${id}-label`}
        label={which === 'due' ? t('tasks.due') : t('tasks.start')}
        value={date}
        onChange={(d) => {
          onTask(shiftTask(task, d, time))
        }}
        prefs={prefs}
        now={now}
        invalid={invalid}
        describedBy={describedBy}
        tone={tint}
      />
      <TimeSelect
        value={time}
        onChange={(v) => {
          onTask(shiftTask(task, date, v))
        }}
        none={t('tasks.noTime')}
        placeholder={t('tasks.addTime')}
        prefs={prefs}
        aria-label={which === 'due' ? t('tasks.dueTime') : t('tasks.startTime')}
        tone={tint}
      />
    </div>
  )
}
