import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api/client'
import { bodyOf, calendar, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { PriorityChip, TaskRow } from './TaskRow'

describe('TaskRow', () => {
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

  it('renders nothing for no priority', () => {
    const { container } = renderWithProviders(<PriorityChip priority={0} />)
    expect(container).toBeEmptyDOMElement()
  })
})
