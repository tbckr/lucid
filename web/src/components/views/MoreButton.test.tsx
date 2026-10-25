import { DndContext } from '@dnd-kit/core'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { enUS } from 'date-fns/locale/en-US'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eventColors } from '@/lib/color'
import { toCalEvent } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { useUi } from '@/stores/ui'
import { apiEvent } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { MoreButton } from './MoreButton'
import { OverflowPopover } from './OverflowPopover'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const colors = eventColors('#3b82f6', false)
const friday = new Date(2026, 8, 25)
const saturday = new Date(2026, 8, 26)
const standup = toCalEvent(apiEvent({ id: 'e1', key: 'e1', title: 'Standup' }))
const review = toCalEvent(apiEvent({ id: 'e2', key: 'e2', title: 'Review' }))
const lunch = toCalEvent(apiEvent({ id: 'e3', key: 'e3', title: 'Lunch' }))

afterEach(() => {
  useUi.getState().openOverflow(null)
})

/** Two cells with a button each, and the list they open, as the month view has them. */
function renderButtons({ onCellClick = () => undefined, variant = 'text' }: { onCellClick?: () => void; variant?: 'text' | 'tile' } = {}) {
  return renderWithProviders(
    <DndContext>
      {[
        { id: 'more:fri', day: friday, items: [standup, review], label: '2 more, Friday' },
        { id: 'more:sat', day: saturday, items: [lunch], label: '1 more, Saturday' },
      ].map(({ id, day, items, label }) => (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- stands for the day cell
        <div key={id} data-testid={`cell-${id}`} onClick={onCellClick}>
          <MoreButton
            id={id}
            day={day}
            items={items}
            drag="event"
            home={() => document.querySelector<HTMLElement>(`[data-testid="cell-${id}"]`)}
            count={items.length}
            label={label}
            variant={variant}
          />
        </div>
      ))}
      <OverflowPopover prefs={prefs} colorsOf={() => colors} readOnly={() => false} lookup={() => undefined} />
    </DndContext>,
  )
}

describe('MoreButton', () => {
  it('shows the count as text, or as a tile with a plus', () => {
    const { unmount } = renderButtons()
    expect(screen.getByRole('button', { name: '2 more, Friday' })).toHaveTextContent('2 more')
    unmount()
    renderButtons({ variant: 'tile' })
    expect(screen.getByRole('button', { name: '2 more, Friday' })).toHaveTextContent('+2')
  })

  it('opens the list of what it stands for, at itself and its cell', async () => {
    const user = userEvent.setup()
    const box = new DOMRect(10, 20, 100, 20)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(box)
    renderButtons()
    const button = screen.getByRole('button', { name: '2 more, Friday' })
    expect(button).toHaveAttribute('aria-haspopup', 'dialog')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveAttribute('data-holds', 'e1 e2')

    await user.click(button)
    const { overflow } = useUi.getState()
    expect(overflow?.id).toBe('more:fri')
    expect(overflow?.day).toBe(friday)
    expect(overflow?.items).toEqual([standup, review])
    expect(overflow?.drag).toBe('event')
    expect(overflow?.anchor).toBe(button)
    expect(overflow?.home).toBe(screen.getByTestId('cell-more:fri'))
    expect(overflow?.rect).toBe(box)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('dialog', { name: 'Friday, September 25th, 2026' })).toBeInTheDocument()
  })

  it('closes the list with a second click', async () => {
    const user = userEvent.setup()
    renderButtons()
    const button = screen.getByRole('button', { name: '2 more, Friday' })
    await user.click(button)
    await screen.findByRole('dialog')
    await user.click(button)
    expect(useUi.getState().overflow).toBeNull()
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('switches the list to another button that is clicked while it is open', async () => {
    const user = userEvent.setup()
    renderButtons()
    await user.click(screen.getByRole('button', { name: '2 more, Friday' }))
    await screen.findByRole('dialog', { name: 'Friday, September 25th, 2026' })
    // Let Radix start listening for clicks beside the list.
    await new Promise((r) => setTimeout(r, 10))
    await user.click(screen.getByRole('button', { name: '1 more, Saturday' }))
    expect(useUi.getState().overflow?.id).toBe('more:sat')
    expect(await screen.findByRole('dialog', { name: 'Saturday, September 26th, 2026' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2 more, Friday' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: '1 more, Saturday' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps its click from reaching the cell, which would create an entry', async () => {
    const user = userEvent.setup()
    const onCellClick = vi.fn()
    renderButtons({ onCellClick })
    await user.click(screen.getByRole('button', { name: '2 more, Friday' }))
    await user.click(screen.getByRole('button', { name: '2 more, Friday' }))
    expect(onCellClick).not.toHaveBeenCalled()
  })

  it('stands in for its home with the button when it has none', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <DndContext>
        <MoreButton id="more:x" day={friday} items={[standup]} drag="event" home={() => null} count={1} label="1 more" variant="text" />
      </DndContext>,
    )
    const button = screen.getByRole('button', { name: '1 more' })
    await user.click(button)
    expect(useUi.getState().overflow?.home).toBe(button)
  })
})
