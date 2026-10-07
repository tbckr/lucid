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

  it('saves a change between all-day and timed for the whole series without asking', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, first: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
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

  it("saves only this event without asking when the series can't follow the new day", async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=MONTHLY;BYMONTHDAY=25', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: /^Start Fri, Sep 25/ }))
    await user.click(screen.getByRole('button', { name: 'Saturday, September 26th, 2026' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    })
    const puts = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(puts).toHaveLength(1)
    const [url, init] = puts[0]!
    expect(urlOf(url)).toBe(`/api/v1/events/e1/occurrences/${encodeURIComponent('2026-09-25T08:00:00Z')}`)
    expect(bodyOf(init)).toMatchObject({ start: '2026-09-26T08:00:00.000Z', end: '2026-09-26T09:00:00.000Z' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  // FR-17: with one option, the footer says before Save what it reaches; red only where it deletes.
  it('warns in the footer before a new rule replaces the series', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, first: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog } = await openEditor({ mode: 'edit', event })
    // Unchanged, a save can still reach either, and the question will ask.
    expect(within(dialog).queryByText('Applies to every event in the series.')).toBeNull()

    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Every day' }))
    const all = within(dialog).getByText('Applies to every event in the series.')
    // Muted, in the size and weight of the drag pill (spec §2).
    expect(all).toHaveClass('text-xs', 'font-medium', 'text-muted-foreground')
    expect(Array.from(all.querySelectorAll('circle'), (c) => c.getAttribute('fill'))).toEqual(Array(5).fill('#3b82f6'))

    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Does not repeat' }))
    expect(within(dialog).queryByText('Applies to every event in the series.')).toBeNull()
    const removed = within(dialog).getByText('The series becomes this one event. All others are deleted.')
    expect(removed).toHaveClass('text-xs', 'font-medium', 'text-muted-foreground')
    expect(Array.from(removed.querySelectorAll('circle'), (c) => c.getAttribute('fill'))).toEqual(
      Array(5).fill('var(--destructive)'),
    )
    // Screen readers hear it with Save (NFR-27).
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveAccessibleDescription(
      'The series becomes this one event. All others are deleted.',
    )
  })

  // FR-17: the hint follows the form; it is about what Save would do now, not when it opened.
  it('shows the hint only while the date keeps the series from following', async () => {
    const user = userEvent.setup()
    const hint = 'Only this event. The series stays on its days.'
    const event = toCalEvent(
      apiEvent({
        id: 'e1',
        start: '2026-10-15T08:00:00Z',
        end: '2026-10-15T09:00:00Z',
        recurring: true,
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
        recurrenceId: '2026-10-15T08:00:00Z',
      }),
    )
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })
    expect(within(dialog).queryByText(hint)).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: /^Start Thu, Oct 15/ }))
    await user.click(screen.getByRole('button', { name: 'Friday, October 16th, 2026' }))
    expect(within(dialog).getByText(hint)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: /^Start Fri, Oct 16/ }))
    await user.click(screen.getByRole('button', { name: 'Thursday, October 15th, 2026' }))
    expect(within(dialog).queryByText(hint)).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByRole('alertdialog', { name: 'This event repeats. Which events should change?' })).toBeInTheDocument()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  // A new rule can only be the whole series' (FR-17), whatever day the event moves to with it.
  it('saves a new rule for the whole series without asking', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(
      apiEvent({ id: 'e1', recurring: true, first: true, rrule: 'FREQ=MONTHLY;BYMONTHDAY=25', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: /^Start Fri, Sep 25/ }))
    await user.click(screen.getByRole('button', { name: 'Saturday, September 26th, 2026' }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeat' }))
    await user.click(screen.getByRole('option', { name: 'Every day' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    })
    const puts = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(puts).toHaveLength(1)
    const [url, init] = puts[0]!
    expect(urlOf(url)).toBe('/api/v1/events/e1')
    expect(bodyOf(init)).toMatchObject({ rrule: 'FREQ=DAILY', start: '2026-09-26T08:00:00.000Z' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
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

  // FR-17: the question is about the values Save was pressed with; the form stays editable
  // meanwhile, and a change asks again on the next Save, about the new values.
  it('drops the scope question once the form changes, and saves the new values on the next Save', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    within(dialog).getByRole('alertdialog')
    const title = within(dialog).getByPlaceholderText('Add a title')
    await user.type(title, ' moved')

    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    // The edit keeps the focus where it is typed.
    expect(title).toHaveFocus()
    expect(title).toHaveValue('Event moved')
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await user.click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: 'Only this event' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    })
    const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'PUT')!
    expect(bodyOf(init)).toHaveProperty('title', 'Event moved')
  })

  it('saves without asking after the question when the change makes the series all-day', async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, first: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { dialog, fetch } = await openEditor({ mode: 'edit', event })

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    within(dialog).getByRole('alertdialog')
    await user.click(within(dialog).getByRole('switch', { name: 'All day' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    await waitFor(() => {
      expect(fetch.mock.calls.some(([input, init]) => init?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))).toBe(
        true,
      )
    })
    const [, init] = fetch.mock.calls.find(([input, i]) => i?.method === 'PUT' && urlOf(input).endsWith('/events/e1'))!
    expect(bodyOf(init)).toHaveProperty('allDay', true)
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
