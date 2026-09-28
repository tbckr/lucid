import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api/client'
import { useUi } from '@/stores/ui'
import { bodyOf, calendar, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { TaskEditorDialog } from './TaskEditorDialog'

describe('TaskEditorDialog', () => {
  afterEach(() => {
    useUi.getState().openTaskEditor(null)
  })

  it.each([
    ['Start date', 'start', 'due'],
    ['Due date', 'due', 'start'],
  ])('removes the %s together with its time', async (label, removed, kept) => {
    api.setCsrfToken('tok')
    const t = todo({ title: 'Slides', start: '2026-09-25T07:00:00Z', due: '2026-09-25T09:00:00Z' })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).endsWith('/calendars')
          ? jsonResponse(200, { calendars: [calendar()] })
          : jsonResponse(200, { ...t, etag: '"2"' }),
      ),
    )
    useUi.getState().openTaskEditor(t)
    const user = userEvent.setup()
    renderWithProviders(<TaskEditorDialog />)

    await user.clear(screen.getByLabelText(label))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    })
    const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'PUT')!
    const keptValue = new Date(t[kept as 'start' | 'due']!).toISOString()
    expect(bodyOf(init)).toMatchObject({ [removed]: null, [`${removed}AllDay`]: false, [kept]: keptValue })
  })
})
