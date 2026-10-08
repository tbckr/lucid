import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { addDays, format, nextMonday } from 'date-fns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { type Todo } from '@/lib/api/schemas'
import { dayKey, zonedToUtc } from '@/lib/dates'
import { defaultSettings, useSettings } from '@/stores/settings'
import { calendar, todo } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { DuePicker } from './DuePicker'

const TZ = 'Europe/Berlin'
/** `time` on the day `days` from today, on the wire. */
const at = (days: number, time: string) => zonedToUtc(dayKey(addDays(new Date(), days)), time, TZ).toISOString()
const allDay = (day: Date) => `${dayKey(day)}T00:00:00.000Z`

async function open(t: Todo) {
  const onChange = vi.fn()
  const onScope = vi.fn()
  const user = userEvent.setup()
  // The calendars are loaded by the time the list shows a task.
  renderWithProviders(<DuePicker todo={t} onChange={onChange} onScope={onScope} />, (qc) => {
    qc.setQueryData(queryKeys.calendars, [calendar()])
  })
  await user.click(screen.getByRole('button', { name: `Change due date: ${t.title}` }))
  return { user, onChange, onScope, dialog: screen.getByRole('dialog', { name: 'Due date' }) }
}

/** The buttons of `question`, each by its text: an option's label, then its note. */
const buttons = (question: HTMLElement) => within(question).getAllByRole('button').map((b) => b.textContent)

