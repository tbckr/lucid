import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it, vi } from 'vitest'
import { type FormatPrefs } from '@/lib/format'
import { MiniMonth } from './MiniMonth'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const now = new Date(2026, 2, 11, 10)

function dayButtons(): HTMLElement[] {
  return screen.getAllByRole('button').filter((b) => b.hasAttribute('data-day'))
}

describe('MiniMonth', () => {
  it('has one tab stop among the days: the chosen one', () => {
    render(<MiniMonth date={new Date(2026, 2, 20)} now={now} range={null} prefs={prefs} onSelect={vi.fn()} />)
    const stops = dayButtons().filter((b) => b.tabIndex === 0)
    expect(stops.map((b) => b.getAttribute('aria-label'))).toEqual(['Friday, March 20th, 2026'])
  })

  it('moves between days with the arrow keys, into the next month too', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<MiniMonth date={new Date(2026, 2, 30)} now={now} range={null} prefs={prefs} onSelect={onSelect} />)
    screen.getByRole('button', { name: 'Monday, March 30th, 2026' }).focus()

    await user.keyboard('{ArrowRight}{ArrowDown}')
    expect(document.activeElement).toHaveAccessibleName('Tuesday, April 7th, 2026')
    expect(screen.getByText('April 2026')).toBeInTheDocument()
    await user.keyboard('{ArrowLeft}{ArrowUp}')
    expect(document.activeElement).toHaveAccessibleName('Monday, March 30th, 2026')

    await user.keyboard('{ArrowRight}{Enter}')
    expect(onSelect).toHaveBeenCalledWith(new Date(2026, 2, 31))
  })

  it('marks the chosen day instead of today when picking a date', () => {
    render(
      <MiniMonth date={new Date(2026, 2, 20)} now={now} range={null} prefs={prefs} emphasis="selected" onSelect={vi.fn()} />,
    )
    const chosen = screen.getByRole('button', { name: 'Friday, March 20th, 2026' })
    const today = screen.getByRole('button', { name: 'Wednesday, March 11th, 2026' })
    expect(chosen).toHaveAttribute('aria-pressed', 'true')
    expect(chosen.className).toContain('bg-primary')
    expect(today.className).not.toContain('bg-primary')
  })
})
