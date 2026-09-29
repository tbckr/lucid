import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api/client'
import { type Calendar, type Todo } from '@/lib/api/schemas'
import { defaultSettings, useSettings } from '@/stores/settings'
import { bodyOf, calendar, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { TasksPanel } from './TasksPanel'

const personal = calendar({ id: 'a', name: 'Personal' })
const work = calendar({ id: 'b', name: 'Work' })
const errands = calendar({ id: 'c', name: 'Errands' })
const tasksOf: Record<string, Todo[]> = {
  a: [
    todo({ id: 'milk', calendarId: 'a', title: 'Buy milk' }),
    todo({ id: 'bread', calendarId: 'a', title: 'Buy bread' }),
    todo({ id: 'plants', calendarId: 'a', title: 'Water plants', status: 'COMPLETED' }),
  ],
  b: [todo({ id: 'taxes', calendarId: 'b', title: 'File taxes' })],
  c: [
    todo({ id: 'someday', calendarId: 'c', title: 'Fix the bike' }),
    todo({ id: 'done', calendarId: 'c', title: 'Return books', status: 'COMPLETED' }),
    todo({ id: 'late', calendarId: 'c', title: 'Renew passport', due: '2020-01-10T00:00:00Z', dueAllDay: true }),
    todo({ id: 'future', calendarId: 'c', title: 'Book flights', due: '2099-01-10T00:00:00Z', dueAllDay: true }),
  ],
  d: [todo({ id: 'plants', calendarId: 'd', title: 'Water plants', status: 'COMPLETED' })],
  e: [
    todo({ id: 'rent', calendarId: 'e', title: 'Pay rent', status: 'COMPLETED', etag: '"4"' }),
    todo({ id: 'keys', calendarId: 'e', title: 'Copy keys' }),
    todo({ id: 'plumber', calendarId: 'e', title: 'Call the plumber', status: 'CANCELLED', etag: '"9"' }),
  ],
}

/** Serves the calendars and their tasks, and deletes them; returns the fetch spy. */
function serve(calendars: Calendar[]) {
  const deleted = new Set<string>()
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = urlOf(input)
    if (url.endsWith('/calendars')) return Promise.resolve(jsonResponse(200, { calendars }))
    if (init?.method === 'DELETE') {
      deleted.add(url.split('/').at(-1) ?? '')
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    const id = /\/calendars\/(\w+)\/todos$/.exec(url)?.[1] ?? ''
    if (init?.method === 'POST') {
      return Promise.resolve(jsonResponse(201, todo({ id: 'new', calendarId: id, title: 'New' })))
    }
    const todos = (tasksOf[id] ?? []).filter((x) => !deleted.has(x.id))
    return Promise.resolve(jsonResponse(200, { todos, corrupted: [] }))
  })
}

const taskTitles = () => screen.getAllByRole('checkbox').map((b) => b.getAttribute('aria-label'))

// jsdom has no layout: the virtualizer reads offsetWidth/offsetHeight of its scroll element and renders no rows at 0.
const layout = { offsetWidth: 320, offsetHeight: 600 }
const original = Object.fromEntries(
  Object.keys(layout).map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)]),
)

