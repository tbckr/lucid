import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { de } from 'date-fns/locale/de'
import { enUS } from 'date-fns/locale/en-US'
import { fr } from 'date-fns/locale/fr'
import { type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { type FormatPrefs } from '@/lib/format'
import { ZoneField } from './ZoneField'

const us: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const german: FormatPrefs = { tag: 'de-DE', locale: de, hourCycle: '24h', weekStartsOn: 1 }
const french: FormatPrefs = { tag: 'fr-FR', locale: fr, hourCycle: '24h', weekStartsOn: 1 }

type Props = Partial<ComponentProps<typeof ZoneField>>

/** The end's zone field of a browser in Lisbon, in New York unless `props` say otherwise; `onChange` only records. */
function setup(props: Props = {}) {
  const onChange = vi.fn()
  const user = userEvent.setup()
  const field = (p: Props) => (
    <ZoneField
      value="America/New_York"
      onChange={onChange}
      clearTo=""
      browserZone="Europe/Lisbon"
      date="2026-10-28"
      inUse={['America/New_York']}
      prefs={us}
      aria-label="End time zone"
      {...props}
      {...p}
    />
  )
  const view = render(field({}))
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'End time zone' })
  return { user, onChange, input, rerender: (p: Props) => view.rerender(field(p)) }
}

const listbox = () => screen.getByRole('listbox')
const options = () => within(listbox()).getAllByRole('option')
/** The options named `name` (a city and its ID); a zone in use or here is in the list twice. */
const named = (name: string) => within(listbox()).getAllByRole('option', { name })

