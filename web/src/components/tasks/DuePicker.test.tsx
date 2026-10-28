import { fireEvent, screen, within } from '@testing-library/react'
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

  it('saves a typed time on Enter and stays open', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('1740{Enter}')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '17:40'), dueAllDay: false }))
    expect(dialog).toBeInTheDocument()
    expect(time).toHaveFocus()

    // Saved, it doesn't wait to be saved again as the picker closes.
    await user.click(document.body)
    expect(dialog).not.toBeInTheDocument()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('saves a typed time and a picked day as one change', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ due: at(-1, '09:00') }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
    await user.keyboard('1840')
    await user.click(within(dialog).getByRole('button', { name: /^Tomorrow / }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '18:40'), dueAllDay: false }))
    expect(dialog).not.toBeInTheDocument()
  })

  it('saves a typed time when an outside click closes the picker', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
    await user.keyboard('1840')
    // The press outside leaves the field, then its click closes the picker (Radix waits for the click).
    await user.click(document.body)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '18:40'), dueAllDay: false }))
    expect(dialog).not.toBeInTheDocument()
  })

  it('saves a typed time when a press outside keeps the focus in the field', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('1840')
    // Radix listens for presses outside from a tick after opening, and closes on their click.
    await new Promise((resolve) => setTimeout(resolve))
    fireEvent.pointerDown(document.body)
    expect(time).toHaveFocus()
    fireEvent.click(document.body)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '18:40'), dueAllDay: false }))
    expect(dialog).not.toBeInTheDocument()
  })

  it('waits with a time left for the rest of the picker, and saves it as the button closes the picker', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ title: 'Call', due: at(1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('1840')
    await user.tab()
    expect(within(dialog).getByRole('button', { name: 'Remove due date' })).toHaveFocus()
    expect(time).toHaveValue('18:40')
    expect(onChange).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Change due date: Call' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '18:40'), dueAllDay: false }))
    expect(dialog).not.toBeInTheDocument()
  })

  it('saves a pending time on Enter after coming back to the field', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('1840')
    await user.tab()
    await user.tab({ shift: true })
    expect(time).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '18:40'), dueAllDay: false }))
    expect(dialog).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(dialog).not.toBeInTheDocument()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('saves a pending time when the same entry is picked', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('1840')
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
    await user.click(time)
    await user.click(screen.getByRole('option', { name: '18:40' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '18:40'), dueAllDay: false }))
    expect(dialog).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(dialog).not.toBeInTheDocument()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('saves nothing for a time typed back to the saved one', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('1840')
    await user.tab()
    await user.tab({ shift: true })
    await user.keyboard('0900{Enter}')
    expect(time).toHaveValue('09:00')
    await user.keyboard('1840')
    await user.tab()
    await user.tab({ shift: true })
    await user.keyboard('0900')
    await user.click(document.body)
    expect(dialog).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps the picker open for an unreadable time and says what to type', async () => {
    const { user, onChange, dialog } = await open(todo({ title: 'Call', due: at(1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('18:4x')
    await user.click(document.body)
    const note = 'Enter a time like 9:40 AM.'
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText(note)).toBeInTheDocument()
    expect(time).toHaveValue('18:4x')
    // Back on the time, which says what to type.
    expect(time).toHaveFocus()
    expect(time).toHaveAccessibleDescription(note)
    expect(onChange).not.toHaveBeenCalled()

    // Its button doesn't close it either.
    await user.click(screen.getByRole('button', { name: 'Change due date: Call' }))
    expect(dialog).toBeInTheDocument()
    expect(time).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()

    // Corrected, the time is saved as the picker closes.
    await user.keyboard('6:40 PM')
    await user.click(document.body)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '18:40') }))
    expect(dialog).not.toBeInTheDocument()
  })

  it('Escape drops a typed time', async () => {
    const { user, onChange, dialog } = await open(todo({ title: 'Call', due: at(1, '09:00') }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
    // The first Escape closes the list and restores the time, the second the picker.
    await user.keyboard('1840{Escape}')
    expect(dialog).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(dialog).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()

    // A time left for the rest of the picker is dropped too.
    const trigger = screen.getByRole('button', { name: 'Change due date: Call' })
    await user.click(trigger)
    const again = screen.getByRole('dialog', { name: 'Due date' })
    await user.click(within(again).getByRole('combobox', { name: 'Due time' }))
    await user.keyboard('1840')
    await user.tab()
    await user.keyboard('{Escape}')
    expect(again).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()

    await user.click(trigger)
    const time = within(screen.getByRole('dialog', { name: 'Due date' })).getByRole('combobox', { name: 'Due time' })
    expect(time).toHaveValue('9:00 AM')
  })

  it("saves nothing when a day, a shortcut or Remove due date is picked while the time can't be read", async () => {
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('18:4x')
    const note = 'Enter a time like 9:40 AM.'
    for (const pick of [
      within(dialog).getByRole('button', { name: /^Tomorrow / }),
      within(dialog).getByRole('button', { name: format(addDays(new Date(), 1), 'PPPP') }),
      within(dialog).getByRole('button', { name: 'Remove due date' }),
    ]) {
      await user.click(pick)
      expect(onChange).not.toHaveBeenCalled()
      expect(dialog).toBeInTheDocument()
      expect(within(dialog).getByText(note)).toBeInTheDocument()
      expect(time).toHaveValue('18:4x')
      expect(time).toHaveFocus()
    }
  })

  // A click without the press before it, as assistive technology sends one, finds the focus still in the time: the
  // pick reads what was typed there all the same (FR-14).
  it.each([
    ['a shortcut', (dialog: HTMLElement) => within(dialog).getByRole('button', { name: /^Tomorrow / })],
    ['a day', (dialog: HTMLElement) => within(dialog).getByRole('button', { name: format(addDays(new Date(), 1), 'PPPP') })],
  ])('saves a typed time with %s clicked while the time still has the focus, as one change', async (_, pick) => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ due: at(-1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('1840')
    fireEvent.click(pick(dialog))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '18:40'), dueAllDay: false }))
    expect(dialog).not.toBeInTheDocument()
  })

  // The picker's own button closes it too, also with a click without the press before it (FR-14).
  it('saves a typed time as its button closes the picker while the time still has the focus', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ title: 'Call', due: at(1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('1840')
    fireEvent.click(screen.getByRole('button', { name: 'Change due date: Call' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '18:40'), dueAllDay: false }))
    expect(dialog).not.toBeInTheDocument()
  })

  it("stays open as its button is clicked while the time that still has the focus can't be read", async () => {
    const { user, onChange, dialog } = await open(todo({ title: 'Call', due: at(1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('18:4x')
    fireEvent.click(screen.getByRole('button', { name: 'Change due date: Call' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText('Enter a time like 9:40 AM.')).toBeInTheDocument()
    expect(time).toHaveFocus()
  })

  it("removes nothing while the time that still has the focus can't be read", async () => {
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('18:4x')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove due date' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText('Enter a time like 9:40 AM.')).toBeInTheDocument()
    expect(time).toHaveFocus()
  })

  it('says below the time what to type, and saves nothing', async () => {
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    const time = within(dialog).getByRole('combobox', { name: 'Due time' })
    await user.click(time)
    await user.keyboard('9:4x{Enter}')
    const note = 'Enter a time like 9:40 AM.'
    expect(within(dialog).getByText(note)).toBeInTheDocument()
    expect(time).toHaveValue('9:4x')
    expect(time).toHaveAttribute('aria-invalid', 'true')
    expect(time).toHaveAccessibleDescription(note)
    expect(onChange).not.toHaveBeenCalled()

    await user.keyboard('9:40{Enter}')
    expect(within(dialog).queryByText(note)).toBeNull()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '09:40') }))
  })

  it('removes the time with its ✕ and stays open', async () => {
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    await user.click(within(dialog).getByRole('button', { name: 'Remove due time' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: allDay(addDays(new Date(), 1)), dueAllDay: true }))
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

  it('removes the due date with a time typed and left in one save, and saves nothing more as it closes', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
    await user.keyboard('1840')
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Remove due date' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: null, dueAllDay: false }))
    expect(dialog).not.toBeInTheDocument()
    await user.click(document.body)
    expect(onChange).toHaveBeenCalledTimes(1)
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

    it('asks once for a typed time and a picked day', async () => {
      useSettings.setState({ timeFormat: '24h' })
      const { user, onChange, onScope, dialog } = await open(series)
      await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
      await user.keyboard('1840')
      await user.click(within(dialog).getByRole('button', { name: 'Friday, October 9th, 2026' }))

      const ask = within(dialog).getByRole('alertdialog', { name: question })
      expect(onScope).not.toHaveBeenCalled()
      await user.click(within(ask).getByRole('button', { name: 'All repeats' }))
      expect(onScope).toHaveBeenCalledTimes(1)
      // Friday at 18:40 Berlin time.
      expect(onScope).toHaveBeenCalledWith('all', expect.objectContaining({ due: '2026-10-09T16:40:00.000Z', dueAllDay: false }))
      expect(onChange).not.toHaveBeenCalled()
      expect(within(dialog).queryByRole('alertdialog')).toBeNull()
      expect(dialog).not.toBeInTheDocument()
    })

    it('keeps a typed time when the series question is cancelled', async () => {
      useSettings.setState({ timeFormat: '24h' })
      const { user, onChange, onScope, dialog } = await open(series)
      const time = within(dialog).getByRole('combobox', { name: 'Due time' })
      const friday = within(dialog).getByRole('button', { name: 'Friday, October 9th, 2026' })
      await user.click(time)
      await user.keyboard('1840')
      await user.click(friday)
      // Asked already, a click outside leaves the question to its answer.
      await user.click(document.body)
      expect(within(dialog).getByRole('alertdialog', { name: question })).toBeInTheDocument()

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      expect(within(dialog).queryByRole('alertdialog')).toBeNull()
      expect(friday).toHaveFocus()
      expect(time).toHaveValue('18:40')
      await user.click(friday)
      await user.keyboard('{Escape}')
      expect(within(dialog).queryByRole('alertdialog')).toBeNull()
      expect(time).toHaveValue('18:40')
      expect(onChange).not.toHaveBeenCalled()
      expect(onScope).not.toHaveBeenCalled()

      await user.click(friday)
      await user.click(within(dialog).getByRole('button', { name: 'All repeats' }))
      expect(onScope).toHaveBeenCalledTimes(1)
      expect(onScope).toHaveBeenCalledWith('all', expect.objectContaining({ due: '2026-10-09T16:40:00.000Z', dueAllDay: false }))
      expect(onChange).not.toHaveBeenCalled()
    })

    it('keeps a time entered when its question is cancelled', async () => {
      useSettings.setState({ timeFormat: '24h' })
      const { user, onScope, dialog } = await open(series)
      const time = within(dialog).getByRole('combobox', { name: 'Due time' })
      await user.click(time)
      await user.keyboard('1840{Enter}')
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      expect(time).toHaveValue('18:40')
      expect(onScope).not.toHaveBeenCalled()

      // Asked again as the picker closes.
      await user.click(document.body)
      await user.click(within(dialog).getByRole('button', { name: 'All repeats' }))
      expect(onScope).toHaveBeenCalledTimes(1)
      // Monday, Oct 5, at 18:40 Berlin time.
      expect(onScope).toHaveBeenCalledWith('all', expect.objectContaining({ due: '2026-10-05T16:40:00.000Z', dueAllDay: false }))
    })

    it("keeps a typed time when the series can't move there", async () => {
      useSettings.setState({ timeFormat: '24h' })
      const { user, onChange, onScope, dialog } = await open({ ...monthly, hasAttendees: true })
      const time = within(dialog).getByRole('combobox', { name: 'Due time' })
      await user.click(time)
      await user.keyboard('1840')
      await user.click(within(dialog).getByRole('button', { name: 'Friday, October 16th, 2026' }))
      expect(within(dialog).getByText("Can't move. The series stays on its days.")).toBeInTheDocument()
      expect(time).toHaveValue('18:40')
      expect(onChange).not.toHaveBeenCalled()
      expect(onScope).not.toHaveBeenCalled()

      // On its own day, the time moves all repeats: saved as the picker closes.
      await user.click(document.body)
      expect(onScope).toHaveBeenCalledTimes(1)
      // Thursday, Oct 15, at 18:40 Berlin time.
      expect(onScope).toHaveBeenCalledWith('all', expect.objectContaining({ due: '2026-10-15T16:40:00.000Z', dueAllDay: false }))
      expect(onChange).not.toHaveBeenCalled()
      expect(dialog).not.toBeInTheDocument()
    })

    describe('a time the series refuses (FR-14, FR-17)', () => {
      // At 9:00 Berlin time on the 15th, the hour fixed by its rule, with attendees: no repeat moves to another time.
      const atNine = {
        ...monthly,
        due: '2026-10-15T07:00:00Z',
        dueAllDay: false,
        timezone: TZ,
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9',
        recurrenceId: '2026-10-15T07:00:00Z',
        next: { start: null, due: '2026-11-15T08:00:00Z' },
        hasAttendees: true,
      }
      const keepsTimes = "Can't move. The series keeps its times."

      it.each([
        ['click outside', () => document.body],
        ['click on its button', () => screen.getByRole('button', { name: 'Change due date: Pay rent' })],
      ])('closes on the next %s after the series refused a typed time, without it', async (_, target) => {
        useSettings.setState({ timeFormat: '24h' })
        const { user, onChange, onScope, dialog } = await open(atNine)
        const time = within(dialog).getByRole('combobox', { name: 'Due time' })
        await user.click(time)
        await user.keyboard('1840')
        await user.click(target())
        expect(dialog).toBeInTheDocument()
        expect(within(dialog).getByText(keepsTimes)).toBeInTheDocument()
        expect(time).toHaveValue('18:40')
        expect(onChange).not.toHaveBeenCalled()
        expect(onScope).not.toHaveBeenCalled()

        // The line has said why: the next click closes the picker and drops the time, without a second try.
        await user.click(target())
        expect(dialog).not.toBeInTheDocument()
        expect(onChange).not.toHaveBeenCalled()
        expect(onScope).not.toHaveBeenCalled()
        await user.click(screen.getByRole('button', { name: 'Change due date: Pay rent' }))
        expect(within(screen.getByRole('dialog', { name: 'Due date' })).getByRole('combobox', { name: 'Due time' })).toHaveValue(
          '09:00',
        )
      })

      it('tries a time changed after a refusal again', async () => {
        useSettings.setState({ timeFormat: '24h' })
        const { user, onChange, onScope, dialog } = await open(atNine)
        const time = within(dialog).getByRole('combobox', { name: 'Due time' })
        await user.click(time)
        await user.keyboard('1840')
        await user.click(document.body)
        expect(within(dialog).getByText(keepsTimes)).toBeInTheDocument()

        // Another time is another try, refused again: the picker stays open once more.
        await user.click(time)
        await user.keyboard('1900')
        await user.click(document.body)
        expect(dialog).toBeInTheDocument()
        expect(within(dialog).getByText(keepsTimes)).toBeInTheDocument()
        expect(time).toHaveValue('19:00')
        expect(onChange).not.toHaveBeenCalled()
        expect(onScope).not.toHaveBeenCalled()

        await user.click(document.body)
        expect(dialog).not.toBeInTheDocument()
        expect(onChange).not.toHaveBeenCalled()
        expect(onScope).not.toHaveBeenCalled()
      })

      it('tries a refused time again in a picker opened anew', async () => {
        useSettings.setState({ timeFormat: '24h' })
        const { user, onChange, onScope, dialog } = await open(atNine)
        await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
        await user.keyboard('1840')
        await user.click(document.body)
        expect(within(dialog).getByText(keepsTimes)).toBeInTheDocument()
        await user.keyboard('{Escape}')
        expect(dialog).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Change due date: Pay rent' }))
        const again = screen.getByRole('dialog', { name: 'Due date' })
        await user.click(within(again).getByRole('combobox', { name: 'Due time' }))
        await user.keyboard('1840')
        await user.click(document.body)
        expect(again).toBeInTheDocument()
        expect(within(again).getByText(keepsTimes)).toBeInTheDocument()
        expect(onChange).not.toHaveBeenCalled()
        expect(onScope).not.toHaveBeenCalled()
      })

      it('tries a refused time again once its refusal line is gone', async () => {
        useSettings.setState({ timeFormat: '24h' })
        const { user, onChange, onScope, dialog } = await open(atNine)
        const time = within(dialog).getByRole('combobox', { name: 'Due time' })
        await user.click(time)
        await user.keyboard('1840')
        await user.click(document.body)
        expect(within(dialog).getByText(keepsTimes)).toBeInTheDocument()

        // A day picked with the time asks the series anew: the line that said why the time alone can't move gives way
        // to the one about the day, here refused too.
        await user.click(within(dialog).getByRole('button', { name: 'Friday, October 16th, 2026' }))
        expect(within(dialog).getByText(keepsTimes)).toBeInTheDocument()
        expect(time).toHaveValue('18:40')

        // So the close tries the time alone again, which is refused again: the picker stays open once more.
        await user.click(document.body)
        expect(dialog).toBeInTheDocument()
        expect(within(dialog).getByText(keepsTimes)).toBeInTheDocument()
        expect(time).toHaveValue('18:40')
        expect(onChange).not.toHaveBeenCalled()
        expect(onScope).not.toHaveBeenCalled()

        await user.click(document.body)
        expect(dialog).not.toBeInTheDocument()
        expect(onChange).not.toHaveBeenCalled()
        expect(onScope).not.toHaveBeenCalled()
      })
    })

    // FR-17: an all-day series given a time writes it in the browser's zone, where the server then reads the move:
    // 08:00 on the 15th in Tokyo is still the 15th there, though 23:00 on the 14th in UTC.
    it('gives an all-day series a time on its day east of UTC, and names the zone', async () => {
      const originalTz = process.env.TZ
      process.env.TZ = 'Asia/Tokyo'
      try {
        useSettings.setState({ timeFormat: '24h' })
        const { user, onChange, onScope, dialog } = await open(monthly)
        await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
        await user.click(screen.getByRole('option', { name: '08:00' }))

        const ask = within(dialog).getByRole('alertdialog', { name: question })
        await user.click(within(ask).getByRole('button', { name: 'All repeats' }))
        expect(onScope).toHaveBeenCalledWith(
          'all',
          expect.objectContaining({ due: '2026-10-14T23:00:00.000Z', dueAllDay: false, timezone: 'Asia/Tokyo' }),
        )
        expect(onChange).not.toHaveBeenCalled()
      } finally {
        process.env.TZ = originalTz
      }
    })

    it('names the zone of a new day too', async () => {
      const { user, onScope, dialog } = await open(series)
      await user.click(within(dialog).getByRole('button', { name: /^Tomorrow / }))
      await user.click(within(dialog).getByRole('button', { name: 'All repeats' }))
      expect(onScope).toHaveBeenCalledWith('all', expect.objectContaining({ timezone: TZ }))
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
