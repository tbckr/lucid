import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { glyphSlots, type ScopeItem } from '@/lib/scope'
import { renderWithProviders } from '@/test/render'
import { DetailActions } from './DetailParts'

const items: ScopeItem[] = [
  { scope: 'this', label: 'Only this event', note: 'Only Mon, Mar 17.', slots: glyphSlots('this') },
  { scope: 'all', label: 'All events', note: 'Past ones too.', slots: glyphSlots('all') },
]

function setup(props: Partial<ComponentProps<typeof DetailActions>> = {}) {
  const onDelete = vi.fn()
  const onScopeOpenChange = vi.fn()
  renderWithProviders(
    <DetailActions
      editRef={createRef<HTMLButtonElement>()}
      editLabel="Edit event"
      deleteLabel="Delete event"
      confirm="Delete this event?"
      onEdit={vi.fn()}
      onDelete={onDelete}
      onScopeOpenChange={onScopeOpenChange}
      {...props}
    />,
  )
  return { onDelete, onScopeOpenChange }
}

describe('DetailActions', () => {
  it('asks the plain question without a delete scope', async () => {
    const user = userEvent.setup()
    const { onDelete, onScopeOpenChange } = setup()
    await user.click(screen.getByRole('button', { name: 'Delete event' }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Delete this event?')
    // No scope question is open for Escape to cancel, so the popover keeps closing on Escape (NFR-27).
    expect(onScopeOpenChange).not.toHaveBeenCalledWith(expect.any(Function))

    await user.click(within(alert).getByRole('button', { name: 'Delete event' }))
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it('asks which events to delete with a delete scope, and hands Escape its way to cancel (NFR-27)', async () => {
    const user = userEvent.setup()
    const onChoose = vi.fn()
    const { onDelete, onScopeOpenChange } = setup({ deleteScope: { items, color: '#3b82f6', onChoose } })
    await user.click(screen.getByRole('button', { name: 'Delete event' }))
    const question = screen.getByRole('alertdialog', { name: 'This event repeats. Which events should be deleted?' })
    expect(onScopeOpenChange).toHaveBeenCalledExactlyOnceWith(expect.any(Function))

    await user.click(within(question).getByRole('button', { name: 'All events' }))
    expect(onChoose).toHaveBeenCalledExactlyOnceWith('all')
    expect(onDelete).not.toHaveBeenCalled()
  })
})
