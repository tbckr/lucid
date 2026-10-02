import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { type Calendar } from '@/lib/api/schemas'
import { toCalEvent } from '@/lib/events'
import { useSettings } from '@/stores/settings'
import { useUi, type EditorState } from '@/stores/ui'
import { apiEvent, bodyOf, calendar, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { EditorDialog } from './EditorDialog'
import { newDraft } from './views/createDefaults'

const personal = calendar({ id: 'c1', name: 'Personal', supportsTodos: false })
const work = calendar({ id: 'c2', name: 'Work', color: '#22c55e' })
const tasks = calendar({ id: 'c3', name: 'Tasks', color: '#f97316', supportsEvents: false })
const home = calendar({ id: 'c4', name: 'Home', color: '#a855f7' })

// "Create" on Wednesday, 11 March 2026 (a day other than today): 09:00-10:00.
const draft = newDraft(new Date(2026, 2, 11), new Date(2026, 2, 10, 15, 20))

/**
 * Open the event editor with `state` once the calendars are loaded, as "Create"
 * and `c` do, or the task editor, as "More options" in the create popover.
 */
async function open(
  state: NonNullable<EditorState>,
  calendars: Calendar[] = [personal, work, tasks],
  editor: 'event' | 'task' = 'event',
) {
  api.setCsrfToken('tok')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = urlOf(input)
    if (url.endsWith('/calendars')) return Promise.resolve(jsonResponse(200, { calendars }))
    if (init?.method === 'POST') return Promise.resolve(jsonResponse(201, url.endsWith('/todos') ? todo() : apiEvent()))
    return Promise.resolve(jsonResponse(200, {}))
  })
  const { queryClient } = renderWithProviders(<EditorDialog />)
  await waitFor(() => {
    expect(queryClient.getQueryData(queryKeys.calendars)).toBeDefined()
  })
  act(() => {
    if (editor === 'task' && state.mode === 'create') useUi.getState().openTaskEditor(state)
    else useUi.getState().openEditor(state)
  })
  return { fetch, dialog: await screen.findByRole('dialog') }
}

/** A side of the kind switch, found by its text: a search by role also scans the time pickers' hidden options. */
const kind = (name: 'Event' | 'Task') => screen.getByText(name, { selector: '[role=radio]' })
const titleField = () => screen.getByPlaceholderText('Add a title')