describe('TasksPanel', () => {
  beforeAll(() => {
    for (const [k, v] of Object.entries(layout)) {
      Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v })
    }
  })

  afterAll(() => {
    for (const [k, d] of Object.entries(original)) {
      if (d) Object.defineProperty(HTMLElement.prototype, k, d)
    }
  })

  afterEach(() => {
    useSettings.setState(defaultSettings)
  })

  it('shows only the tasks of the first list by default', async () => {
    serve([personal, work])
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    expect(await screen.findByRole('checkbox', { name: 'Completed: Buy milk' })).toBeInTheDocument()
    expect(taskTitles()).toEqual(['Completed: Buy bread', 'Completed: Buy milk', 'Completed: Water plants'])
  })

  it('switches to the list chosen in the dropdown and saves it', async () => {
    serve([personal, work])
    const user = userEvent.setup()
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    await screen.findByRole('checkbox', { name: 'Completed: Buy milk' })
    await user.click(screen.getByRole('combobox', { name: 'Task list' }))
    await user.click(await screen.findByRole('option', { name: /Work/ }))
    expect(await screen.findByRole('checkbox', { name: 'Completed: File taxes' })).toBeInTheDocument()
    expect(taskTitles()).toEqual(['Completed: File taxes'])
    expect(useSettings.getState().taskList).toBe('b')
  })

  it('counts only open tasks in the dropdown', async () => {
    serve([personal, work])
    const user = userEvent.setup()
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    await screen.findByRole('checkbox', { name: 'Completed: Buy milk' })
    await user.click(screen.getByRole('combobox', { name: 'Task list' }))
    expect(await screen.findByRole('option', { name: /Personal/ })).toHaveTextContent('2 open')
    expect(screen.getByRole('option', { name: /Work/ })).toHaveTextContent('1 open')
  })

  it('restores the saved list', async () => {
    useSettings.setState({ taskList: 'b' })
    serve([personal, work])
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    expect(await screen.findByRole('checkbox', { name: 'Completed: File taxes' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Task list' })).toHaveTextContent('Work')
  })

  it('adds a new task to the selected list', async () => {
    api.setCsrfToken('tok')
    useSettings.setState({ taskList: 'b' })
    const fetch = serve([personal, work])
    const user = userEvent.setup()
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    await screen.findByRole('checkbox', { name: 'Completed: File taxes' })
    await user.type(screen.getByRole('textbox', { name: 'Add task' }), 'Pay rent{Enter}')
    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    })
    const [url, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!
    expect(urlOf(url)).toBe('/api/v1/calendars/b/todos')
    expect(bodyOf(init).title).toBe('Pay rent')
  })

  it('offers no input for a read-only list', async () => {
    useSettings.setState({ taskList: 'b' })
    serve([personal, calendar({ id: 'b', name: 'Work', readOnly: true })])
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    await screen.findByRole('checkbox', { name: 'Completed: File taxes' })
    expect(screen.queryByRole('textbox', { name: 'Add task' })).not.toBeInTheDocument()
  })

  it('names the list and counts its open tasks', async () => {
    serve([personal])
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    expect(await screen.findByRole('heading', { level: 2, name: 'Personal' })).toBeInTheDocument()
    expect(await screen.findByText('2 open')).toBeInTheDocument()
  })

  it('names the chosen list when there are several', async () => {
    useSettings.setState({ taskList: 'b' })
    serve([personal, work])
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    expect(await screen.findByRole('heading', { level: 2, name: 'Work' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Tasks' })).toBeInTheDocument()
  })

  it('groups the tasks by when they are due', async () => {
    serve([errands])
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    await screen.findByRole('checkbox', { name: 'Completed: Fix the bike' })
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Overdue',
      'Later',
      'No due date',
      'Completed 1',
    ])
    expect(taskTitles()).toEqual([
      'Completed: Renew passport',
      'Completed: Book flights',
      'Completed: Fix the bike',
      'Completed: Return books',
    ])
  })

  it('collapses the completed tasks and remembers it', async () => {
    serve([personal])
    const user = userEvent.setup()
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    await screen.findByRole('checkbox', { name: 'Completed: Water plants' })
    const completed = screen.getByRole('button', { name: /^Completed/ })
    expect(completed).toHaveAttribute('aria-expanded', 'true')
    await user.click(completed)
    expect(completed).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('checkbox', { name: 'Completed: Water plants' })).not.toBeInTheDocument()
    expect(useSettings.getState().hideCompletedTasks).toBe(true)
  })

  it('restores collapsed completed tasks', async () => {
    useSettings.setState({ hideCompletedTasks: true })
    serve([personal])
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    await screen.findByRole('checkbox', { name: 'Completed: Buy milk' })
    expect(screen.getByRole('button', { name: /^Completed/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('checkbox', { name: 'Completed: Water plants' })).not.toBeInTheDocument()
  })

  describe('deleting the completed tasks', () => {
    const home = calendar({ id: 'e', name: 'Home' })

    it('deletes every completed task of the list after asking', async () => {
      const fetch = serve([home])
      const user = userEvent.setup()
      renderWithProviders(<TasksPanel onClose={() => undefined} />)
      await screen.findByRole('checkbox', { name: 'Completed: Pay rent' })
      await user.click(screen.getByRole('button', { name: 'Delete all completed tasks' }))
      const ask = screen.getByRole('alertdialog', { name: 'Delete all 2 completed tasks?' })
      expect(within(ask).getByRole('button', { name: 'Cancel' })).toHaveFocus()

      await user.click(within(ask).getByRole('button', { name: 'Delete all' }))
      await waitFor(() => {
        expect(screen.queryByRole('checkbox', { name: 'Completed: Pay rent' })).not.toBeInTheDocument()
      })
      const deletes = fetch.mock.calls
        .filter(([, init]) => init?.method === 'DELETE')
        .map(([url, init]) => [urlOf(url), (init?.headers as Record<string, string>)['If-Match']])
      expect(deletes).toEqual([
        ['/api/v1/todos/plumber', '"9"'],
        ['/api/v1/todos/rent', '"4"'],
      ])
      expect(screen.getByRole('checkbox', { name: 'Completed: Copy keys' })).toBeInTheDocument()
    })

    it('is offered while the completed tasks are folded away', async () => {
      useSettings.setState({ hideCompletedTasks: true })
      serve([home])
      renderWithProviders(<TasksPanel onClose={() => undefined} />)
      await screen.findByRole('checkbox', { name: 'Completed: Copy keys' })
      expect(screen.getByRole('button', { name: 'Delete all completed tasks' })).toBeInTheDocument()
    })

    it('is not offered in a read-only list', async () => {
      serve([calendar({ id: 'e', name: 'Home', readOnly: true })])
      renderWithProviders(<TasksPanel onClose={() => undefined} />)
      await screen.findByRole('checkbox', { name: 'Completed: Pay rent' })
      expect(screen.queryByRole('button', { name: 'Delete all completed tasks' })).not.toBeInTheDocument()
    })
  })

  it('says when all tasks are done', async () => {
    serve([calendar({ id: 'd', name: 'Home' })])
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    expect(await screen.findByText('All tasks are done.')).toBeInTheDocument()
    expect(screen.getByText('0 open')).toBeInTheDocument()
  })

  it('says when a list is read-only', async () => {
    serve([calendar({ id: 'a', name: 'Personal', readOnly: true })])
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    await screen.findByRole('checkbox', { name: 'Completed: Buy milk' })
    expect(screen.getByText('Read-only')).toBeInTheDocument()
  })

  it('shows no dropdown for a single list', async () => {
    serve([personal])
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    await screen.findByRole('checkbox', { name: 'Completed: Buy milk' })
    expect(screen.queryByRole('combobox', { name: 'Task list' })).not.toBeInTheDocument()
  })
})
