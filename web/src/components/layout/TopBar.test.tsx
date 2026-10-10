import { useQuery } from '@tanstack/react-query'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { defaultSettings, useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { TopBar } from './TopBar'

afterEach(() => {
  useSettings.setState(defaultSettings)
  useUi.setState({ backendReachable: true })
})

/** Puts the calendar list on screen, as loaded by the seed. */
function Calendars() {
  useQuery({ queryKey: ['calendars'], queryFn: () => [], staleTime: Number.POSITIVE_INFINITY })
  return null
}

function renderTopBar(onRefresh = vi.fn(), loadedAt?: Date) {
  renderWithProviders(
    <>
      <Calendars />
      <TopBar
      title="March 2026"
      view="month"
      fetching={false}
      refresh="idle"
      username="demo"
      serverUrl="https://dav.example"
      tasksOpen={false}
      onMenu={vi.fn()}
      onToday={vi.fn()}
      onStep={vi.fn()}
      onView={vi.fn()}
      onToggleTasks={vi.fn()}
      onRefresh={onRefresh}
      onSettings={vi.fn()}
      onShortcuts={vi.fn()}
      onLogout={vi.fn()}
      />
    </>,
    (qc) => {
      if (loadedAt) qc.setQueryData(['calendars'], [], { updatedAt: loadedAt.getTime() })
    },
  )
  return onRefresh
}

describe('TopBar', () => {
  it('offers Refresh in the account menu, for screens too narrow for its button (FR-23)', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const loaded = new Date()
    loaded.setHours(14, 32, 0, 0)
    const user = userEvent.setup()
    const onRefresh = renderTopBar(vi.fn(), loaded)
    await user.click(screen.getByRole('button', { name: /account/i }))
    const item = await screen.findByRole('menuitem', { name: /^Refresh/ })
    expect(item).toHaveTextContent('As of 14:32')
    await user.click(item)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it("can't refresh from the account menu while Lucid can't reach its server", async () => {
    useUi.setState({ backendReachable: false })
    const user = userEvent.setup()
    renderTopBar()
    await user.click(screen.getByRole('button', { name: /account/i }))
    expect(await screen.findByRole('menuitem', { name: /^Refresh/ })).toHaveAttribute('aria-disabled', 'true')
  })
})