describe('EditorDialog', () => {
  afterEach(() => {
    act(() => {
      useUi.getState().openEditor(null)
    })
    useSettings.setState({ taskList: '' })
    vi.restoreAllMocks()
  })

  it('makes a new event a task that keeps its title, notes and day', async () => {
    const user = userEvent.setup()
    await open({ mode: 'create', draft })
    await user.type(titleField(), 'Call')
    await user.type(screen.getByPlaceholderText('Add a description'), 'Agenda')

    await user.click(kind('Task'))
    const dialog = await screen.findByRole('dialog', { name: 'New task' })
    expect(titleField()).toHaveValue('Call')
    expect(within(dialog).getByPlaceholderText('Add notes')).toHaveValue('Agenda')
    expect(within(dialog).getByRole('button', { name: /^Due Wed, Mar 11/ })).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'Task list' })).toHaveTextContent('Work')
    expect(kind('Task')).toHaveAttribute('aria-checked', 'true')
  })

  it('makes the task the event it was again', async () => {
    const user = userEvent.setup()
    await open({ mode: 'create', draft })
    await user.click(kind('Task'))
    await user.click(kind('Event'))
    const dialog = await screen.findByRole('dialog', { name: 'New event' })
    expect(within(dialog).getByRole('button', { name: /^Start Wed, Mar 11/ })).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'Start time' })).toHaveTextContent('9:00 AM')
    expect(within(dialog).getByRole('combobox', { name: 'End time' })).toHaveTextContent('10:00 AM')
  })

  it("takes the sidebar's list for the task rather than the event's calendar", async () => {
    useSettings.setState({ taskList: 'c3' })
    const user = userEvent.setup()
    await open({ mode: 'create', draft }, [work, home, tasks])
    expect(screen.getByRole('combobox', { name: 'Calendar' })).toHaveTextContent('Work')
    await user.click(kind('Task'))
    expect(screen.getByRole('combobox', { name: 'Task list' })).toHaveTextContent('Tasks')
  })

  it('keeps a chosen calendar that takes tasks', async () => {
    useSettings.setState({ taskList: 'c3' })
    const user = userEvent.setup()
    await open({ mode: 'create', draft }, [work, home, tasks])
    await user.click(screen.getByRole('combobox', { name: 'Calendar' }))
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Home' }))
    await user.click(kind('Task'))
    expect(screen.getByRole('combobox', { name: 'Task list' })).toHaveTextContent('Home')
  })

  it('creates the task in its list after the switch', async () => {
    useSettings.setState({ taskList: 'c3' })
    const user = userEvent.setup()
    const { fetch } = await open({ mode: 'create', draft })
    await user.type(titleField(), 'Call')
    await user.click(kind('Task'))
    await user.click(screen.getByRole('button', { name: 'Create task' }))

    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    })
    const [input, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!
    expect(urlOf(input)).toMatch(/\/calendars\/c3\/todos$/)
    expect(bodyOf(init)).toMatchObject({ title: 'Call', start: null, dueAllDay: true })
    await waitFor(() => {
      expect(useUi.getState().taskEditor).toBeNull()
    })
  })

  it('focuses the title of a new entry, and the switch after it switched', async () => {
    const user = userEvent.setup()
    await open({ mode: 'create', draft })
    await waitFor(() => {
      expect(titleField()).toHaveFocus()
    })

    await user.keyboard('{Shift>}{Tab}{/Shift}{ArrowRight} ')
    await screen.findByRole('dialog', { name: 'New task' })
    await waitFor(() => {
      expect(kind('Task')).toHaveFocus()
    })
  })

  it('starts a new task in its title too', async () => {
    const { dialog } = await open({ mode: 'create', draft }, undefined, 'task')
    expect(dialog).toHaveAccessibleName('New task')
    await waitFor(() => {
      expect(titleField()).toHaveFocus()
    })
  })

  it('opens a new entry as a task where only task lists take one', async () => {
    const { dialog } = await open({ mode: 'create', draft }, [calendar({ ...work, readOnly: true }), tasks])
    expect(dialog).toHaveAccessibleName('New task')
    expect(within(dialog).queryByRole('radio', { name: 'Event' })).toBeNull()
    await waitFor(() => {
      expect(titleField()).toHaveFocus()
    })
  })

  it('waits for the calendars before it shows a new entry', async () => {
    // `c` right after the page loads: the calendar list is still on its way.
    api.setCsrfToken('tok')
    let release: () => void = () => undefined
    const listed = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (!urlOf(input).endsWith('/calendars')) return jsonResponse(200, {})
      await listed
      return jsonResponse(200, { calendars: [personal, work, tasks] })
    })
    renderWithProviders(<EditorDialog />)
    act(() => {
      useUi.getState().openEditor({ mode: 'create', draft })
    })
    expect(screen.queryByText('None of your calendars accept new events.')).toBeNull()

    release()
    const dialog = await screen.findByRole('dialog', { name: 'New event' })
    expect(within(dialog).getByRole('combobox', { name: 'Calendar' })).toHaveTextContent('Personal')
    await waitFor(() => {
      expect(titleField()).toHaveFocus()
    })
  })

  it('offers no switch where only events can be created', async () => {
    const { dialog } = await open({ mode: 'create', draft }, [personal])
    expect(dialog).toHaveAccessibleName('New event')
    expect(within(dialog).queryByRole('radio', { name: 'Task' })).toBeNull()
  })

  // NFR-27: the Escape handler that cancels the editor's save scope question is wired through a
  // ref that outlives any one EventEditor instance; closing the editor while the question is
  // open must drop it, or the next editor's first Escape finds a stale cancel and is swallowed.
  it("does not swallow the next editor's Escape after closing one with its scope question open", async () => {
    const user = userEvent.setup()
    const event = toCalEvent(apiEvent({ id: 'e1', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }))
    const { fetch } = await open({ mode: 'edit', event })

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alertdialog')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => {
      useUi.getState().openEditor({ mode: 'create', draft })
    })
    await screen.findByRole('dialog', { name: 'New event' })

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  it('offers no switch when editing', async () => {
    const { dialog } = await open({ mode: 'edit', event: toCalEvent(apiEvent()) })
    expect(dialog).toHaveAccessibleName('Edit event')
    expect(within(dialog).queryByRole('radio', { name: 'Task' })).toBeNull()
    act(() => {
      useUi.getState().openTaskEditor({ mode: 'edit', todo: todo() })
    })
    expect(await screen.findByRole('dialog', { name: 'Edit task' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Event' })).toBeNull()
  })
})
