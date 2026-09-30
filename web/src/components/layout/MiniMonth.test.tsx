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

  // The band's position on a day, read from the element behind its button.
  const band = (name: string) => screen.getByRole('button', { name }).parentElement?.dataset.range

  it('draws the visible week as one band from its first to its last day', () => {
    const range = { start: new Date(2026, 2, 8), end: new Date(2026, 2, 15) }
    render(<MiniMonth date={now} now={now} range={range} prefs={prefs} onSelect={vi.fn()} />)
    expect(band('Saturday, March 7th, 2026')).toBeUndefined()
    expect(band('Sunday, March 8th, 2026')).toBe('start')
    expect(band('Wednesday, March 11th, 2026')).toBe('middle')
    expect(band('Saturday, March 14th, 2026')).toBe('end')
    expect(band('Sunday, March 15th, 2026')).toBeUndefined()
  })

  it('draws a single day as a band of its own', () => {
    const range = { start: new Date(2026, 2, 20), end: new Date(2026, 2, 21) }
    render(<MiniMonth date={new Date(2026, 2, 20)} now={now} range={range} prefs={prefs} onSelect={vi.fn()} />)
    expect(band('Friday, March 20th, 2026')).toBe('single')
    expect(band('Saturday, March 21st, 2026')).toBeUndefined()
  })

  it('disables a day via isDisabled, blocks its click, and renders the footer', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <MiniMonth
        date={new Date(2026, 2, 20)}
        now={now}
        range={null}
        prefs={prefs}
        onSelect={onSelect}
        isDisabled={(d) => d.getDate() === 9}
        footer={<p>Only until the 8th</p>}
      />,
    )
    const disabledDay = screen.getByRole('button', { name: 'Monday, March 9th, 2026' })
    expect(disabledDay).toBeDisabled()
    expect(disabledDay).toHaveAttribute('aria-disabled', 'true')

    await user.click(disabledDay)
    expect(onSelect).not.toHaveBeenCalled()

    expect(screen.getByText('Only until the 8th')).toBeInTheDocument()
  })
})
