import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { EditorDialog } from '@/components/EditorDialog'
import { toCalEvent } from '@/lib/events'
import { draftOf } from '@/lib/quickCreate'
import { useUi, type CreateEditorState, type EditorState } from '@/stores/ui'
import { apiEvent, bodyOf, calendar, jsonResponse, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'

// 11:00-12:00 in Berlin (CET, the Vitest time zone) on Wednesday, 11 March 2026.
const create: CreateEditorState = {
  mode: 'create',
  draft: draftOf(
    { start: new Date('2026-03-11T10:00:00Z'), end: new Date('2026-03-11T11:00:00Z'), allDay: false, granularity: 'time', ranged: false },
    'Europe/Berlin',
  ),
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
  const { queryClient } = renderWithProviders(<EditorDialog />)
  await waitFor(() => {
    expect(queryClient.getQueryData(queryKeys.calendars)).toBeDefined()
  })
  act(() => {
    useUi.getState().openEditor(editor)
  })
  return { fetch, dialog: await screen.findByRole('dialog') }
}

describe('EventEditor', () => {
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

  it('opens with the title and calendar it was given', async () => {
    const { dialog } = await openEditor({ mode: 'create', draft: { ...create.draft, title: 'Review', calendarId: 'c2' } })
    expect(within(dialog).getByPlaceholderText('Add a title')).toHaveValue('Review')
    expect(within(dialog).getByRole('combobox', { name: 'Calendar' })).toHaveTextContent('Work')
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

  it('shows the calendar as fixed when editing a series', async () => {
    const event = toCalEvent(apiEvent({ title: 'Gym', recurring: true, rrule: 'FREQ=WEEKLY' }))
    const { dialog } = await openEditor({ mode: 'edit', event })
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

  // FR-17: for a series, the notice only matters once the rule or the
  // all-day flag actually changes - until then both scope choices keep the
  // series' own time zone.
  it('hides the time zone notice for an unchanged series, and shows it once the rule changes', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z', timezone: 'America/New_York' }),
    )
    const { dialog } = await openEditor({ mode: 'edit', event })
    expect(within(dialog).queryByText(/Saving moves the event from America\/New_York/)).toBeNull()

    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Every day' }))
    expect(within(dialog).getByText(/Saving moves the event from America\/New_York/)).toBeInTheDocument()
  })

  it('asks on save which events of a series change, and saves only this one', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog', { name: 'This event repeats. Which events should change?' })

    await user.click(within(question).getByRole('button', { name: 'Only this event' }))
    await waitFor(() => {
      expect(
        fetch.mock.calls.some(
          ([input, init]) =>
            init?.method === 'PUT' && urlOf(input).endsWith('/events/e1/occurrences/2026-09-25T08%3A00%3A00Z'),
        ),
      ).toBe(true)
    })
    const [, init] = fetch.mock.calls.find(
      ([input, i]) => i?.method === 'PUT' && urlOf(input).includes('/occurrences/'),
    )!
    expect(bodyOf(init)).not.toHaveProperty('rrule')
    expect(bodyOf(init)).not.toHaveProperty('instanceStart')
  })

  it('saves all events of a series', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog')
    await user.click(within(question).getByRole('button', { name: 'All events' }))

    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))).toBe(
        true,
      )
    })
    const [, init] = fetch.mock.calls.find(([input, i]) => i?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))!
    expect(bodyOf(init)).toHaveProperty('instanceStart', '2026-09-25T08:00:00Z')
  })

  it('saves a changed rule for the whole series without asking, and says so', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Every day' }))
    expect(within(dialog).getByText('A new repeat rule applies to every event in the series.')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))).toBe(
        true,
      )
    })
  })

  it('saves a change between all-day and timed for the whole series without asking', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('switch', { name: 'All day' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))).toBe(
        true,
      )
    })
  })

  it('offers only this event when a series on fixed days moves to another day', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=MONTHLY;BYMONTHDAY=25', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    const { dialog } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: /^Start Fri, Sep 25/ }))
    await user.click(screen.getByRole('button', { name: 'Saturday, September 26th, 2026' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    const question = within(dialog).getByRole('alertdialog')
    expect(within(question).queryByRole('button', { name: 'All events' })).toBeNull()
    expect(
      within(question).getByText('The series stays on its days. Only this event can move to another day.'),
    ).toBeInTheDocument()
  })

  // FR-17: Apple writes an explicit "INTERVAL=1" the presets would otherwise
  // rewrite without it; the unchanged rule must still round-trip verbatim.
  it('asks and keeps an unrecognized rule verbatim when saving all events unchanged', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY;INTERVAL=1', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog', { name: 'This event repeats. Which events should change?' })
    await user.click(within(question).getByRole('button', { name: 'All events' }))

    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))).toBe(
        true,
      )
    })
    const [, init] = fetch.mock.calls.find(([input, i]) => i?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))!
    expect(bodyOf(init)).toHaveProperty('rrule', 'FREQ=WEEKLY;INTERVAL=1')
  })

  it('cancels only the scope question on Escape, leaving the editor open (NFR-27)', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    within(dialog).getByRole('alertdialog')

    await user.keyboard('{Escape}')

    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveFocus()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  // The scope question's buttons sit inside the editor's <form>; without type="button" they
  // default to "submit" and would also submit it, re-asking after Cancel or sending a second
  // PUT after a choice.
  it("does not resubmit the editor's form when the scope question is cancelled or answered", async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveFocus()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const question = within(dialog).getByRole('alertdialog')
    await user.click(within(question).getByRole('button', { name: 'Only this event' }))

    await waitFor(() => {
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
    })
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
  })
})
