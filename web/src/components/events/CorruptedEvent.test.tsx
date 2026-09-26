import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CorruptedEvent } from './CorruptedEvent'
import { EventBoundary } from './EventBoundary'

function Boom(): never {
  throw new Error('bad RRULE')
}

describe('Corrupted event placeholder (FR-19)', () => {
  it('renders a labelled placeholder with the reason as tooltip', () => {
    render(<CorruptedEvent reason="title: expected string" />)
    const el = screen.getByTestId('corrupted-event')
    expect(el).toHaveTextContent('Corrupted event')
    expect(el).toHaveAttribute('title', 'title: expected string')
  })

  it('isolates a crashing event without breaking its siblings', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ul>
        <li>
          <EventBoundary>
            <Boom />
          </EventBoundary>
        </li>
        <li>Healthy event</li>
      </ul>,
    )
    expect(screen.getByTestId('corrupted-event')).toHaveAttribute('title', 'bad RRULE')
    expect(screen.getByText('Healthy event')).toBeInTheDocument()
    spy.mockRestore()
  })
})
