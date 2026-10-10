import { useQuery } from '@tanstack/react-query'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { defaultSettings, useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { RefreshButton } from './RefreshButton'

afterEach(() => {
  useSettings.setState(defaultSettings)
  useUi.setState({ backendReachable: true })
})

/** Puts the calendar list on screen, as loaded by the seed. */
function Calendars() {
  useQuery({ queryKey: ['calendars'], queryFn: () => [], staleTime: Number.POSITIVE_INFINITY })
  return null
}

describe('RefreshButton', () => {
  it('refreshes on a click and announces r as its key', async () => {
    const onRefresh = vi.fn()
    renderWithProviders(<RefreshButton state="idle" onRefresh={onRefresh} />)
    const button = screen.getByRole('button', { name: 'Refresh' })
    expect(button).toHaveAttribute('aria-keyshortcuts', 'r')
    await userEvent.click(button)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('tells in its tooltip when the data on screen was loaded, with the day if not today', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <Calendars />
        <RefreshButton state="idle" onRefresh={vi.fn()} />
      </>,
      (qc) => {
        const yesterday = new Date()
        yesterday.setDate(yesterday.getDate() - 1)
        yesterday.setHours(14, 32, 0, 0)
        qc.setQueryData(['calendars'], [], { updatedAt: yesterday.getTime() })
      },
    )
    await user.hover(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/As of \w{3}, \w{3} \d{1,2}, 14:32/)
  })

  it("can't refresh while Lucid can't reach its server, and says why", async () => {
    useUi.setState({ backendReachable: false })
    const onRefresh = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<RefreshButton state="idle" onRefresh={onRefresh} />)
    const button = screen.getByRole('button', { name: 'Refresh' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    await user.hover(button)
    expect(await screen.findByRole('tooltip')).toHaveTextContent("Lucid can't reach its server right now.")
    await user.click(button)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('is busy while it runs and says when it is done', () => {
    const { unmount } = renderWithProviders(<RefreshButton state="running" onRefresh={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('')
    unmount()

    renderWithProviders(<RefreshButton state="done" onRefresh={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Refresh' })).not.toHaveAttribute('aria-busy')
    expect(screen.getByRole('status')).toHaveTextContent('Refreshed')
  })
})
