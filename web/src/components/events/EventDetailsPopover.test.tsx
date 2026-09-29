import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { type ApiEvent } from '@/lib/api/schemas'
import { toCalEvent } from '@/lib/events'
import { useUi } from '@/stores/ui'
import { apiEvent, calendar, jsonResponse, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { EventDetailsPopover } from './EventDetailsPopover'

const calendars = [calendar(), calendar({ id: 'c2', name: 'Holidays', color: '#22c55e', readOnly: true })]

/** Open the details of an event as a click on its block does: the calendars are loaded by then. */
async function openDetails(p: Partial<ApiEvent>) {
  api.setCsrfToken('tok')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse(204)))
  const { queryClient } = renderWithProviders(
    <>
      <button type="button">Block</button>
      <EventDetailsPopover />
    </>,
  )
  queryClient.setQueryData(queryKeys.calendars, calendars)
  const anchor = screen.getByRole('button', { name: 'Block' })
  const event = toCalEvent(apiEvent({ title: 'Quarterly review', ...p }))
  act(() => {
    useUi.getState().openDetail({ item: event, anchor })
  })
  return { fetch, anchor, dialog: await screen.findByRole('dialog', { name: 'Quarterly review' }) }
}

describe('EventDetailsPopover', () => {
  afterEach(() => {
    useUi.getState().openDetail(null)
    vi.restoreAllMocks()
  })

  it('shows the event as its block does: title, then day and time, then calendar', async () => {
    const { dialog } = await openDetails({ start: '2026-03-13T13:00:00Z', end: '2026-03-13T15:00:00Z' })
    expect(within(dialog).getByRole('heading', { name: 'Quarterly review' })).toBeInTheDocument()
    expect(within(dialog).getByText(/^Fri, Mar 13(, 2026)?, 2:00 – 4:00 PM$/)).toBeInTheDocument()
    expect(within(dialog).getByText('Personal')).toBeInTheDocument()
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Edit event' })).toHaveFocus()
    })
  })

  it('links the web addresses in the location and the description', async () => {
    const { dialog } = await openDetails({
      location: 'https://meet.example.com/abc',
      description: 'Agenda: https://example.com/agenda.\nBring the slides.',
    })
    const agenda = within(dialog).getByRole('link', { name: 'https://example.com/agenda' })
    expect(agenda).toHaveAttribute('href', 'https://example.com/agenda')
    expect(agenda).toHaveAttribute('target', '_blank')
    expect(agenda).toHaveAttribute('rel', 'noopener noreferrer')
    expect(within(dialog).getByRole('link', { name: 'https://meet.example.com/abc' })).toBeInTheDocument()
    expect(within(dialog).getByText(/Bring the slides\./)).toBeInTheDocument()
  })

  it.each([
    ['FREQ=WEEKLY;BYDAY=MO,TH', 'Every week on Monday and Thursday'],
    ['FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO', 'Custom rule: FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO'],
  ])('says how the event repeats (%s)', async (rrule, text) => {
    const { dialog } = await openDetails({ recurring: true, rrule })
    expect(within(dialog).getByText(text)).toBeInTheDocument()
  })

  it.each([
    ['America/New_York', true],
    ['W. Europe Standard Time', false],
    ['Europe/Berlin', false],
  ])('shows the times in the zone of the event only when it is another valid one (%s)', async (timezone, shown) => {
    const { dialog } = await openDetails({ timezone, start: '2026-03-13T13:00:00Z', end: '2026-03-13T15:00:00Z' })
    const zone = within(dialog).queryByText(/9:00 – 11:00 AM \(America\/New_York\)$/)
    expect(zone !== null).toBe(shown)
  })

  it('offers only closing for an event in a read-only calendar', async () => {
    const { dialog } = await openDetails({ calendarId: 'c2' })
    expect(within(dialog).getByText('Read-only')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Edit event' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Delete event' })).toBeNull()
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    })
  })

  it('asks before deleting and keeps the focus in place (NFR-27)', async () => {
    const user = userEvent.setup()
    const { dialog, fetch } = await openDetails({ id: 'e7' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete event' }))
    const alert = within(dialog).getByRole('alert')
    expect(alert).toHaveTextContent('Delete this event?')
    expect(within(alert).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await user.click(within(alert).getByRole('button', { name: 'Cancel' }))
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Delete event' })).toHaveFocus()

    await user.click(within(dialog).getByRole('button', { name: 'Delete event' }))
    await user.click(within(within(dialog).getByRole('alert')).getByRole('button', { name: 'Delete event' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'DELETE' && urlOf(input).endsWith('/events/e7'))).toBe(true)
    })
    expect(useUi.getState().detail).toBeNull()
  })

  it('opens the editor for the event', async () => {
    const user = userEvent.setup()
    const { dialog } = await openDetails({})
    await user.click(within(dialog).getByRole('button', { name: 'Edit event' }))
    expect(useUi.getState().editor).toMatchObject({ mode: 'edit', event: { title: 'Quarterly review' } })
    expect(useUi.getState().detail).toBeNull()
  })
})
