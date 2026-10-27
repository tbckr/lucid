import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DateField } from '@/components/events/DateField'
import { SkippedTimeNote } from '@/components/events/SkippedTimeNote'
import { TimeField } from '@/components/events/TimeField'
import { useReadableStart } from '@/components/events/useTypedField'
import { skippedTime } from '@/lib/dates'
import { shiftEnd } from '@/lib/eventForm'
import { type FormatPrefs } from '@/lib/format'
import { shiftTask, type CreateKind, type EventWhen, type TaskWhen } from '@/lib/quickCreate'
import { isFormDate, isFormTime } from '@/lib/unreadable'
import { cn } from '@/lib/utils'

/** A time summer time skips, and the one it is saved as, with the id of its note. */
interface Note {
  id: string
  time: string
  saved: string
}

/**
 * The line below the sentence that says what is wrong with it (FR-09): what to
 * type where a date or a time field holds text it couldn't read, else an error
 * of the order of the end or due, with the id it describes the fields by.
 */
export interface WhenError {
  id: string
  about: 'date' | 'time' | 'order'
}

/**
 * When the new entry happens, as the sentence the details popover shows
 * ("Wed, Sep 30 10:15 AM – 11:15 AM", "Due Wed, Sep 30 10:15 AM"), each part a
 * quiet field on the tint. Moving the start keeps the length, also across a
 * start that couldn't be read for a while (FR-09, FR-16). A time summer time
 * skips on its date is said below, with the time it is saved as, in
 * `timeZone` (#10, FR-18). `error` is the line said below: a field is marked
 * and described by it only where it is about that field, its unreadable text
 * or, for the end or due, the order.
 */
export function QuickWhen({
  kind,
  event,
  task,
  onEvent,
  onTask,
  prefs,
  now,
  timeZone,
  error,
}: {
  kind: CreateKind
  event: EventWhen
  task: TaskWhen
  onEvent: (when: EventWhen) => void
  onTask: (when: TaskWhen) => void
  prefs: FormatPrefs
  now: Date
  timeZone: string
  error?: WhenError | undefined
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
  // A shown time summer time skips on its date, as the note said below the line (#10, FR-18).
  const skipped = (which: 'start' | 'end' | 'due', date: string, time: string): Note | null => {
    const saved = skippedTime(date, time, timeZone)
    return saved ? { id: `${id}-${which}-skipped`, time, saved } : null
  }
  // The start the length is kept from: the last one that could be read (FR-09).
  const eventStart = useReadableStart(
    event.startDate,
    event.startTime,
    isFormDate(event.startDate) && (event.allDay || isFormTime(event.startTime)),
  )
  const taskStart = useReadableStart(
    task.startDate,
    task.startTime,
    isFormDate(task.startDate) && (task.startTime === '' || isFormTime(task.startTime)),
  )
  // The end or due fields an error of the order marks.
  const invalid = error?.about === 'order'
  // The line below describes a field where it is about that field: its text it couldn't read, or the
  // order of the end or due (`marked`) (FR-09).
  const about = (part: 'date' | 'time', text: string, marked: boolean) =>
    error &&
    ((error.about === part && text !== '' && !(part === 'date' ? isFormDate(text) : isFormTime(text))) || (marked && invalid))
      ? error.id
      : undefined
  const dateNotes = (date: string, marked: boolean) => about('date', date, marked)
  const timeNotes = (time: string, note: Note | null, marked: boolean) =>
    [about('time', time, marked), note?.id].filter(Boolean).join(' ') || undefined
  const withNotes = (when: ReactNode, ...notes: (Note | null)[]) => (
    <>
      {when}
      {notes.map((n) => n && <SkippedTimeNote key={n.id} id={n.id} time={n.time} saved={n.saved} prefs={prefs} />)}
    </>
  )
  // Every part has the fields' padding, so the text of each line starts under the title's.
  const line = 'tabular -ml-1.5 flex flex-wrap items-center text-base font-medium'
  // A time range wraps after the date as a whole.
  const range = 'flex items-center whitespace-nowrap'

  if (kind === 'event') {
    const moveStart = (date: string, time: string) => {
      const from = { ...event, startDate: eventStart.date, startTime: eventStart.time }
      onEvent({ ...event, startDate: date, startTime: time, ...shiftEnd(from, date, time) })
    }
    const start = event.allDay ? null : skipped('start', event.startDate, event.startTime)
    const end = event.allDay ? null : skipped('end', event.endDate, event.endTime)
    return withNotes(
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
          describedBy={dateNotes(event.startDate, false)}
          tone={tint}
        />
        {event.allDay ? (
          <span className="px-1.5">{t('event.allDay')}</span>
        ) : (
          // A range ending on another day may break at its dash; others wrap as a whole.
          <span className={cn(range, shown.end && 'flex-wrap')}>
            <TimeField
              value={event.startTime}
              onChange={(v) => {
                moveStart(event.startDate, v)
              }}
              prefs={prefs}
              describedBy={timeNotes(event.startTime, start, false)}
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
                describedBy={dateNotes(event.endDate, true)}
                tone={tint}
              />
            )}
            <TimeField
              value={event.endTime}
              onChange={(v) => {
                onEvent({ ...event, endTime: v })
              }}
              prefs={prefs}
              invalid={invalid}
              describedBy={timeNotes(event.endTime, end, true)}
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
      </div>,
      start,
      end,
    )
  }

  // A span keeps one date for start and due unless they differ.
  if (task.startDate && task.dueDate) {
    const start = skipped('start', task.startDate, task.startTime)
    const due = skipped('due', task.dueDate, task.dueTime)
    return withNotes(
      <div className={line}>
        <DateField
          id={`${id}-date`}
          labelledBy={`${id}-date-label`}
          label={t('tasks.start')}
          value={task.startDate}
          onChange={(d) => {
            onTask(shiftTask(task, d, task.startTime, taskStart))
          }}
          prefs={prefs}
          now={now}
          describedBy={dateNotes(task.startDate, false)}
          tone={tint}
        />
        <span className={cn(range, shown.due && 'flex-wrap')}>
          {task.startTime && (
            <TimeField
              value={task.startTime}
              onChange={(v) => {
                onTask(shiftTask(task, task.startDate, v, taskStart))
              }}
              prefs={prefs}
              describedBy={timeNotes(task.startTime, start, false)}
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
              describedBy={dateNotes(task.dueDate, true)}
              tone={tint}
            />
          )}
          {task.dueTime && (
            <TimeField
              value={task.dueTime}
              onChange={(v) => {
                onTask({ ...task, dueTime: v })
              }}
              prefs={prefs}
              invalid={invalid}
              describedBy={timeNotes(task.dueTime, due, true)}
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
      </div>,
      start,
      due,
    )
  }

  // A single date: due, or the start a task from elsewhere may have instead.
  const which = task.dueDate || !task.startDate ? 'due' : 'start'
  const date = which === 'due' ? task.dueDate : task.startDate
  const time = which === 'due' ? task.dueTime : task.startTime
  const note = skipped(which, date, time)
  return withNotes(
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
        describedBy={dateNotes(date, true)}
        tone={tint}
      />
      <TimeField
        value={time}
        onChange={(v) => {
          onTask(shiftTask(task, date, v))
        }}
        none={t('tasks.noTime')}
        placeholder={t('tasks.addTime')}
        prefs={prefs}
        describedBy={timeNotes(time, note, false)}
        aria-label={which === 'due' ? t('tasks.dueTime') : t('tasks.startTime')}
        tone={tint}
      />
    </div>,
    note,
  )
}
