import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type OffRule } from '@/lib/recurrence'
import { renderWithProviders } from '@/test/render'
import { RecurrenceDialog } from './RecurrenceDialog'

// A Wednesday, the second of its month; the test locale (en-US) starts the week on Sunday.
const start = new Date(2026, 2, 11, 9, 0)

function open(rule: string, offRule?: OffRule) {
  const onDone = vi.fn<(rule: string) => void>()
  const onOpenChange = vi.fn<(open: boolean) => void>()
  renderWithProviders(
    <RecurrenceDialog
      open
      onOpenChange={onOpenChange}
      rule={rule}
      start={start}
      timeZone="Europe/Berlin"
      onDone={onDone}
      {...(offRule ? { offRule } : {})}
    />,
  )
  const dialog = screen.getByRole('dialog', { name: 'Custom repeat' })
  return { dialog, onDone, onOpenChange, user: userEvent.setup() }
}

const preview = (dialog: HTMLElement) =>
  within(within(dialog).getByRole('region', { name: 'Next dates' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent)

async function pick(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, combobox: string, option: string) {
  await user.click(within(dialog).getByRole('combobox', { name: combobox }))
  await user.click(screen.getByRole('option', { name: option }))
}

describe('RecurrenceDialog', () => {
  it('opens on the rule it was given, in words', () => {
    const { dialog } = open('FREQ=WEEKLY')
    expect(within(dialog).getByText('Every week on Wednesday')).toBeInTheDocument()
    expect(within(dialog).getByRole('spinbutton', { name: 'Repeat every' })).toHaveValue(1)
    expect(within(dialog).getByRole('button', { name: 'Wednesday' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(dialog).getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('puts every change into words and hands back the rule on Done', async () => {
    const { dialog, onDone, onOpenChange, user } = open('FREQ=WEEKLY')
    const interval = within(dialog).getByRole('spinbutton', { name: 'Repeat every' })
    await user.clear(interval)
    await user.type(interval, '2')
    await user.click(within(dialog).getByRole('button', { name: 'Monday' }))
    expect(within(dialog).getByText('Every 2 weeks on Monday and Wednesday')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    // Weeks start on Sunday here, so the rule says so: the server pairs the days up the same way.
    expect(onDone).toHaveBeenCalledWith('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=SU')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('repeats on the nth kind of day of the month, and lists the dates', async () => {
    const { dialog, user } = open('FREQ=WEEKLY')
    await pick(user, dialog, 'Days, weeks, months or years', 'month')
    await user.click(within(dialog).getByRole('radio', { name: 'On the' }))
    await pick(user, dialog, 'Which one', 'last')
    await pick(user, dialog, 'Day', 'weekday')
    expect(within(dialog).getByText('Every month on the last weekday')).toBeInTheDocument()
    expect(preview(dialog).slice(0, 3)).toEqual(['Wed, Mar 11', 'Tue, Mar 31', 'Thu, Apr 30'])
  })

  it('ends after a number of times, and says that no more follow', async () => {
    const { dialog, user } = open('FREQ=WEEKLY')
    await user.click(within(dialog).getByRole('radio', { name: 'After' }))
    const count = within(dialog).getByRole('spinbutton', { name: 'Number of times' })
    await user.clear(count)
    await user.type(count, '3')
    expect(within(dialog).getByText('Every week on Wednesday, 3 times')).toBeInTheDocument()
    expect(preview(dialog)).toEqual(['Wed, Mar 11', 'Wed, Mar 18', 'Wed, Mar 25'])
    expect(within(dialog).getByText('No more after these.')).toBeInTheDocument()
  })

  // NFR-27: tabbing through the count field on the way to Done must not end the series.
  it('keeps "Never" when the count field only gets the focus', async () => {
    const { dialog, onDone, user } = open('FREQ=WEEKLY')
    await user.click(within(dialog).getByRole('spinbutton', { name: 'Number of times' }))
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalledWith('FREQ=WEEKLY')
  })

  it('ends after a number of times once one is typed', async () => {
    const { dialog, onDone, user } = open('FREQ=WEEKLY')
    const count = within(dialog).getByRole('spinbutton', { name: 'Number of times' })
    await user.clear(count)
    await user.type(count, '4')
    expect(within(dialog).getByRole('radio', { name: 'After' })).toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalledWith('FREQ=WEEKLY;COUNT=4')
  })

  it('says what to type for an unreadable end date', async () => {
    // Only the date, as the example in the message is today's: the start, here.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    try {
      const { dialog, onDone, user } = open('FREQ=WEEKLY')
      const until = within(dialog).getByRole('combobox', { name: 'On' })
      await user.click(until)
      await user.keyboard('13/45')
      await user.tab()
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a date like 3/11/2026.')
      expect(until).toHaveAttribute('aria-invalid', 'true')
      expect(until).toHaveAccessibleDescription('Enter a date like 3/11/2026.')
      // Typing a date chooses the end by date; the rule stays as it was until the date can be read.
      expect(within(dialog).getByRole('radio', { name: 'On' })).toBeChecked()
      expect(within(dialog).getByRole('button', { name: 'Done' })).toBeDisabled()

      await user.click(until)
      await user.keyboard('4/1{Enter}')
      expect(within(dialog).queryByRole('alert')).toBeNull()
      await user.click(within(dialog).getByRole('button', { name: 'Done' }))
      expect(onDone).toHaveBeenCalledWith('FREQ=WEEKLY;UNTIL=20260401')
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes a typed end date before the start, and says why it refuses it', async () => {
    const { dialog, user } = open('FREQ=WEEKLY')
    await user.click(within(dialog).getByRole('combobox', { name: 'On' }))
    await user.keyboard('3/1/2026{Enter}')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('The end date is before the start.')
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeDisabled()
  })

  it('refuses an end before the start', () => {
    const { dialog } = open('FREQ=WEEKLY;UNTIL=20260301')
    expect(within(dialog).getByText('The end date is before the start.')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeDisabled()
  })

  it.each(['0', '', '1000'])('refuses %j as the interval', async (value) => {
    const { dialog, user } = open('FREQ=WEEKLY')
    const interval = within(dialog).getByRole('spinbutton', { name: 'Repeat every' })
    await user.clear(interval)
    if (value) await user.type(interval, value)
    // Announced as it appears (NFR-27).
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a number from 1 to 999.')
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeDisabled()
  })

  it('warns before it replaces a rule it cannot show in full', async () => {
    const { dialog, onDone, user } = open('FREQ=MONTHLY;BYMONTHDAY=-2')
    expect(
      within(dialog).getByText(
        "This repeat comes from another app and Lucid can't show all of it here. Done replaces it with the repeat above.",
      ),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalledWith('FREQ=MONTHLY')
  })

  // FR-17: a task's series starts over on any new rule text, so an untouched rule goes back as it came.
  it('hands back an untouched rule verbatim', async () => {
    const { dialog, onDone, user } = open('FREQ=WEEKLY;INTERVAL=1;BYDAY=WE')
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalledWith('FREQ=WEEKLY;INTERVAL=1;BYDAY=WE')
  })

  it('makes a rule of "Does not repeat" on Done', async () => {
    const { dialog, onDone, user } = open('')
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalledWith('FREQ=WEEKLY')
  })

  it('cancels without a rule', async () => {
    const { dialog, onDone, onOpenChange, user } = open('FREQ=WEEKLY')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('says which months a late day skips', async () => {
    const { dialog, user } = open('FREQ=MONTHLY')
    const days = within(dialog).getByRole('toolbar', { name: 'Days of the month' })
    await user.click(within(days).getByRole('button', { name: '31' }))
    await user.click(within(days).getByRole('button', { name: '11' }))
    expect(within(dialog).getByText('Every month on day 31')).toBeInTheDocument()
    expect(
      within(dialog).getByText('Months without day 31 are skipped. Choose “Last” to repeat at the end of every month.'),
    ).toBeInTheDocument()
  })

  it('says that the start counts where the repeat does not fall on it', async () => {
    const { dialog, user } = open('FREQ=WEEKLY')
    await user.click(within(dialog).getByRole('button', { name: 'Monday' }))
    await user.click(within(dialog).getByRole('button', { name: 'Thursday' }))
    await user.click(within(dialog).getByRole('button', { name: 'Wednesday' }))
    expect(
      within(dialog).getByText("The start, Wed, Mar 11, counts as the first date, though the repeat doesn't fall on it."),
    ).toBeInTheDocument()
    expect(preview(dialog).slice(0, 3)).toEqual(['Wed, Mar 11', 'Thu, Mar 12', 'Mon, Mar 16'])
  })

  // #11: an event of an existing series moves to the repeat's next date; an exception or an extra date stays.
  it('says that an event of a series moves to the next date where the repeat does not fall on it', async () => {
    const { dialog, user } = open('FREQ=WEEKLY', 'moves')
    await user.click(within(dialog).getByRole('button', { name: 'Monday' }))
    await user.click(within(dialog).getByRole('button', { name: 'Thursday' }))
    await user.click(within(dialog).getByRole('button', { name: 'Wednesday' }))
    expect(within(dialog).getByText("The repeat doesn't fall on Wed, Mar 11, so this event moves to Thu, Mar 12.")).toBeInTheDocument()
    expect(within(dialog).queryByText(/counts as the first date/)).toBeNull()
    expect(preview(dialog).slice(0, 3)).toEqual(['Thu, Mar 12', 'Mon, Mar 16', 'Thu, Mar 19'])
  })

  it('says that an event that keeps its place stays where the repeat does not fall on it', async () => {
    const { dialog, user } = open('FREQ=WEEKLY', 'stays')
    await user.click(within(dialog).getByRole('button', { name: 'Monday' }))
    await user.click(within(dialog).getByRole('button', { name: 'Thursday' }))
    await user.click(within(dialog).getByRole('button', { name: 'Wednesday' }))
    expect(within(dialog).getByText("This event stays where it is, though the repeat doesn't fall on it.")).toBeInTheDocument()
    expect(preview(dialog).slice(0, 3)).toEqual(['Wed, Mar 11', 'Thu, Mar 12', 'Mon, Mar 16'])
  })

  it("refuses an end before the repeat's next date where the event moves there", () => {
    const { dialog } = open('FREQ=WEEKLY;BYDAY=TH;UNTIL=20260311', 'moves')
    expect(within(dialog).getByRole('alert')).toHaveTextContent("The end date is before the repeat's next date, Thu, Mar 12.")
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeDisabled()
  })

  it('takes an end on the start where the start counts', () => {
    const { dialog } = open('FREQ=WEEKLY;BYDAY=TH;UNTIL=20260311')
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeEnabled()
  })

  it('says that short months leave out a late day', async () => {
    const { dialog, user } = open('FREQ=MONTHLY')
    const days = within(dialog).getByRole('toolbar', { name: 'Days of the month' })
    await user.click(within(days).getByRole('button', { name: '29' }))
    expect(within(dialog).getByText('Every month on days 11 and 29')).toBeInTheDocument()
    expect(within(dialog).getByText("Shorter months leave out the days they don't have.")).toBeInTheDocument()
    expect(within(dialog).queryByText(/are skipped/)).toBeNull()
  })

  it('names the choice between days of the month and the nth day', () => {
    const { dialog } = open('FREQ=MONTHLY')
    const choice = within(dialog).getByRole('radiogroup', { name: 'Repeats on' })
    expect(within(choice).getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false'])
  })

  it('keeps one weekday chosen', async () => {
    const { dialog, user } = open('FREQ=WEEKLY')
    await user.click(within(dialog).getByRole('button', { name: 'Wednesday' }))
    expect(within(dialog).getByRole('button', { name: 'Wednesday' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('repeats yearly on a day of a month', async () => {
    const { dialog, onDone, user } = open('FREQ=YEARLY')
    await pick(user, dialog, 'In', 'June')
    await pick(user, dialog, 'Day of the month', '1')
    expect(within(dialog).getByText('Every year on June 1')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalledWith('FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1')
  })
})