describe('DuePicker', () => {
  afterEach(() => {
    useSettings.setState(defaultSettings)
  })

  it('offers today, tomorrow and the next Monday with their dates', async () => {
    const { dialog } = await open(todo())
    const picks = within(dialog)
      .getAllByRole('button', { name: /^(Today|Tomorrow|Next week) / })
      .map((b) => b.textContent)
    expect(picks).toHaveLength(3)
    expect(picks[2]).toMatch(/^Next week Mon, /)
  })

  it('moves the due date to tomorrow at its time and closes', async () => {
    const { user, onChange, dialog } = await open(todo({ title: 'Call', due: at(-1, '09:00') }))
    await user.click(within(dialog).getByRole('button', { name: /^Tomorrow / }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '09:00'), dueAllDay: false }))
    expect(dialog).not.toBeInTheDocument()
  })

  it('keeps an all-day due date all-day', async () => {
    const { user, onChange } = await open(todo({ due: allDay(addDays(new Date(), -1)), dueAllDay: true }))
    await user.click(screen.getByRole('button', { name: /^Next week / }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: allDay(nextMonday(new Date())), dueAllDay: true }))
  })

  it('stays open on a time already past today and focuses the time', async () => {
    const { user, onChange, dialog } = await open(todo({ due: at(-1, '00:00') }))
    await user.click(within(dialog).getByRole('button', { name: /^Today / }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(0, '00:00') }))
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'Due time' })).toHaveFocus()
  })

  it('changes the time and stays open', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
    await user.click(screen.getByRole('option', { name: '17:00' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '17:00'), dueAllDay: false }))
    expect(dialog).toBeInTheDocument()
  })

  it('picks a day in the month', async () => {
    const { user, onChange } = await open(todo())
    await user.click(screen.getByRole('button', { name: format(new Date(), 'PPPP') }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: allDay(new Date()), dueAllDay: true }))
  })

  it('removes the due date', async () => {
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    await user.click(within(dialog).getByRole('button', { name: 'Remove due date' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: null }))
    expect(dialog).not.toBeInTheDocument()
  })

  it('offers neither a time nor a removal without a due date', async () => {
    const { dialog } = await open(todo())
    expect(within(dialog).queryByRole('combobox', { name: 'Due time' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Remove due date' })).toBeNull()
  })

  describe('a series (FR-17)', () => {
    // Due Monday, Oct 5, on Mondays and Thursdays; Monday's is the current repeat.
    const series = todo({
      title: 'Water the flowers',
      due: '2026-10-05T00:00:00Z',
      dueAllDay: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
      recurring: true,
      fixedDays: true,
      recurrenceId: '2026-10-05T00:00:00Z',
      next: { start: null, due: '2026-10-08T00:00:00Z' },
    })
    // On the 15th of each month; October's is the current repeat.
    const monthly = {
      ...series,
      title: 'Pay rent',
      due: '2026-10-15T00:00:00Z',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
      recurrenceId: '2026-10-15T00:00:00Z',
      next: { start: null, due: '2026-11-15T00:00:00Z' },
    }
    const question = 'This task repeats. Which repeats should move?'
    const moveAll = "Moves all repeats. With attendees, a repeat can't become a task of its own."

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 9, 5, 12))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('asks which repeats a picked day moves, and reports the choice', async () => {
      const { user, onChange, onScope, dialog } = await open(series)
      await user.click(within(dialog).getByRole('button', { name: /^Tomorrow / }))

      const ask = within(dialog).getByRole('alertdialog', { name: question })
      expect(buttons(ask)).toEqual([
        'Only this repeatBecomes a task of its own. The series goes on Thu, Oct 8.',
        'All repeatsDone ones stay.',
        'Cancel',
      ])
      expect(within(ask).getByRole('button', { name: 'Only this repeat' })).toHaveFocus()
      expect(dialog).toHaveClass('w-80')
      expect(onScope).not.toHaveBeenCalled()

      await user.click(within(ask).getByRole('button', { name: 'Only this repeat' }))
      expect(onScope).toHaveBeenCalledWith(
        'this',
        expect.objectContaining({ title: 'Water the flowers', due: '2026-10-06T00:00:00.000Z', dueAllDay: true }),
      )
      expect(onChange).not.toHaveBeenCalled()
      expect(dialog).not.toBeInTheDocument()
    })

    it('goes back to the month on Escape or Cancel, and stays open', async () => {
      const { user, onChange, onScope, dialog } = await open(series)
      const tomorrow = within(dialog).getByRole('button', { name: /^Tomorrow / })
      await user.click(tomorrow)
      expect(within(dialog).getByRole('alertdialog', { name: question })).toBeInTheDocument()

      await user.keyboard('{Escape}')
      expect(within(dialog).queryByRole('alertdialog')).toBeNull()
      expect(dialog).toBeInTheDocument()
      expect(tomorrow).toBeVisible()
      expect(tomorrow).toHaveFocus()

      const friday = within(dialog).getByRole('button', { name: 'Friday, October 9th, 2026' })
      await user.click(friday)
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      expect(within(dialog).queryByRole('alertdialog')).toBeNull()
      expect(friday).toHaveFocus()
      expect(onScope).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
    })

    it('asks after a new time too, and stays open on the time after "All repeats"', async () => {
      useSettings.setState({ timeFormat: '24h' })
      // The same series due at 9:00 Berlin time.
      const timed = {
        ...series,
        due: '2026-10-05T07:00:00Z',
        dueAllDay: false,
        timezone: TZ,
        recurrenceId: '2026-10-05T07:00:00Z',
        next: { start: null, due: '2026-10-08T07:00:00Z' },
      }
      const { user, onChange, onScope, dialog } = await open(timed)
      await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
      await user.click(screen.getByRole('option', { name: '17:00' }))

      const ask = within(dialog).getByRole('alertdialog', { name: question })
      await user.click(within(ask).getByRole('button', { name: 'All repeats' }))
      expect(onScope).toHaveBeenCalledWith('all', expect.objectContaining({ due: '2026-10-05T15:00:00.000Z', dueAllDay: false }))
      expect(onChange).not.toHaveBeenCalled()
      expect(dialog).toBeInTheDocument()
      expect(within(dialog).getByRole('combobox', { name: 'Due time' })).toHaveFocus()
    })

    it('offers every shortcut and day, earlier ones too', async () => {
      const { dialog } = await open(series)
      expect(within(dialog).getByRole('button', { name: /^Next week / })).not.toBeDisabled()
      expect(within(dialog).getByRole('button', { name: 'Friday, October 9th, 2026' })).not.toHaveAttribute('aria-disabled')
      expect(within(dialog).getByRole('button', { name: 'Sunday, October 4th, 2026' })).not.toHaveAttribute('aria-disabled')
      expect(within(dialog).queryByText(/^Until /)).toBeNull()
    })

    it('moves the last repeat at once, as a single task', async () => {
      const { user, onChange, onScope, dialog } = await open({ ...series, next: null })
      expect(within(dialog).queryByText(/repeats/)).toBeNull()
      await user.click(within(dialog).getByRole('button', { name: /^Tomorrow / }))
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: '2026-10-06T00:00:00.000Z', dueAllDay: true }))
      expect(onScope).not.toHaveBeenCalled()
      expect(dialog).not.toBeInTheDocument()
    })

    it('moves only this repeat at once where the series cannot follow the day', async () => {
      const { user, onChange, onScope, dialog } = await open(monthly)
      await user.click(within(dialog).getByRole('button', { name: 'Friday, October 16th, 2026' }))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(onScope).toHaveBeenCalledWith('this', expect.objectContaining({ due: '2026-10-16T00:00:00.000Z' }))
      expect(onChange).not.toHaveBeenCalled()
      expect(dialog).not.toBeInTheDocument()
    })

    it("says why a series with attendees can't move to a day, and saves nothing", async () => {
      const { user, onChange, onScope, dialog } = await open({ ...monthly, hasAttendees: true })
      // On fixed days the day decides, so nothing is said before a pick.
      expect(within(dialog).queryByText(moveAll)).toBeNull()

      await user.click(within(dialog).getByRole('button', { name: 'Friday, October 16th, 2026' }))
      expect(within(dialog).getByText("Can't move. The series stays on its days.")).toBeInTheDocument()
      expect(within(dialog).queryByRole('alertdialog')).toBeNull()
      expect(onScope).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
      expect(dialog).toBeInTheDocument()
      // The day stays unpicked.
      expect(within(dialog).getByRole('button', { name: 'Thursday, October 15th, 2026' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('says beforehand that a series with attendees moves all repeats, and moves them at once', async () => {
      // Every week from its due date: the day decides nothing.
      const weekly = { ...series, rrule: 'FREQ=WEEKLY', fixedDays: false, hasAttendees: true }
      const { user, onChange, onScope, dialog } = await open(weekly)
      expect(within(dialog).getByText(moveAll)).toBeInTheDocument()

      await user.click(within(dialog).getByRole('button', { name: /^Tomorrow / }))
      expect(within(dialog).queryByRole('alertdialog')).toBeNull()
      expect(onScope).toHaveBeenCalledWith('all', expect.objectContaining({ due: '2026-10-06T00:00:00.000Z' }))
      expect(onChange).not.toHaveBeenCalled()
      expect(dialog).not.toBeInTheDocument()
    })

    // A repeating task needs a date to repeat from: the server refuses a series without one.
    it('keeps the due date of a series without a start', async () => {
      const { dialog } = await open(series)
      expect(within(dialog).getByRole('combobox', { name: 'Due time' })).toBeInTheDocument()
      expect(within(dialog).queryByRole('button', { name: 'Remove due date' })).toBeNull()
    })

    it('removes the due date of a series with a start', async () => {
      const dated = { ...series, start: '2026-10-05T00:00:00Z', startAllDay: true }
      const { user, onScope, dialog } = await open(dated)
      await user.click(within(dialog).getByRole('button', { name: 'Remove due date' }))
      await user.click(within(dialog).getByRole('button', { name: 'All repeats' }))
      expect(onScope).toHaveBeenCalledWith('all', expect.objectContaining({ start: '2026-10-05T00:00:00Z', due: null }))
    })

    it('says nothing beforehand for a series without attendees', async () => {
      const { dialog } = await open({ ...series, rrule: 'FREQ=WEEKLY', fixedDays: false })
      expect(within(dialog).queryByText(/repeats/)).toBeNull()
    })
  })
})
