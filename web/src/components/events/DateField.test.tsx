import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { enUS } from 'date-fns/locale/en-US'
import { type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type FormatPrefs } from '@/lib/format'
import { DateField } from './DateField'

const us: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
// Wednesday, 11 March 2026.
const now = new Date(2026, 2, 11, 12)

type Props = Partial<ComponentProps<typeof DateField>>

/** A start date on Friday, 13 March 2026, unless `props` say otherwise; `onChange` only records, the value stays. */
function setup(props: Props = {}) {
  const onChange = vi.fn()
  const user = userEvent.setup()
  const field = (p: Props) => (
    <>
      <span id="starts">Start</span>
      <DateField
        id="start"
        labelledBy="starts"
        label="Start date"
        value="2026-03-13"
        onChange={onChange}
        prefs={us}
        now={now}
        {...props}
        {...p}
      />
    </>
  )
  const view = render(field({}))
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Start' })
  return { user, onChange, input, rerender: (p: Props) => view.rerender(field(p)) }
}

const month = () => screen.getByRole('dialog', { name: 'Start date' })

describe('DateField (FR-09)', () => {
  it('shows the date at rest and its numbers while focused', async () => {
    const { user, input } = setup()
    expect(input).toHaveValue('Fri, Mar 13')
    await user.click(input)
    expect(input).toHaveValue('3/13/2026')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, '3/13/2026'.length])
    await user.tab()
    expect(input).toHaveValue('Fri, Mar 13')
  })

  it('commits a typed date on Enter and shows it read in full', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('3/28')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('2026-03-28', 'enter')
    // What was read, all selected, so the next keystroke replaces it.
    expect(input).toHaveValue('3/28/2026')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, '3/28/2026'.length])
    expect(input).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('commits when the field is left', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('20')
    await user.tab()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('2026-03-20', 'blur')
  })

  it('the month follows the typing', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    expect(within(month()).getByText('March 2026')).toBeInTheDocument()
    await user.keyboard('4/2')
    expect(within(month()).getByText('April 2026')).toBeInTheDocument()
    expect(within(month()).getByRole('button', { name: 'Thursday, April 2nd, 2026' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(month()).getAllByRole('button', { pressed: true })).toHaveLength(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('opens on a click and on typing, not on Tab focus', async () => {
    const { user, input } = setup()
    await user.tab()
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.keyboard('1')
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-controls', month().id)
    expect(input).toHaveFocus()
  })

  it('ArrowDown moves into the month', async () => {
    const { user, onChange, input } = setup()
    await user.tab()
    await user.keyboard('{ArrowDown}')
    expect(within(month()).getByRole('button', { name: 'Friday, March 13th, 2026' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(input).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ArrowDown moves into the month on the typed day, and a day picked there commits', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('4/2')
    await user.keyboard('{ArrowDown}')
    expect(within(month()).getByRole('button', { name: 'Thursday, April 2nd, 2026' })).toHaveFocus()
    // Leaving the text for the month commits nothing yet.
    expect(onChange).not.toHaveBeenCalled()
    await user.keyboard('{ArrowRight}{Enter}')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('2026-04-03', 'pick')
    expect(input).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('commits what was typed when the focus leaves the month, not for the text', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('4/2{ArrowDown}')
    await user.click(document.body)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('2026-04-02', 'blur')
    expect(input).not.toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
    // At rest again; the value is the form's, which this one keeps.
    expect(input).toHaveValue('Fri, Mar 13')
  })

  it('picking a day commits', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.click(within(month()).getByRole('button', { name: 'Friday, March 20th, 2026' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('2026-03-20', 'pick')
    expect(input).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
    // Leaving the field after the pick commits nothing more.
    await user.tab()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('takes a pick over what was typed', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('4/2')
    await user.click(within(month()).getByRole('button', { name: 'Friday, April 10th, 2026' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('2026-04-10', 'pick')
  })

  it('Escape restores the last value and closes the month', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('4/2')
    await user.keyboard('{Escape}')
    expect(input).toHaveValue('3/13/2026')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(input).toHaveFocus()
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('passes unreadable text up and marks it', async () => {
    const { user, onChange, input, rerender } = setup()
    expect(input).not.toHaveAttribute('aria-invalid')
    await user.click(input)
    await user.keyboard('13/45')
    // The month stays on the date in the field.
    expect(within(month()).getByText('March 2026')).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('13/45', 'enter')
    rerender({ value: '13/45' })
    expect(input).toHaveValue('13/45')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    await user.tab()
    expect(input).toHaveValue('13/45')
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  // The forms' own shape, which en-US doesn't read, but no day the calendar has: shown as typed and marked, not as
  // the day it would roll over to (FR-09).
  it("passes a date in the forms' shape that doesn't exist up as typed, and marks it", async () => {
    const { user, onChange, input, rerender } = setup()
    await user.click(input)
    await user.keyboard('2026-13-45{Enter}')
    expect(onChange).toHaveBeenCalledWith('2026-13-45', 'enter')
    rerender({ value: '2026-13-45' })
    expect(input).toHaveValue('2026-13-45')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    await user.tab()
    expect(input).toHaveValue('2026-13-45')
    rerender({ value: '2026-02-31' })
    expect(input).toHaveValue('2026-02-31')
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('reads the parts left out from the date in the field', async () => {
    const { user, onChange, input } = setup({ value: '2027-01-05' })
    await user.click(input)
    await user.keyboard('28')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('2027-01-28', 'enter')
  })

  it('an empty field reads missing parts from the month it opens on', async () => {
    const clear = vi.fn()
    const { user, onChange, input } = setup({
      value: '',
      month: new Date(2026, 11, 1),
      onClear: { label: 'Remove start date', clear },
      placeholder: 'Add a date',
    })
    expect(input).toHaveValue('')
    expect(input).toHaveAttribute('placeholder', 'Add a date')
    await user.click(input)
    expect(within(month()).getByText('December 2026')).toBeInTheDocument()
    await user.keyboard('28')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('2026-12-28', 'enter')
  })

  it('clears an optional date when emptied, restores a required one', async () => {
    const clear = vi.fn()
    const optional = setup({ onClear: { label: 'Remove start date', clear } })
    await optional.user.click(optional.input)
    await optional.user.keyboard('{Backspace}')
    await optional.user.tab()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(optional.onChange).not.toHaveBeenCalled()
    cleanup()

    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('{Backspace}')
    expect(input).toHaveValue('')
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
    expect(input).toHaveValue('Fri, Mar 13')
  })

  it('removes an optional date with its ✕, keeping the focus in the text', async () => {
    const clear = vi.fn()
    const { user, onChange, input } = setup({ onClear: { label: 'Remove start date', clear } })
    const x = screen.getByRole('button', { name: 'Remove start date' })
    // A target of the pointer, as the chevron is: the keyboard empties the text instead (NFR-27).
    expect(x).toHaveAttribute('tabindex', '-1')
    await user.click(x)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
    expect(input).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('drops a typed date with its ✕', async () => {
    const clear = vi.fn()
    const { user, onChange, input } = setup({ onClear: { label: 'Remove start date', clear } })
    await user.click(input)
    await user.keyboard('4/2')
    // The ✕ in the field, while the month is open below it.
    await user.click(within(input.parentElement!).getByRole('button', { name: 'Remove start date' }))
    expect(clear).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows its ✕ only for an optional date with a value, the chevron otherwise', () => {
    const required = setup()
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
    expect(required.input.parentElement!.querySelector('svg')).not.toBeNull()
    cleanup()

    const { input } = setup({ value: '', onClear: { label: 'Remove start date', clear: vi.fn() }, placeholder: 'Add a date' })
    expect(screen.queryByRole('button', { name: 'Remove start date' })).toBeNull()
    expect(input.parentElement!.querySelector('svg')).toBeNull()
  })

  it('offers no removal below the month', async () => {
    const { user, input } = setup({ onClear: { label: 'Remove start date', clear: vi.fn() } })
    await user.click(input)
    expect(within(month()).queryByRole('button', { name: 'Remove start date' })).toBeNull()
  })

  it("takes a typed day that can't be picked, for the form to say why", async () => {
    const { user, onChange, input } = setup({ isDisabled: (day) => day < new Date(2026, 2, 13) })
    await user.click(input)
    expect(within(month()).getByRole('button', { name: 'Thursday, March 12th, 2026' })).toHaveAttribute('aria-disabled', 'true')
    await user.keyboard('3/12{Enter}')
    expect(onChange).toHaveBeenCalledWith('2026-03-12', 'enter')
  })

  it("doesn't send the form it is in on Enter", async () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => {
      e.preventDefault()
    })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <form onSubmit={onSubmit}>
        <span id="starts">Start</span>
        <DateField id="start" labelledBy="starts" label="Start date" value="2026-03-13" onChange={onChange} prefs={us} now={now} />
        <button type="submit">Save</button>
      </form>,
    )
    await user.click(screen.getByRole('combobox', { name: 'Start' }))
    await user.keyboard('3/14{Enter}')
    expect(onChange).toHaveBeenCalledWith('2026-03-14', 'enter')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  // Without `field-sizing`, `size` sizes the field: to its text, or to the placeholder it shows while empty.
  it('is as wide as its text, and as its placeholder only while empty', async () => {
    const { user, input } = setup({ placeholder: 'Add a date somewhere', onClear: { label: 'Remove', clear: vi.fn() } })
    expect(input).toHaveAttribute('size', String('Fri, Mar 13'.length))
    await user.click(input)
    await user.keyboard('{Backspace}')
    expect(input).toHaveAttribute('size', String('Add a date somewhere'.length))
    await user.keyboard('3')
    expect(input).toHaveAttribute('size', '1')
  })

  // A form disables its date rows by a fieldset, which no prop of the field says (FR-17).
  it('opens nothing from its chevron in a disabled fieldset', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <fieldset disabled>
        <span id="starts">Start</span>
        <DateField id="start" labelledBy="starts" label="Start date" value="2026-03-13" onChange={onChange} prefs={us} now={now} />
      </fieldset>,
    )
    const input = screen.getByRole('combobox', { name: 'Start' })
    // A browser disables only the form controls in the fieldset; user-event takes the chevron for disabled too.
    fireEvent.click(input.parentElement!.querySelector('svg')!.parentElement!)
    await user.click(input)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes nothing from its ✕ in a disabled fieldset', () => {
    const clear = vi.fn()
    render(
      <fieldset disabled>
        <span id="starts">Start</span>
        <DateField
          id="start"
          labelledBy="starts"
          label="Start date"
          value="2026-03-13"
          onChange={vi.fn()}
          onClear={{ label: 'Remove start date', clear }}
          prefs={us}
          now={now}
        />
      </fieldset>,
    )
    // user-event refuses a disabled target; a click without its checks shows the guard is the field's own (FR-17).
    fireEvent.click(screen.getByRole('button', { name: 'Remove start date' }))
    expect(clear).not.toHaveBeenCalled()
  })

  // The month is portalled out of the fieldset: left open, a pick there would still commit (FR-17).
  it('closes its month when a fieldset around disables it', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const field = (disabled: boolean) => (
      <fieldset disabled={disabled}>
        <span id="starts">Start</span>
        <DateField id="start" labelledBy="starts" label="Start date" value="2026-03-13" onChange={onChange} prefs={us} now={now} />
      </fieldset>
    )
    const view = render(field(false))
    const input = screen.getByRole('combobox', { name: 'Start' })
    await user.click(input)
    expect(month()).toBeInTheDocument()
    view.rerender(field(true))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is a combobox for the numeric keyboard, named by its row and showing its value', () => {
    const { input } = setup({ describedBy: 'note' })
    expect(input).toHaveAttribute('inputmode', 'numeric')
    expect(input).toHaveAttribute('aria-haspopup', 'dialog')
    expect(input).toHaveAttribute('aria-labelledby', 'starts')
    expect(input).toHaveAttribute('aria-describedby', 'note')
    expect(input).toHaveClass('tabular')
  })
})
