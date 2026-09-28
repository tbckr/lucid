import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { toCalEvent } from '@/lib/events'
import { useUi, type EditorState } from '@/stores/ui'
import { apiEvent, bodyOf, calendar, jsonResponse, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { EventEditorDialog } from './EventEditorDialog'

// 11:00-12:00 in Berlin (CET, the Vitest time zone) on Wednesday, 11 March 2026.
const create: NonNullable<EditorState> = {
  mode: 'create',
  defaults: { start: new Date('2026-03-11T10:00:00Z'), end: new Date('2026-03-11T11:00:00Z'), allDay: false },
}

/** Render the editor once the calendars are loaded, as in the app. */
async function openEditor(editor: NonNullable<EditorState>) {
  api.setCsrfToken('tok')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
    Promise.resolve(
      urlOf(input).endsWith('/calendars')
        ? jsonResponse(200, { calendars: [calendar(), calendar({ id: 'c2', name: 'Work', color: '#22c55e' })] })
        : jsonResponse(200, apiEvent()),
    ),
  )
  const { queryClient } = renderWithProviders(<EventEditorDialog />)
  await waitFor(() => {
    expect(queryClient.getQueryData(queryKeys.calendars)).toBeDefined()
  })
  act(() => {
    useUi.getState().openEditor(editor)
  })
  return { fetch, dialog: await screen.findByRole('dialog') }
}

describe('EventEditorDialog', () => {
  afterEach(() => {
    useUi.getState().openEditor(null)
    vi.restoreAllMocks()
  })

  it('moves the whole event to the start date picked in the month', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openEditor(create)
    await user.type(within(dialog).getByPlaceholderText('Add a title'), 'Review')

    await user.click(within(dialog).getByRole('button', { name: /^Start Wed, Mar 11/ }))
    await user.click(screen.getByRole('button', { name: 'Friday, March 13th, 2026' }))
    expect(within(dialog).getByRole('button', { name: /^End Fri, Mar 13/ })).toBeInTheDocument()
    expect(within(dialog).getByText('1 hr')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Create event' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    })
    const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!
    expect(bodyOf(init)).toMatchObject({
      title: 'Review',
      start: '2026-03-13T10:00:00.000Z',
      end: '2026-03-13T11:00:00.000Z',
    })
  })

  it('names the repeat presets after the start date', async () => {
    const user = userEvent.setup()
    const { dialog } = await openEditor(create)
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Does not repeat',
      'Every day',
      'Every week on Wednesday',
      'Every month on day 11',
      'Every year on March 11',
    ])
  })

  it.each([
    ['FREQ=WEEKLY;BYDAY=MO,TH', 'Every week on Monday and Thursday'],
    ['FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO', 'FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO'],
  ])('puts a custom rule into words where it can (%s)', async (rrule, text) => {
    const event = toCalEvent(apiEvent({ recurring: true, rrule }))
    const { dialog } = await openEditor({ mode: 'edit', event })
    expect(within(dialog).getByRole('combobox', { name: 'Repeat' })).toHaveTextContent('Custom rule')
    expect(within(dialog).getByTitle(rrule)).toHaveTextContent(text)
  })

  it('shows the series notice up front and the calendar as fixed when editing a series', async () => {
    const event = toCalEvent(apiEvent({ title: 'Gym', recurring: true, rrule: 'FREQ=WEEKLY' }))
    const { dialog } = await openEditor({ mode: 'edit', event })
    expect(within(dialog).getByText('This event repeats. Changes apply to every event in the series.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('combobox', { name: 'Calendar' })).toBeNull()
    expect(within(dialog).getByText('Personal')).toBeInTheDocument()
  })

  it.each([
    ['America/New_York', true],
    ['Europe/Berlin', false],
  ])('mentions the time zone only when the event has another one (%s)', async (timezone, shown) => {
    const { dialog } = await openEditor({ mode: 'edit', event: toCalEvent(apiEvent({ timezone })) })
    expect(within(dialog).queryByText(/Saving moves the event from America\/New_York/) !== null).toBe(shown)
  })
})
