import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { useShortcuts } from '@/hooks/useShortcuts'
import { api } from '@/lib/api/client'
import { type Calendar } from '@/lib/api/schemas'
import { type CreateOrigin } from '@/lib/quickCreate'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { apiEvent, bodyOf, calendar, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { CreatePopover } from './CreatePopover'

const personal = calendar({ id: 'c1', name: 'Personal', supportsTodos: false })
const work = calendar({ id: 'c2', name: 'Work', color: '#22c55e' })
const tasks = calendar({ id: 'c3', name: 'Tasks', color: '#f97316', supportsEvents: false })

// A click on Wednesday, 30 September 2026 at 10:15 in the time grid.
const click: CreateOrigin = {
  start: new Date(2026, 8, 30, 10, 15),
  end: new Date(2026, 8, 30, 11, 15),
  allDay: false,
  granularity: 'time',
  ranged: false,
}

const onShortcut = vi.fn()

function Shortcuts() {
  useShortcuts(onShortcut)
  return null
}

interface Options {
  calendars?: Calendar[]
  /** Answer to the POST that creates the entry. */
  post?: () => Promise<Response>
  /** Hold the calendar list back until `release` is called. */
  later?: boolean
  origin?: CreateOrigin
  /** Profiles the popover's renders. */
  onRender?: ProfilerOnRenderCallback
}

/** Open the popover as a click in a day column (or `origin`) would, and render it. */
async function openPopover({
  calendars = [personal, work, tasks],
  post,
  later = false,
  origin = click,
  onRender,
}: Options = {}) {
  api.setCsrfToken('tok')
  let release: () => void = () => undefined
  const listed = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = urlOf(input)
    if (url.endsWith('/calendars')) {
      if (later) await listed
      return jsonResponse(200, { calendars })
    }
    if (init?.method === 'POST') {
      if (post) return post()
      return jsonResponse(201, url.endsWith('/todos') ? todo() : apiEvent())
    }
    return jsonResponse(200, {})
  })
  const column = document.createElement('div')
  const slot = document.createElement('button')
  column.append(slot)
  document.body.append(column)
  act(() => {
    useUi.getState().openCreate({ origin, anchor: column, span: { startMin: 615, endMin: 675 }, returnFocus: slot })
  })
  const { queryClient } = renderWithProviders(
    <>
      {onRender ? (
        <Profiler id="create" onRender={onRender}>
          <CreatePopover />
        </Profiler>
      ) : (
        <CreatePopover />
      )}
      <Shortcuts />
    </>,
  )
  if (!later) {
    await waitFor(() => {
      expect(queryClient.getQueryData(queryKeys.calendars)).toBeDefined()
    })
  }
  return { fetch, slot, release, dialog: await screen.findByRole('dialog') }
}

/**
 * An option of the open list. Each picker also keeps a hidden native select
 * with the same options, so a search of the whole page is slow and ambiguous.
 */
function option(name: string) {
  return within(screen.getByRole('listbox')).getByRole('option', { name })
}

