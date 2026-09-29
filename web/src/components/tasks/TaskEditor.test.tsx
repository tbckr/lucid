import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { EditorDialog } from '@/components/EditorDialog'
import { type Calendar, type Todo } from '@/lib/api/schemas'
import { draftOf, type Draft } from '@/lib/quickCreate'
import { useUi } from '@/stores/ui'
import { bodyOf, calendar, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'

/** Open the editor for `t` and wait until its list is loaded. */
async function openTask(t: Todo, list: Calendar = calendar()) {
  api.setCsrfToken('tok')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (urlOf(input).endsWith('/calendars')) return Promise.resolve(jsonResponse(200, { calendars: [list] }))
    if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
    return Promise.resolve(jsonResponse(200, { ...t, etag: '"2"' }))
  })
  act(() => {
    useUi.getState().openTaskEditor({ mode: 'edit', todo: t })
  })
  const { queryClient } = renderWithProviders(<EditorDialog />)
  await waitFor(() => {
    expect(queryClient.getQueryData(queryKeys.calendars)).toBeDefined()
  })
  return { fetch, dialog: await screen.findByRole('dialog', { name: 'Edit task' }) }
}

/** Open the editor for a new task and wait until the lists are loaded. */
async function openNew(draft: Draft, lists: Calendar[] = [calendar()]) {
  api.setCsrfToken('tok')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
    Promise.resolve(
      urlOf(input).endsWith('/calendars')
        ? jsonResponse(200, { calendars: lists })
        : jsonResponse(201, todo({ title: draft.title, calendarId: draft.calendarId })),
    ),
  )
  act(() => {
    useUi.getState().openTaskEditor({ mode: 'create', draft })
  })
  const { queryClient } = renderWithProviders(<EditorDialog />)
  await waitFor(() => {
    expect(queryClient.getQueryData(queryKeys.calendars)).toBeDefined()
  })
  return { fetch, dialog: await screen.findByRole('dialog', { name: 'New task' }) }
}

// From a click at 10:15 on Wednesday, 30 September 2026: due then.
const slides: Draft = {
  ...draftOf(
    { start: new Date(2026, 8, 30, 10, 15), end: new Date(2026, 8, 30, 11, 15), allDay: false, granularity: 'time', ranged: false },
    'Europe/Berlin',
  ),
  title: 'Slides',
  calendarId: 'c1',
}

/** Body of the PUT the editor sent. */
async function saved(fetch: Awaited<ReturnType<typeof openTask>>['fetch']) {
  await waitFor(() => {
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
  })
  const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'PUT')!
  return bodyOf(init)
}

