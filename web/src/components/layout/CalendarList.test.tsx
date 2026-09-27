import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { calendar, jsonResponse } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { CalendarList } from './CalendarList'

describe('CalendarList', () => {
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
})
