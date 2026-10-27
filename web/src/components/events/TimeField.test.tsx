import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { de } from 'date-fns/locale/de'
import { enUS } from 'date-fns/locale/en-US'
import { type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type FormatPrefs } from '@/lib/format'
import { TimeField } from './TimeField'

const us: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const de12: FormatPrefs = { tag: 'de-DE', locale: de, hourCycle: '12h', weekStartsOn: 1 }

type Props = Partial<ComponentProps<typeof TimeField>>

/** A start time at 9:00 AM unless `props` say otherwise; `onChange` only records, the value stays. */
function setup(props: Props = {}) {
  const onChange = vi.fn()
  const user = userEvent.setup()
  const field = (p: Props) => <TimeField value="09:00" onChange={onChange} prefs={us} aria-label="Start time" {...props} {...p} />
  const view = render(field({}))
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Start time' })
  return { user, onChange, input, rerender: (p: Props) => view.rerender(field(p)) }
}

const options = () => within(screen.getByRole('listbox')).getAllByRole('option')

describe('TimeField (FR-09)', () => {
  it('commits a typed time on Enter', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('940')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('09:40', 'enter')
    // What was read, all selected, so the next keystroke replaces it.
    expect(input).toHaveValue('9:40 AM')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, '9:40 AM'.length])
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('commits when the field is left', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('14')
    await user.tab()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('14:00', 'blur')
  })

  it('Escape restores the last value and closes the list', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('5')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(input).toHaveValue('9:00 AM')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input).toHaveFocus()
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('opens on a click and on typing, not on Tab focus', async () => {
    const { user, input } = setup()
    await user.tab()
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.keyboard('1')
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
  })

  it('selects all text on focus, so typing replaces it', async () => {
    const { user, input } = setup()
    await user.click(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, '9:00 AM'.length])
    await user.keyboard('1')
    expect(input).toHaveValue('1')
  })

  it('offers half hours', async () => {
    const { user, input } = setup()
    await user.click(input)
    const all = options()
    expect(all).toHaveLength(48)
    expect(all.slice(0, 2).map((o) => o.textContent)).toEqual(['12:00 AM', '12:30 AM'])
    expect(all.at(-1)).toHaveTextContent('11:30 PM')
  })

  it('offers no time first where the time can be left out', async () => {
    const { user, input } = setup({ value: '', none: 'No time', placeholder: 'Add a time' })
    expect(input).toHaveValue('')
    expect(input).toHaveAttribute('placeholder', 'Add a time')
    await user.click(input)
    const all = options()
    expect(all).toHaveLength(49)
    expect(all[0]).toHaveTextContent('No time')
    expect(all[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('shows a typed time in its place in the list', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('940')
    const typed = within(screen.getByRole('listbox')).getByRole('option', { name: '9:40 AM' })
    expect(typed).toHaveAttribute('aria-selected', 'true')
    const names = options().map((o) => o.textContent)
    expect(names.slice(names.indexOf('9:40 AM') - 1, names.indexOf('9:40 AM') + 2)).toEqual(['9:30 AM', '9:40 AM', '10:00 AM'])
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toEqual([typed])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows an off-grid value in its place', async () => {
    const { user, input } = setup({ value: '14:10' })
    await user.click(input)
    const names = options().map((o) => o.textContent)
    expect(names).toHaveLength(49)
    expect(names.slice(names.indexOf('2:10 PM') - 1, names.indexOf('2:10 PM') + 2)).toEqual(['2:00 PM', '2:10 PM', '2:30 PM'])
  })

  it('arrow keys move through the list and write the entry', async () => {
    const { user, onChange, input } = setup()
    await user.tab()
    // The first ArrowDown opens the list on the value, the next ones move.
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(input).toHaveValue('9:00 AM')
    await user.keyboard('{ArrowDown}')
    expect(input).toHaveValue('9:30 AM')
    const next = within(screen.getByRole('listbox')).getByRole('option', { name: '9:30 AM' })
    expect(input).toHaveAttribute('aria-activedescendant', next.id)
    expect(next).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(input).toHaveValue('8:30 AM')
    expect(onChange).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('08:30', 'enter')
  })

  it('a mouse pick commits', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: '10:30 AM' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('10:30', 'pick')
    expect(input).toHaveFocus()
    expect(screen.queryByRole('listbox')).toBeNull()
    // Leaving the field after the pick commits nothing more.
    await user.tab()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('passes unreadable text up and marks it', async () => {
    const { user, onChange, input, rerender } = setup()
    expect(input).not.toHaveAttribute('aria-invalid')
    await user.click(input)
    await user.keyboard('25:00')
    expect(within(screen.getByRole('listbox')).queryByRole('option', { selected: true })).toBeNull()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('25:00', 'enter')
    rerender({ value: '25:00' })
    expect(input).toHaveValue('25:00')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    await user.tab()
    expect(input).toHaveValue('25:00')
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('clears an optional time when emptied', async () => {
    const optional = setup({ none: 'No time' })
    await optional.user.click(optional.input)
    await optional.user.keyboard('{Backspace}')
    await optional.user.tab()
    expect(optional.onChange).toHaveBeenCalledWith('', 'blur')
  })

  it('restores a required time when emptied', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('{Backspace}')
    expect(input).toHaveValue('')
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
    expect(input).toHaveValue('9:00 AM')
  })

  it('reads the day periods it shows', async () => {
    const { user, onChange, input } = setup({ value: '14:00', prefs: de12 })
    expect(input).toHaveValue('2:00 nachm.')
    await user.click(input)
    await user.keyboard('3:00 nachm.')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('15:00', 'enter')
  })

  it("doesn't send the form it is in on Enter", async () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => {
      e.preventDefault()
    })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <form onSubmit={onSubmit}>
        <TimeField value="09:00" onChange={onChange} prefs={us} aria-label="Start time" />
        <button type="submit">Save</button>
      </form>,
    )
    await user.click(screen.getByRole('combobox', { name: 'Start time' }))
    await user.keyboard('10{Enter}')
    expect(onChange).toHaveBeenCalledWith('10:00', 'enter')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('is a combobox for the numeric keyboard', () => {
    const { input } = setup()
    expect(input).toHaveAttribute('inputmode', 'numeric')
    expect(input).toHaveAttribute('aria-haspopup', 'listbox')
    expect(input).toHaveAttribute('aria-autocomplete', 'none')
    expect(input).toHaveClass('tabular')
  })
})
