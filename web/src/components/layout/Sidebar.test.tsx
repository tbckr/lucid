import { screen } from '@testing-library/react'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it, vi } from 'vitest'
import { type FormatPrefs } from '@/lib/format'
import { jsonResponse } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { Sidebar } from './Sidebar'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const now = new Date(2026, 2, 11, 10)

describe('Sidebar', () => {
  it('announces c as the key of Create', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { calendars: [] }))
    renderWithProviders(<Sidebar date={now} now={now} range={null} prefs={prefs} />)
    const create = screen.getByRole('button', { name: 'Create' })
    expect(create).toHaveAttribute('aria-keyshortcuts', 'c')
  })
})
