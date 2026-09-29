import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { calendar, jsonResponse } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { useSettings } from '@/stores/settings'
import { CalendarList } from './CalendarList'

describe('CalendarList', () => {
  it('hides and shows a calendar from a click on its name', async () => {
    useSettings.setState({ hiddenCalendars: [] })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { calendars: [calendar({ id: 'work', name: 'Work' })] }))
    const user = userEvent.setup()
    renderWithProviders(<CalendarList />)
    const toggle = await screen.findByRole('checkbox', { name: 'Work' })
    expect(toggle).toBeChecked()

    await user.click(screen.getByText('Work'))
    expect(toggle).not.toBeChecked()
    expect(useSettings.getState().hiddenCalendars).toEqual(['work'])
    await user.click(screen.getByText('Work'))
    expect(toggle).toBeChecked()
    expect(useSettings.getState().hiddenCalendars).toEqual([])
  })

  it('marks calendars that only hold tasks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        calendars: [
          calendar({ id: 'events', name: 'Personal', supportsTodos: false }),
          calendar({ id: 'mixed', name: 'Work' }),
          calendar({ id: 'tasks', name: 'Errands', supportsEvents: false }),
        ],
      }),
    )
    renderWithProviders(<CalendarList />)
    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(screen.getAllByLabelText('Tasks only')).toHaveLength(1)
    expect(items[2]).toHaveTextContent('Errands')
    expect(items[2]!.querySelector('[aria-label="Tasks only"]')).not.toBeNull()
  })

  it.each([
    [{ supportsEvents: false }, 'Tasks only'],
    [{ readOnly: true }, 'Read-only'],
  ])('explains the %o icon in a tooltip', async (props, label) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { calendars: [calendar(props)] }))
    const user = userEvent.setup()
    renderWithProviders(<CalendarList />)
    await user.hover(await screen.findByLabelText(label))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(label)
  })
})
