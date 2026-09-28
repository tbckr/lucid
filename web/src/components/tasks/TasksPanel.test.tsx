import { screen, waitFor } from '@testing-library/react'
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
const tasksOf: Record<string, Todo[]> = {
  a: [
    todo({ id: 'milk', calendarId: 'a', title: 'Buy milk' }),
    todo({ id: 'bread', calendarId: 'a', title: 'Buy bread' }),
    todo({ id: 'plants', calendarId: 'a', title: 'Water plants', status: 'COMPLETED' }),
  ],
  b: [todo({ id: 'taxes', calendarId: 'b', title: 'File taxes' })],
}

/** Serves the calendars and their tasks; returns the fetch spy. */
function serve(calendars: Calendar[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = urlOf(input)
    if (url.endsWith('/calendars')) return Promise.resolve(jsonResponse(200, { calendars }))
    const id = /\/calendars\/(\w+)\/todos$/.exec(url)?.[1] ?? ''
    if (init?.method === 'POST') {
      return Promise.resolve(jsonResponse(201, todo({ id: 'new', calendarId: id, title: 'New' })))
    }
    return Promise.resolve(jsonResponse(200, { todos: tasksOf[id] ?? [], corrupted: [] }))
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

  it('shows no dropdown for a single list', async () => {
    serve([personal])
    renderWithProviders(<TasksPanel onClose={() => undefined} />)
    await screen.findByRole('checkbox', { name: 'Completed: Buy milk' })
    expect(screen.queryByRole('combobox', { name: 'Task list' })).not.toBeInTheDocument()
  })
})