/** The request the popover sent to create the entry. */
async function posted(fetch: Awaited<ReturnType<typeof openPopover>>['fetch']) {
  await waitFor(() => {
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
  })
  const [input, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!
  return { url: urlOf(input), body: bodyOf(init) }
}

describe('CreatePopover', () => {
  afterEach(() => {
    act(() => {
      useUi.getState().openCreate(null)
      useUi.getState().openEditor(null)
      useUi.getState().openTaskEditor(null)
    })
    useSettings.setState({ taskList: '' })
    onShortcut.mockClear()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('focuses the title and creates the event on Enter', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openPopover()
    expect(dialog).toHaveAccessibleName('New event')
    expect(within(dialog).getByPlaceholderText('Add a title')).toHaveFocus()

    await user.keyboard('Review{Enter}')
    const { url, body } = await posted(fetch)
    expect(url).toMatch(/\/calendars\/c1\/events$/)
    expect(body).toMatchObject({ title: 'Review', start: '2026-09-30T08:15:00.000Z', end: '2026-09-30T09:15:00.000Z', allDay: false })
    await waitFor(() => {
      expect(useUi.getState().create).toBeNull()
    })
  })

  it('switches to a task due at the clicked time, keeping the title', async () => {
    useSettings.setState({ taskList: 'c3' })
    const user = userEvent.setup()
    const { fetch, dialog } = await openPopover()
    await user.keyboard('Call')
    await user.click(within(dialog).getByRole('radio', { name: 'Task' }))

    expect(dialog).toHaveAccessibleName('New task')
    expect(within(dialog).getByPlaceholderText('Add a title')).toHaveValue('Call')
    expect(within(dialog).getByText('Due')).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'Due time' })).toHaveTextContent('10:15 AM')
    expect(within(dialog).getByRole('combobox', { name: 'Task list' })).toHaveTextContent('Tasks')

    await user.click(within(dialog).getByRole('button', { name: 'Create task' }))
    const { url, body } = await posted(fetch)
    expect(url).toMatch(/\/calendars\/c3\/todos$/)
    expect(body).toMatchObject({
      title: 'Call',
      start: null,
      due: '2026-09-30T08:15:00.000Z',
      dueAllDay: false,
      priority: 0,
      checklist: [],
      status: 'NEEDS-ACTION',
    })
  })

  it('keeps a calendar that takes both kinds', async () => {
    useSettings.setState({ taskList: 'c3' })
    const user = userEvent.setup()
    const { dialog } = await openPopover()
    await user.click(within(dialog).getByRole('combobox', { name: 'Calendar' }))
    await user.click(option('Work'))
    await user.click(within(dialog).getByRole('radio', { name: 'Task' }))
    expect(within(dialog).getByRole('combobox', { name: 'Task list' })).toHaveTextContent('Work')
  })

  it('asks for a title before creating a task', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openPopover()
    await user.click(within(dialog).getByRole('radio', { name: 'Task' }))
    await user.click(within(dialog).getByRole('button', { name: 'Create task' }))
    expect(await within(dialog).findByText('Enter a title.')).toBeInTheDocument()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('creates once when Enter is pressed twice', async () => {
    const user = userEvent.setup()
    const { fetch } = await openPopover({ post: () => new Promise<Response>(() => undefined) })
    await user.keyboard('X{Enter}{Enter}')
    await posted(fetch)
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('creates once however the form is sent again while it waits', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openPopover({ post: () => new Promise<Response>(() => undefined) })
    await user.keyboard('X{Enter}')
    await posted(fetch)
    // A second submission that no disabled button holds back.
    await act(async () => {
      dialog.querySelector('form')!.requestSubmit()
      // The mutation calls fetch asynchronously.
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('leaves shortcut letters to the title', async () => {
    const user = userEvent.setup()
    const { dialog } = await openPopover()
    await user.keyboard('dmt')
    expect(within(dialog).getByPlaceholderText('Add a title')).toHaveValue('dmt')
    expect(onShortcut).not.toHaveBeenCalled()
  })

  it('hands the values to the event editor', async () => {
    const user = userEvent.setup()
    const { dialog } = await openPopover()
    await user.keyboard('Review')
    await user.click(within(dialog).getByRole('button', { name: 'More options' }))
    // No calendar was chosen: the editor chooses by the same rules.
    expect(useUi.getState().editor).toMatchObject({
      mode: 'create',
      draft: {
        title: 'Review',
        calendarId: '',
        event: { allDay: false, startDate: '2026-09-30', startTime: '10:15', endDate: '2026-09-30', endTime: '11:15' },
      },
    })
    expect(useUi.getState().create).toBeNull()
  })

  it('hands the values to the task editor', async () => {
    const user = userEvent.setup()
    const { dialog } = await openPopover()
    await user.keyboard('Call')
    await user.click(within(dialog).getByRole('radio', { name: 'Task' }))
    await user.click(within(dialog).getByRole('button', { name: 'More options' }))
    expect(useUi.getState().taskEditor).toMatchObject({
      mode: 'create',
      draft: { title: 'Call', calendarId: '', task: { startDate: '', startTime: '', dueDate: '2026-09-30', dueTime: '10:15' } },
    })
    expect(useUi.getState().create).toBeNull()
  })

  it('closes on Escape and returns focus to the clicked slot', async () => {
    const user = userEvent.setup()
    const { slot } = await openPopover()
    await user.keyboard('{Escape}')
    expect(useUi.getState().create).toBeNull()
    await waitFor(() => {
      expect(slot).toHaveFocus()
    })
  })

  it('writes the preview the views draw', async () => {
    useSettings.setState({ taskList: 'c3' })
    const user = userEvent.setup()
    const { dialog } = await openPopover()
    await user.keyboard('Rev')
    expect(useUi.getState().createPreview).toMatchObject({
      kind: 'event',
      calendarId: 'c1',
      title: 'Rev',
      start: click.start,
      end: click.end,
      allDay: false,
      point: false,
    })
    await user.click(within(dialog).getByRole('radio', { name: 'Task' }))
    expect(useUi.getState().createPreview).toMatchObject({ kind: 'task', calendarId: 'c3', start: click.start, point: true })
  })

  it('has no switch when only events can be created', async () => {
    const { dialog } = await openPopover({ calendars: [personal] })
    expect(within(dialog).queryByRole('group', { name: 'Type' })).toBeNull()
    expect(dialog).toHaveAccessibleName('New event')
  })

  it('creates a task when only task lists take new entries', async () => {
    const { dialog } = await openPopover({ calendars: [tasks] })
    await waitFor(() => {
      expect(dialog).toHaveAccessibleName('New task')
    })
    expect(within(dialog).queryByRole('group', { name: 'Type' })).toBeNull()
  })

  it('says so when no calendar takes new entries', async () => {
    const { dialog } = await openPopover({ calendars: [calendar({ readOnly: true })] })
    expect(await within(dialog).findByText('None of your calendars accept new events.')).toBeInTheDocument()
  })

  it('picks the calendar once the calendars have loaded', async () => {
    const { dialog, release } = await openPopover({ later: true })
    expect(within(dialog).queryByText('None of your calendars accept new events.')).toBeNull()
    act(() => {
      release()
    })
    await waitFor(() => {
      expect(within(dialog).getByRole('combobox', { name: 'Calendar' })).toHaveTextContent('Personal')
    })
  })

  it('stays open with the input when creating fails', async () => {
    const user = userEvent.setup()
    const { fetch, dialog } = await openPopover({
      post: () => Promise.resolve(jsonResponse(500, { error: { code: 'internal', message: 'x' } })),
    })
    await user.keyboard('Review{Enter}')
    await posted(fetch)
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Create event' })).toBeEnabled()
    })
    expect(useUi.getState().create).not.toBeNull()
    expect(within(dialog).getByPlaceholderText('Add a title')).toHaveValue('Review')
  })

  it('closes when the view or date changes', async () => {
    await openPopover()
    act(() => {
      useUi.getState().setView('week')
    })
    expect(useUi.getState().create).toBeNull()
  })
  it('keeps a time set after a click in a month cell when switching to a task', async () => {
    useSettings.setState({ taskList: 'c3' })
    const user = userEvent.setup()
    const month: CreateOrigin = {
      start: new Date(2026, 8, 30, 9),
      end: new Date(2026, 8, 30, 10),
      allDay: false,
      granularity: 'day',
      ranged: false,
    }
    const { dialog } = await openPopover({ origin: month })
    await user.click(within(dialog).getByRole('combobox', { name: 'Start time' }))
    await user.click(option('2:00 PM'))
    await user.click(within(dialog).getByRole('radio', { name: 'Task' }))
    expect(within(dialog).getByRole('combobox', { name: 'Due time' })).toHaveTextContent('2:00 PM')
  })
  it('shows the end date of an event that runs past midnight, and keeps it while it is edited', async () => {
    const user = userEvent.setup()
    const late = { ...click, start: new Date(2026, 8, 30, 23, 30), end: new Date(2026, 9, 1, 0, 30) }
    const { dialog } = await openPopover({ origin: late })
    const end = within(dialog).getByRole('button', { name: /^End Thu, Oct 1/ })
    await user.click(end)
    await user.click(within(screen.getByRole('dialog', { name: 'End date' })).getByRole('button', { name: /September 30th/ }))
    // Back on the start's day: the field stays where the focus is.
    const same = within(dialog).getByRole('button', { name: /^End Wed, Sep 30/ })
    await waitFor(() => {
      expect(same).toHaveFocus()
    })
  })
  // A start time changed before the switch to a task: the month-cell test above.
  it('keeps a changed due time when switching back to an event', async () => {
    const user = userEvent.setup()
    const { dialog } = await openPopover()
    await user.click(within(dialog).getByRole('radio', { name: 'Task' }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
    await user.click(option('4:00 PM'))
    // Back as an event: at the task's time, with the event's length.
    await user.click(within(dialog).getByRole('radio', { name: 'Event' }))
    expect(within(dialog).getByRole('combobox', { name: 'Start time' })).toHaveTextContent('4:00 PM')
    expect(within(dialog).getByRole('combobox', { name: 'End time' })).toHaveTextContent('5:00 PM')
  })
  it('renders once per keystroke of the title', async () => {
    const onRender = vi.fn<ProfilerOnRenderCallback>()
    const user = userEvent.setup()
    await openPopover({ onRender })
    await user.keyboard('R')
    onRender.mockClear()
    // Writing the preview for the views must not render the popover a second time.
    await user.keyboard('e')
    expect(onRender).toHaveBeenCalledTimes(1)
  })
})