describe('ZoneField (FR-18)', () => {
  it("shows the city at rest, and 'Your time zone' for none", () => {
    const { input, rerender } = setup()
    expect(input).toHaveValue('New York')
    expect(screen.getByRole('button', { name: 'Use your time zone' })).toBeInTheDocument()
    rerender({ value: '' })
    expect(input).toHaveValue('')
    expect(input).toHaveAttribute('placeholder', 'Your time zone')
    expect(screen.queryByRole('button')).toBeNull()
    // Every name of UTC reads "UTC".
    rerender({ value: 'Etc/UTC' })
    expect(input).toHaveValue('UTC')
  })

  it('filters as typed and commits on Enter', async () => {
    const { user, onChange, input } = setup({ value: 'Asia/Tokyo' })
    await user.click(input)
    await user.keyboard('new y')
    const names = options().map((o) => o.getAttribute('aria-label'))
    expect(names).toContain('New York, America/New_York')
    expect(names).not.toContain('Tokyo, Asia/Tokyo')
    expect(onChange).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('America/New_York')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input).toHaveFocus()
  })

  it('marks the first match while typing, and Enter commits what the arrow keys moved to instead', async () => {
    const { user, onChange, input } = setup({ value: 'Asia/Tokyo', inUse: [] })
    await user.click(input)
    await user.keyboard('ber')
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    await user.keyboard('{ArrowDown}')
    const moved = options()[1]!
    expect(moved).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveValue(moved.getAttribute('aria-label')!.split(',')[0])
    // The list stays as typed, not narrowed to the entry written into the text.
    expect(options().length).toBeGreaterThan(1)
    expect(input).toHaveAttribute('aria-activedescendant', moved.id)
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(moved.getAttribute('aria-label')!.split(', ')[1])
  })

  it('commits the first match when the field is left', async () => {
    const { user, onChange, input } = setup({ value: 'Europe/Lisbon' })
    await user.click(input)
    await user.keyboard('tokyo')
    await user.tab()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('Asia/Tokyo')
  })

  it('restores text that matches no zone', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('xyz')
    expect(screen.getByText('No time zone matches.')).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
    expect(input).toHaveValue('New York')
    expect(screen.queryByText('No time zone matches.')).toBeNull()
  })

  it('restores the last zone on Enter without a match, and when emptied', async () => {
    const { user, onChange, input } = setup()
    await user.click(input)
    await user.keyboard('xyz{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    expect(input).toHaveValue('New York')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'New York'.length])
    await user.keyboard('{Backspace}')
    expect(input).toHaveValue('')
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
    expect(input).toHaveValue('New York')
  })

  it('keeps no zone for a field without one when nothing matches', async () => {
    const { user, onChange, input } = setup({ value: '' })
    await user.click(input)
    await user.keyboard('xyz')
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  it('Escape closes the list, not the dialog', async () => {
    const onOpenChange = vi.fn()
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Editor</DialogTitle>
          <DialogDescription>An editor.</DialogDescription>
          {/* The dialog opens on its first control, as the editors' title. */}
          <button type="button">Done</button>
          <ZoneField
            value="America/New_York"
            onChange={onChange}
            clearTo=""
            browserZone="Europe/Lisbon"
            date="2026-10-28"
            inUse={[]}
            prefs={us}
            aria-label="End time zone"
          />
        </DialogContent>
      </Dialog>,
    )
    const input = screen.getByRole('combobox', { name: 'End time zone' })
    await user.click(input)
    await user.keyboard('tok')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(input).toHaveValue('New York')
    expect(input).toHaveFocus()
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
    // With no list open, the Escape is the dialog's.
    await user.click(input)
    await user.keyboard('{Escape}')
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('offers the ✕ only where it changes the zone', async () => {
    const { user, onChange, input, rerender } = setup({ value: 'Europe/Lisbon', clearTo: '' })
    const x = screen.getByRole('button', { name: 'Use your time zone' })
    // A target of the pointer: the keyboard picks a zone from the text (NFR-27).
    expect(x).toHaveAttribute('tabindex', '-1')
    await user.click(x)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('')
    expect(input).toHaveFocus()
    expect(screen.queryByRole('listbox')).toBeNull()

    // A series is in its zone: the ✕ sets the browser's.
    rerender({ value: 'America/New_York', clearTo: 'Europe/Lisbon' })
    await user.click(screen.getByRole('button', { name: 'Use your time zone' }))
    expect(onChange).toHaveBeenLastCalledWith('Europe/Lisbon')

    // Where the zone is the one it would set, whatever its spelling, there is nothing to change.
    rerender({ value: 'Europe/Lisbon', clearTo: 'Europe/Lisbon' })
    expect(screen.queryByRole('button')).toBeNull()
    rerender({ value: 'Asia/Kolkata', clearTo: 'Asia/Calcutta' })
    expect(screen.queryByRole('button')).toBeNull()
    // No zone is not the browser's zone: a single item in it can go back to none.
    rerender({ value: 'Europe/Lisbon', clearTo: '' })
    expect(screen.getByRole('button', { name: 'Use your time zone' })).toBeInTheDocument()
    rerender({ value: '', clearTo: '' })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('removes the zone with its ✕ although text was typed', async () => {
    const { user, onChange, input } = setup({ value: 'Europe/Lisbon' })
    await user.click(input)
    await user.keyboard('tok')
    await user.click(screen.getByRole('button', { name: 'Use your time zone' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it("lists the day's offsets", async () => {
    const { user, input, rerender } = setup()
    await user.click(input)
    expect(screen.getByText('on October 28')).toBeInTheDocument()
    for (const ny of named('New York, America/New_York')) expect(ny).toHaveTextContent('UTC−4')
    expect(named('Lisbon, Europe/Lisbon')[0]).toHaveTextContent('UTC+0')
    expect(named('Chicago, America/Chicago')[0]).toHaveTextContent('UTC−5')
    // Intl lists Kolkata as Calcutta in some engines.
    expect(options().find((o) => /^(Kolkata|Calcutta), /.test(o.getAttribute('aria-label') ?? ''))).toHaveTextContent(
      'UTC+5:30',
    )
    await user.keyboard('{Escape}')
    // The United States are off summer time on 1 November.
    rerender({ date: '2026-11-02' })
    await user.click(input)
    expect(screen.getByText('on November 2')).toBeInTheDocument()
    for (const ny of named('New York, America/New_York')) expect(ny).toHaveTextContent('UTC−5')
    expect(named('Chicago, America/Chicago')[0]).toHaveTextContent('UTC−6')
  })

  it('says the date in the language of the interface', async () => {
    const { user, input } = setup({ prefs: german })
    await user.click(input)
    expect(screen.getByText('on 28. Oktober')).toBeInTheDocument()
  })

  it('falls back to today for a date it cannot read', async () => {
    const { user, input } = setup({ date: '2026-02-31' })
    await user.click(input)
    expect(listbox()).toBeInTheDocument()
    expect(named('New York, America/New_York')[0]).toHaveTextContent(/UTC−[45]/)
  })

  it('shows the generic name beside the city, and none that is only an offset', async () => {
    const { user, input } = setup()
    await user.click(input)
    expect(named('New York, America/New_York')[0]).toHaveTextContent('New YorkEastern TimeUTC−4')
    await user.clear(input)
    await user.keyboard('utc')
    const utc = named('UTC, Etc/UTC')[0]!
    expect(utc).toHaveTextContent('UTCUTC+0')
    expect(utc).not.toHaveTextContent('GMT')
  })

  // French names a zone without a name of its own by its offset from UTC ("UTC+00:00"), not from GMT.
  it('shows no generic name that is only an offset from UTC either', async () => {
    const { user, input } = setup({ prefs: french })
    await user.click(input)
    await user.clear(input)
    await user.keyboard('utc')
    const utc = named('UTC, Etc/UTC')[0]!
    expect(utc).toHaveTextContent('UTCUTC+0')
    expect(utc).not.toHaveTextContent('00:00')
  })

  it('groups where you are and the zones in use, then lists every zone under a divider', async () => {
    const { user, input } = setup({ value: 'Asia/Tokyo' })
    await user.click(input)
    const here = screen.getByRole('group', { name: 'Where you are now' })
    expect(within(here).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['Lisbon, Europe/Lisbon'])
    const used = screen.getByRole('group', { name: 'In your calendars' })
    expect(within(used).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['New York, America/New_York'])
    // Every zone by city follows with no heading of its own.
    expect(screen.getAllByRole('group')).toHaveLength(2)
    const all = options()
    expect(all.length).toBeGreaterThan(300)
    expect(all[2]).toHaveAttribute('aria-label', expect.stringContaining('Abidjan'))
  })

  it('names the groups a search leaves, and leaves out the others', async () => {
    const { user, input } = setup({ value: 'Asia/Tokyo' })
    await user.click(input)
    await user.keyboard('lis')
    expect(screen.getByRole('group', { name: 'Where you are now' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'In your calendars' })).toBeNull()
    await user.clear(input)
    await user.keyboard('new y')
    expect(screen.queryByRole('group', { name: 'Where you are now' })).toBeNull()
    expect(screen.getByRole('group', { name: 'In your calendars' })).toBeInTheDocument()
  })

  it('marks the current zone with a ✓, and opens the list on it', async () => {
    const { user, input } = setup({ value: 'Europe/Lisbon' })
    await user.click(input)
    const checked = options().filter((o) => o.querySelector('svg') !== null)
    expect(checked.map((o) => o.getAttribute('aria-label'))).toEqual(['Lisbon, Europe/Lisbon', 'Lisbon, Europe/Lisbon'])
    // The highlight is the one entry Enter would take, and is named only once the arrow keys move it.
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toEqual([checked[0]])
    expect(input).not.toHaveAttribute('aria-activedescendant')
  })

  it('arrow keys move through the list and write the entry', async () => {
    const { user, onChange, input } = setup({ value: 'Europe/Lisbon' })
    await user.tab()
    expect(input).toHaveAttribute('aria-expanded', 'false')
    // The first ArrowDown opens the list on the value, the next ones move.
    await user.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveValue('Lisbon')
    await user.keyboard('{ArrowDown}')
    expect(input).toHaveValue('New York')
    const used = within(screen.getByRole('group', { name: 'In your calendars' })).getByRole('option')
    expect(input).toHaveAttribute('aria-activedescendant', used.id)
    expect(used).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}')
    expect(input).toHaveValue('Abidjan')
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(input).toHaveValue('Lisbon')
    expect(onChange).not.toHaveBeenCalled()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith('America/New_York')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  // The search and the highlight end with the text being edited, however the list closes (NFR-27).
  it.each([
    ['Enter', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Enter}')],
    ['Escape', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
    ['leaving the field', async (user: ReturnType<typeof userEvent.setup>) => user.tab()],
  ])('lists every zone again after %s, and names no entry until an arrow key moves', async (_, close) => {
    const { user, input } = setup({ value: 'Europe/Lisbon' })
    await user.click(input)
    await user.keyboard('tok{ArrowDown}')
    expect(options().length).toBeLessThan(50)
    expect(input).toHaveAttribute('aria-activedescendant')
    await close(user)
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.click(input)
    expect(options().length).toBeGreaterThan(300)
    expect(input).not.toHaveAttribute('aria-activedescendant')
  })

  it('opens on a click and on typing, not on Tab focus', async () => {
    const { user, input } = setup()
    await user.tab()
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.keyboard('t')
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
    expect(input).toHaveAttribute('aria-haspopup', 'listbox')
  })

  it('selects all text on focus, so typing replaces it', async () => {
    const { user, input } = setup()
    await user.click(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'New York'.length])
    await user.keyboard('t')
    expect(input).toHaveValue('t')
  })

  it('a mouse pick commits and keeps the focus in the text', async () => {
    const { user, onChange, input } = setup({ value: 'Europe/Lisbon' })
    await user.click(input)
    const row = within(screen.getByRole('group', { name: 'In your calendars' })).getByRole('option')
    // A press in the list leaves the focus where it is.
    expect(fireEvent.mouseDown(row)).toBe(false)
    await user.click(row)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('America/New_York')
    expect(input).toHaveFocus()
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.tab()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('picks the browser zone for a field without a zone', async () => {
    const { user, onChange, input } = setup({ value: '' })
    await user.click(input)
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(0)
    await user.click(within(screen.getByRole('group', { name: 'Where you are now' })).getByRole('option'))
    expect(onChange).toHaveBeenCalledWith('Europe/Lisbon')
  })

  it('commits nothing for a zone that is the one it has under another name', async () => {
    const { user, onChange, input } = setup({ value: 'Europe/Kyiv', inUse: [] })
    expect(input).toHaveValue('Kyiv')
    await user.click(input)
    // Intl lists it as Kiev in some engines, as Kyiv in others: one entry of the list is the zone, with the ✓.
    const row = options().filter((o) => o.querySelector('svg') !== null)
    expect(row).toHaveLength(1)
    expect(row[0]).toHaveAttribute('aria-label', expect.stringMatching(/^Ki(e|y)v, /))
    await user.click(row[0]!)
    expect(onChange).not.toHaveBeenCalled()
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows and lists a zone Intl does not know, without an offset', async () => {
    const { user, input } = setup({ value: 'Mars/Olympus' })
    expect(input).toHaveValue('Olympus')
    await user.click(input)
    const row = named('Olympus, Mars/Olympus')
    expect(row).toHaveLength(1)
    expect(row[0]!.querySelector('svg')).not.toBeNull()
    expect(row[0]).not.toHaveTextContent('UTC')
  })

  it('gives each entry its city and full ID as its name', async () => {
    const { user, input } = setup()
    await user.click(input)
    expect(named('Dar es Salaam, Africa/Dar_es_Salaam')).toHaveLength(1)
    expect(named('UTC, Etc/UTC')).toHaveLength(1)
  })

  it('describes the field by the full ID of its zone, after the notes passed in', () => {
    const { rerender, input } = setup()
    expect(input).toHaveAccessibleDescription('America/New_York')
    rerender({ value: '' })
    expect(input).not.toHaveAttribute('aria-describedby')
    render(<p id="note">Times are in New York.</p>)
    rerender({ value: 'Asia/Tokyo', describedBy: 'note' })
    expect(input).toHaveAccessibleDescription('Times are in New York. Asia/Tokyo')
  })

  it('opens on mount with autoFocus', async () => {
    const { input } = setup({ autoFocus: true })
    expect(input).toHaveFocus()
    expect(await screen.findByRole('listbox')).toBeVisible()
    expect(input).toHaveAttribute('aria-expanded', 'true')
  })

  it('does not open, and takes no focus, while disabled', async () => {
    const { user, input } = setup({ disabled: true, autoFocus: true })
    expect(input).toBeDisabled()
    expect(input).not.toHaveFocus()
    await user.click(input)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it("doesn't send the form it is in on Enter", async () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => {
      e.preventDefault()
    })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <form onSubmit={onSubmit}>
        <ZoneField
          value="Europe/Lisbon"
          onChange={onChange}
          clearTo=""
          browserZone="Europe/Lisbon"
          date="2026-10-28"
          inUse={[]}
          prefs={us}
          aria-label="End time zone"
        />
        <button type="submit">Save</button>
      </form>,
    )
    await user.click(screen.getByRole('combobox', { name: 'End time zone' }))
    await user.keyboard('tokyo{Enter}')
    expect(onChange).toHaveBeenCalledWith('Asia/Tokyo')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  // A form disables its rows by a fieldset, which no prop of the field says (FR-17).
  it('opens nothing and removes nothing in a disabled fieldset', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <fieldset disabled>
        <ZoneField
          value="Europe/Lisbon"
          onChange={onChange}
          clearTo=""
          browserZone="Europe/Lisbon"
          date="2026-10-28"
          inUse={[]}
          prefs={us}
          aria-label="End time zone"
        />
      </fieldset>,
    )
    await user.click(screen.getByRole('combobox', { name: 'End time zone' }))
    expect(screen.queryByRole('listbox')).toBeNull()
    // user-event refuses a disabled target; a click without its checks shows the guard is the field's own.
    fireEvent.click(screen.getByRole('button', { name: 'Use your time zone' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
