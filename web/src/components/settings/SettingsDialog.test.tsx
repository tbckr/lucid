import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { defaultSettings, useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { SettingsDialog } from './SettingsDialog'

function openDialog(): HTMLElement {
  renderWithProviders(<SettingsDialog />)
  act(() => {
    useUi.getState().setSettingsOpen(true)
  })
  return screen.getByRole('dialog', { name: 'Settings' })
}

describe('SettingsDialog', () => {
  beforeEach(() => {
    useSettings.setState(defaultSettings)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {}))
  })
  afterEach(() => {
    vi.useRealTimers()
    act(() => {
      useUi.getState().setSettingsOpen(false)
    })
  })

  it('starts the previewed week on the day chosen, and keeps it on a second click', async () => {
    const user = userEvent.setup()
    const dialog = openDialog()
    const weekStart = within(dialog).getByRole('radiogroup', { name: 'Week starts on' })
    const firstDay = () => within(within(dialog).getByRole('figure', { name: 'Preview' })).getAllByRole('listitem')[0]

    await user.click(within(weekStart).getByRole('radio', { name: 'Monday' }))
    expect(useSettings.getState().weekStart).toBe(1)
    expect(firstDay()).toHaveTextContent(/^Mon/)
    await user.click(within(weekStart).getByRole('radio', { name: 'Monday' }))
    expect(useSettings.getState().weekStart).toBe(1)
    await user.click(within(weekStart).getByRole('radio', { name: 'Saturday' }))
    expect(firstDay()).toHaveTextContent(/^Sat/)
  })

  it('previews the time in the format chosen', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 2, 11, 14, 30) })
    const user = userEvent.setup()
    const dialog = openDialog()
    const timeFormat = within(dialog).getByRole('radiogroup', { name: 'Time format' })
    const preview = within(dialog).getByRole('figure', { name: 'Preview' })

    await user.click(within(timeFormat).getByRole('radio', { name: '24-hour (13:00)' }))
    expect(useSettings.getState().timeFormat).toBe('24h')
    expect(preview).toHaveTextContent('14:30')
    await user.click(within(timeFormat).getByRole('radio', { name: '12-hour (1:00 PM)' }))
    expect(preview).toHaveTextContent('2:30 PM')
  })

  it('names what Automatic stands for', () => {
    const dialog = openDialog()
    const language = within(dialog).getByRole('radiogroup', { name: 'Language' })
    expect(within(language).getByRole('radio', { name: 'Automatic (English)' })).toBeChecked()
  })
})
