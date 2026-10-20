import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUi } from '@/stores/ui'
import { CorruptedEvent } from './CorruptedEvent'
import { EventBoundary } from './EventBoundary'

function Boom(): never {
  throw new Error('bad RRULE')
}

afterEach(() => {
  useUi.setState({ report: { open: false, candidates: [] } })
})

describe('Corrupted event placeholder (FR-19)', () => {
  it('renders a labelled placeholder with the reason as tooltip', () => {
    render(<CorruptedEvent reason="title: expected string" />)
    const el = screen.getByTestId('corrupted-event')
    expect(el).toHaveTextContent('Corrupted event')
    expect(el).toHaveAttribute('title', 'title: expected string')
  })

  it('opens the problem report on a click, and only that (FR-36)', async () => {
    const user = userEvent.setup()
    const create = vi.fn()
    render(
      // A month cell opens the create popover on a click: the placeholder's click stops before it.
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- stands in for the cell's own handlers
      <div onClick={create}>
        <CorruptedEvent reason="title: expected string" />
      </div>,
    )
    await user.click(screen.getByRole('button', { name: 'Corrupted event. Report a problem' }))
    expect(useUi.getState().report.open).toBe(true)
    expect(create).not.toHaveBeenCalled()
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