describe('TaskEditor', () => {
  afterEach(() => {
    useUi.getState().openTaskEditor(null)
    vi.restoreAllMocks()
  })

  it.each([
    ['Start', 'Remove start date', 'start', 'due'],
    ['Due', 'Remove due date', 'due', 'start'],
  ])('%s: "%s" in the month removes the date together with its time', async (row, button, removed, kept) => {
    const t = todo({ title: 'Slides', start: '2026-09-25T07:00:00Z', due: '2026-09-25T09:00:00Z' })
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(t)

    await user.click(within(dialog).getByRole('button', { name: `${row} Fri, Sep 25` }))
    const month = screen.getByRole('dialog', { name: `${row} date` })
    await user.click(within(month).getByRole('button', { name: button }))
    expect(within(dialog).getByRole('button', { name: `${row} Add a date` })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    const keptValue = new Date(t[kept as 'start' | 'due']!).toISOString()
    expect(await saved(fetch)).toMatchObject({ [removed]: null, [`${removed}AllDay`]: false, [kept]: keptValue })
  })

  it('completes the task from the check in front of its title', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ title: 'Slides' }))

    await user.click(within(dialog).getByRole('checkbox', { name: 'Completed' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await saved(fetch)).toMatchObject({ status: 'COMPLETED' })
  })

  it('says a task is overdue until it is checked off', async () => {
    const user = userEvent.setup()
    const { dialog } = await openTask(todo({ due: '2020-03-10T00:00:00Z', dueAllDay: true }))
    expect(within(dialog).getByText('Overdue')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('checkbox', { name: 'Completed' }))
    expect(within(dialog).queryByText('Overdue')).toBeNull()
  })

  it.each([
    [3, 'Medium', 5],
    [0, 'Low', 9],
    [5, 'None', 0],
    // The level stays High, so the exact RFC 5545 value is kept.
    [3, 'High', 3],
  ])('priority %i, then %s, saves %i', async (priority, level, want) => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ priority }))

    await user.click(within(dialog).getByRole('radio', { name: level }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await saved(fetch)).toMatchObject({ priority: want })
  })

  it('picks a start date in the month of the due date and gives it the due time', async () => {
    const user = userEvent.setup()
    // Due Friday, 13 March 2026, 14:00 in Berlin.
    const { fetch, dialog } = await openTask(todo({ due: '2026-03-13T13:00:00Z' }))

    await user.click(within(dialog).getByRole('button', { name: 'Start Add a date' }))
    await user.click(screen.getByRole('button', { name: 'Wednesday, March 11th, 2026' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await saved(fetch)).toMatchObject({ start: '2026-03-11T13:00:00.000Z', startAllDay: false })
  })

  it('makes a due date all-day with "No time"', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ due: '2026-03-13T13:00:00Z' }))

    await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
    await user.click(screen.getByRole('option', { name: 'No time' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await saved(fetch)).toMatchObject({ due: '2026-03-13T00:00:00.000Z', dueAllDay: true })
  })

  it('saves a checklist item that was typed but not yet added', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ checklist: [{ text: '2 liters', done: false }] }))

    await user.click(within(dialog).getByRole('checkbox', { name: '2 liters done' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Add checklist item' }), 'check fridge')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await saved(fetch)).toMatchObject({
      checklist: [
        { text: '2 liters', done: true },
        { text: 'check fridge', done: false },
      ],
    })
  })

  it('removes a checklist item', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo({ checklist: [{ text: '2 liters', done: false }] }))

    await user.click(within(dialog).getByRole('button', { name: 'Remove 2 liters' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await saved(fetch)).toMatchObject({ checklist: [] })
  })

  it('asks in the footer before it deletes the task', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openTask(todo())

    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Delete this task?')
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)

    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    })
  })

  it('keeps the focus in the footer while it asks before deleting', async () => {
    const user = userEvent.setup()
    const { dialog } = await openTask(todo())

    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }))
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(within(dialog).getByRole('button', { name: 'Delete task' })).toHaveFocus()
  })

  it('says a read-only list cannot be changed and offers no changes', async () => {
    const { dialog } = await openTask(todo(), calendar({ readOnly: true }))

    expect(within(dialog).getByText('This list is read-only.')).toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: 'Completed' })).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Delete task' })).toBeNull()
  })
  it('creates a task in the chosen list with the given dates', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openNew(slides)
    expect(within(dialog).getByPlaceholderText('Add a title')).toHaveValue('Slides')
    expect(within(dialog).queryByRole('button', { name: 'Delete task' })).toBeNull()
    expect(within(dialog).queryByRole('checkbox', { name: 'Completed' })).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Create task' }))
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    })
    const [input, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!
    expect(urlOf(input)).toMatch(/\/calendars\/c1\/todos$/)
    expect(bodyOf(init)).toMatchObject({
      title: 'Slides',
      start: null,
      due: '2026-09-30T08:15:00.000Z',
      dueAllDay: false,
      status: 'NEEDS-ACTION',
    })
    await waitFor(() => {
      expect(useUi.getState().taskEditor).toBeNull()
    })
  })

  it('offers only lists that take new tasks', async () => {
    const user = userEvent.setup()
    const { dialog } = await openNew(slides, [
      calendar(),
      calendar({ id: 'c2', name: 'Shared', readOnly: true }),
      calendar({ id: 'c3', name: 'Work', supportsTodos: false }),
    ])
    await user.click(within(dialog).getByRole('combobox', { name: 'Task list' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Personal'])
  })
})
