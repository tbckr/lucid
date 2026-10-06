import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type ScopeItem } from '@/lib/scope'
import { renderWithProviders } from '@/test/render'
import { ScopeChoice } from './ScopeChoice'

const question = 'This event repeats. Which events should move?'
const items: ScopeItem[] = [
  { scope: 'this', label: 'Only this event', note: 'Only Mon, Mar 17.' },
  { scope: 'all', label: 'All events', note: 'Past ones too.' },
]

function setup(props: Partial<ComponentProps<typeof ScopeChoice>> = {}) {
  const onChoose = vi.fn()
  const onCancel = vi.fn()
  const onPreview = vi.fn()
  renderWithProviders(
    <ScopeChoice
      question={question}
      items={items}
      color="#3b82f6"
      onChoose={onChoose}
      onCancel={onCancel}
      onPreview={onPreview}
      {...props}
    />,
  )
  return { onChoose, onCancel, onPreview }
}

describe('ScopeChoice', () => {
  it('lists the options in order, each with its note', () => {
    setup()
    const [only, all, cancel] = screen.getAllByRole('button')
    expect(only).toHaveAccessibleName('Only this event')
    expect(only).toHaveAccessibleDescription('Only Mon, Mar 17.')
    expect(all).toHaveAccessibleName('All events')
    expect(all).toHaveAccessibleDescription('Past ones too.')
    expect(cancel).toHaveAccessibleName('Cancel')
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('draws the reach of each option in the series color', () => {
    setup()
    const [only, all] = screen.getAllByRole('button')
    const filled = (row: HTMLElement | undefined) =>
      Array.from(row!.querySelectorAll('circle')).map((c) => c.getAttribute('fill'))
    expect(filled(only)).toEqual(['none', 'none', '#3b82f6', 'none', 'none'])
    expect(filled(all)).toEqual(Array(5).fill('#3b82f6'))
  })

  it('draws the dots of a delete in red', () => {
    setup({ tone: 'destructive' })
    const all = screen.getByRole('button', { name: 'All events' })
    expect(Array.from(all.querySelectorAll('circle')).map((c) => c.getAttribute('fill'))).toEqual(
      Array(5).fill('var(--destructive)'),
    )
  })

  it('focuses the smallest change', async () => {
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

  it('cancels with Escape', async () => {
    const user = userEvent.setup()
    const { onCancel } = setup()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('cancels with Cancel', async () => {
    const user = userEvent.setup()
    const { onCancel, onChoose } = setup()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('chooses', async () => {
    const user = userEvent.setup()
    const { onChoose } = setup()
    await user.click(screen.getByRole('button', { name: 'All events' }))
    expect(onChoose).toHaveBeenLastCalledWith('all')
    await user.click(screen.getByRole('button', { name: 'Only this event' }))
    expect(onChoose).toHaveBeenLastCalledWith('this')
    expect(onChoose).toHaveBeenCalledTimes(2)
  })

  it('reports the option in focus or under the pointer', async () => {
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
    const dialog = screen.getByRole('alertdialog', { name: question })
    expect(within(dialog).getAllByRole('button')).toHaveLength(3)
  })

  // Inside the editor's <form>, a plain <button> would submit it too.
  it('submits no form around it', () => {
    setup()
    for (const button of screen.getAllByRole('button')) expect(button).toHaveAttribute('type', 'button')
  })
})
