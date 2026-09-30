import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys, useCachedTodo } from '@/hooks/queries'
import { api } from '@/lib/api/client'
import { type Todo } from '@/lib/api/schemas'
import { defaultSettings, useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { bodyOf, calendar, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { PriorityChip, TaskRow } from './TaskRow'

/** Answers each PUT with the task as sent and the next ETag; returns the fetch spy. */
function serve(t: Todo) {
  api.setCsrfToken('tok')
  let etag = Number(JSON.parse(t.etag))
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    etag += 1
    return Promise.resolve(jsonResponse(200, { ...t, ...bodyOf(init), etag: `"${etag}"` }))
  })
}

/** The row as the task list shows it: the task as the cache holds it. */
function Cached({ todo: t }: { todo: Todo }) {
  return <TaskRow todo={useCachedTodo(t)} calendar={calendar()} />
}

describe('TaskRow', () => {
  afterEach(() => {
    useSettings.setState(defaultSettings)
    useUi.getState().openTaskEditor(null)
  })

  describe('title', () => {
    const t = todo({ id: 'x', title: 'Oat milk', etag: '"5"' })

    it('saves a new title on Enter and keeps the focus', async () => {
      const fetch = serve(t)
      const user = userEvent.setup()
      renderWithProviders(<TaskRow todo={t} calendar={calendar()} />)
      const field = screen.getByRole('textbox', { name: 'Title' })
      expect(field).toHaveValue('Oat milk')
      await user.click(field)
      await user.type(field, ', 2 l{Enter}')
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      const [url, init] = fetch.mock.calls[0]!
      expect(urlOf(url)).toBe('/api/v1/todos/x')
      expect((init?.headers as Record<string, string>)['If-Match']).toBe('"5"')
      expect(bodyOf(init)).toMatchObject({ title: 'Oat milk, 2 l' })
      expect(field).toHaveValue('Oat milk, 2 l')
      expect(field).toHaveFocus()
    })

    it('saves a new title when the field is left', async () => {
      const fetch = serve(t)
      const user = userEvent.setup()
      renderWithProviders(<TaskRow todo={t} calendar={calendar()} />)
      await user.type(screen.getByRole('textbox', { name: 'Title' }), '!')
      await user.tab()
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      expect(bodyOf(fetch.mock.calls[0]![1])).toMatchObject({ title: 'Oat milk!' })
    })

    it('restores the title on Escape without saving', async () => {
      const fetch = serve(t)
      const user = userEvent.setup()
      renderWithProviders(<TaskRow todo={t} calendar={calendar()} />)
      const field = screen.getByRole('textbox', { name: 'Title' })
      await user.type(field, '!{Escape}')
      expect(field).toHaveValue('Oat milk')
      await user.tab()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('restores the title when it is left empty', async () => {
      const fetch = serve(t)
      const user = userEvent.setup()
      renderWithProviders(<TaskRow todo={t} calendar={calendar()} />)
      const field = screen.getByRole('textbox', { name: 'Title' })
      await user.clear(field)
      await user.tab()
      expect(field).toHaveValue('Oat milk')
      expect(fetch).not.toHaveBeenCalled()
    })

    it('turns pasted line breaks into spaces', async () => {
      serve(t)
      const user = userEvent.setup()
      renderWithProviders(<TaskRow todo={t} calendar={calendar()} />)
      const field = screen.getByRole('textbox', { name: 'Title' })
      await user.clear(field)
      await user.paste('Oat milk\n2 l')
      expect(field).toHaveValue('Oat milk 2 l')
    })

    it('is text in a read-only list, and opens the editor', async () => {
      const user = userEvent.setup()
      renderWithProviders(<TaskRow todo={t} calendar={calendar({ readOnly: true })} />)
      expect(screen.queryByRole('textbox')).toBeNull()
      await user.click(screen.getByRole('button', { name: /Oat milk/ }))
      expect(useUi.getState().taskEditor).toEqual({ mode: 'edit', todo: t })
    })
  })

  describe('delete', () => {
    const done = todo({ id: 'x', title: 'Oat milk', etag: '"5"', status: 'COMPLETED' })

    /** Answers each DELETE; returns the fetch spy. */
    function serveDelete() {
      api.setCsrfToken('tok')
      return vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })))
    }

    it('deletes a completed task after asking', async () => {
      const fetch = serveDelete()
      const user = userEvent.setup()
      renderWithProviders(<TaskRow todo={done} calendar={calendar()} />)
      // In place of the due date, which a done task no longer needs.
      expect(screen.queryByRole('button', { name: 'Change due date: Oat milk' })).toBeNull()
      await user.click(screen.getByRole('button', { name: 'Delete task: Oat milk' }))
      const ask = screen.getByRole('alertdialog', { name: 'Delete this task?' })
      expect(within(ask).getByRole('button', { name: 'Cancel' })).toHaveFocus()
      expect(fetch).not.toHaveBeenCalled()

      await user.click(within(ask).getByRole('button', { name: 'Delete task' }))
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1)
      })
      const [url, init] = fetch.mock.calls[0]!
      expect(urlOf(url)).toBe('/api/v1/todos/x')
      expect(init?.method).toBe('DELETE')
      expect((init?.headers as Record<string, string>)['If-Match']).toBe('"5"')
    })

    it('keeps the task when the question is cancelled', async () => {
      const fetch = serveDelete()
      const user = userEvent.setup()
      renderWithProviders(<TaskRow todo={done} calendar={calendar()} />)
      const trash = screen.getByRole('button', { name: 'Delete task: Oat milk' })
      await user.click(trash)
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(trash).toHaveFocus()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('is not offered for an open task', () => {
      renderWithProviders(<TaskRow todo={todo({ title: 'Oat milk' })} calendar={calendar()} />)
      expect(screen.queryByRole('button', { name: 'Delete task: Oat milk' })).toBeNull()
    })

    it('is not offered in a read-only list', () => {
      renderWithProviders(<TaskRow todo={done} calendar={calendar({ readOnly: true })} />)
      expect(screen.queryByRole('button', { name: 'Delete task: Oat milk' })).toBeNull()
    })
  })

  it('opens the editor from its button', async () => {
    const t = todo({ title: 'Oat milk' })
    const user = userEvent.setup()
    renderWithProviders(<TaskRow todo={t} calendar={calendar()} />)
    await user.click(screen.getByRole('button', { name: 'Edit task: Oat milk' }))
    expect(useUi.getState().taskEditor).toEqual({ mode: 'edit', todo: t })
  })

  it('moves the due date from its picker', async () => {
    const t = todo({ title: 'Oat milk', due: '2020-01-10T00:00:00Z', dueAllDay: true })
    const fetch = serve(t)
    const user = userEvent.setup()
    renderWithProviders(<TaskRow todo={t} calendar={calendar()} />)
    await user.click(screen.getByRole('button', { name: 'Change due date: Oat milk' }))
    await user.click(screen.getByRole('button', { name: /^Tomorrow / }))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    expect(bodyOf(fetch.mock.calls[0]![1])).toMatchObject({ title: 'Oat milk', dueAllDay: true })
  })

  it('completes a task right after renaming it, with the ETag the rename got', async () => {
    api.setCsrfToken('tok')
    const answers: ((r: Response) => void)[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve)
        }),
    )
    const t = todo({ id: 'x', calendarId: 'c1', title: 'Oat milk', etag: '"5"' })
    const user = userEvent.setup()
    const { queryClient } = renderWithProviders(<Cached todo={t} />)
    act(() => {
      queryClient.setQueryData(queryKeys.todos('c1'), { todos: [t], corrupted: [] })
    })

    await user.type(screen.getByRole('textbox', { name: 'Title' }), ', 2 l')
    await user.tab()
    // Checked while the rename is still on its way.
    await user.click(await screen.findByRole('checkbox', { name: 'Completed: Oat milk, 2 l' }))
    expect(answers).toHaveLength(1)
    answers[0]?.(jsonResponse(200, { ...t, title: 'Oat milk, 2 l', etag: '"6"' }))

    await waitFor(() => {
      expect(answers).toHaveLength(2)
    })
    const [, init] = fetch.mock.calls[1]!
    expect((init?.headers as Record<string, string>)['If-Match']).toBe('"6"')
    expect(bodyOf(init)).toMatchObject({ title: 'Oat milk, 2 l', status: 'COMPLETED' })
    answers[1]?.(jsonResponse(200, { ...t, title: 'Oat milk, 2 l', status: 'COMPLETED', etag: '"7"' }))
  })

  it('toggles completion optimistically and sends If-Match', async () => {
    api.setCsrfToken('tok')
    let resolve: (r: Response) => void = () => undefined
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolve = r
        }),
    )
    const t = todo({ id: 'x', title: 'Oat milk', etag: '"5"' })
    const user = userEvent.setup()
    renderWithProviders(<TaskRow todo={t} calendar={calendar()} />)
    const box = screen.getByRole('checkbox', { name: /Oat milk/ })
    expect(box).toHaveAttribute('aria-checked', 'false')
    await user.click(box)
    // Optimistic: checked before the server answered.
    await waitFor(() => {
      expect(box).toHaveAttribute('aria-checked', 'true')
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(urlOf(url)).toBe('/api/v1/todos/x')
    expect((init?.headers as Record<string, string>)['If-Match']).toBe('"5"')
    expect(bodyOf(init).status).toBe('COMPLETED')
    resolve(jsonResponse(200, { ...t, status: 'COMPLETED', etag: '"6"' }))
  })

  it('shows due date, priority and checklist progress', () => {
    renderWithProviders(
      <TaskRow
        todo={todo({ priority: 1, checklist: [{ text: 'a', done: true }, { text: 'b', done: false }] })}
        calendar={calendar({ readOnly: true })}
      />,
    )
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByLabelText('1 of 2 checklist items done')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })

  it('shows only the time when a heading names the day', () => {
    useSettings.setState({ timeFormat: '24h' })
    renderWithProviders(<TaskRow todo={todo({ due: '2026-09-25T15:30:00Z' })} calendar={calendar()} timeOnly />)
    expect(screen.getByText('17:30')).toBeInTheDocument()
  })

  it('renders nothing for no priority', () => {
    const { container } = renderWithProviders(<PriorityChip priority={0} />)
    expect(container).toBeEmptyDOMElement()
  })

  describe('recurring series (FR-17)', () => {
    it('names its rule in the meta line', () => {
      renderWithProviders(
        <TaskRow
          todo={todo({ title: 'Water the flowers', rrule: 'FREQ=WEEKLY;BYDAY=MO,TH', recurring: true, due: '2026-10-08T00:00:00Z', dueAllDay: true })}
          calendar={calendar()}
        />,
      )
      expect(screen.getByRole('img', { name: 'Every week on Monday and Thursday' })).toBeInTheDocument()
    })

    it('disables the checkbox for a rule Lucid cannot read', () => {
      renderWithProviders(
        <TaskRow
          todo={todo({ title: 'Water the flowers', rrule: 'FREQ=SOMETIMES', recurring: true, ruleUnsupported: true })}
          calendar={calendar()}
        />,
      )
      expect(screen.getByRole('checkbox', { name: /Water the flowers/ })).toBeDisabled()
    })
  })
})
