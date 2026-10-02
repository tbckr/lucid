import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { ScopeChoice } from './ScopeChoice'

const question = 'This event repeats. Which events should move?'
const note = '“All events” includes past ones.'

function setup(props: Partial<ComponentProps<typeof ScopeChoice>> = {}) {
  const onChoose = vi.fn()
  const onCancel = vi.fn()
  const onPreview = vi.fn()
  renderWithProviders(
    <ScopeChoice
      question={question}
      note={note}
      allowAll
      onChoose={onChoose}
      onCancel={onCancel}
      onPreview={onPreview}
      {...props}
    />,
  )
  return { onChoose, onCancel, onPreview }
}

describe('ScopeChoice', () => {
  it('focuses Only this event by default', async () => {
    setup()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Only this event' })).toHaveFocus()
    })
  })

  it('focuses Cancel when deleting', async () => {
    setup({ tone: 'destructive' })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    })
  })

  it('orders Cancel, All events, Only this event', () => {
    setup()
    const names = screen.getAllByRole('button').map((b) => b.textContent)
    expect(names).toEqual(['Cancel', 'All events', 'Only this event'])
  })

  it('cancels with Escape', async () => {
    const user = userEvent.setup()
    const { onCancel } = setup()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('chooses this or all', async () => {
    const user = userEvent.setup()
    const { onChoose } = setup()
    await user.click(screen.getByRole('button', { name: 'All events' }))
    expect(onChoose).toHaveBeenCalledWith('all')
    await user.click(screen.getByRole('button', { name: 'Only this event' }))
    expect(onChoose).toHaveBeenCalledWith('this')
  })

  it("leaves out All events and says why when the series can't follow", () => {
    setup({ allowAll: false })
    expect(screen.queryByRole('button', { name: 'All events' })).toBeNull()
    expect(
      screen.getByText('The series stays on its days. Only this event can move to another day.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(note)).toBeNull()
  })

  it('reports the choice in focus or under the pointer', async () => {
    const user = userEvent.setup()
    const { onPreview } = setup()
    const all = screen.getByRole('button', { name: 'All events' })

    await user.hover(all)
    expect(onPreview).toHaveBeenLastCalledWith('all')
    await user.unhover(all)
    expect(onPreview).toHaveBeenLastCalledWith(null)

    onPreview.mockClear()
    all.focus()
    expect(onPreview).toHaveBeenLastCalledWith('all')
    all.blur()
    expect(onPreview).toHaveBeenLastCalledWith(null)
  })

  it('is an alert dialog named by its question', () => {
    setup()
    expect(screen.getByRole('alertdialog', { name: question })).toBeInTheDocument()
  })
})
