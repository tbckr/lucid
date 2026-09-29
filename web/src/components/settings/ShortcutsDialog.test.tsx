import { act, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useUi } from '@/stores/ui'
import { ShortcutsDialog } from './ShortcutsDialog'

describe('ShortcutsDialog', () => {
  afterEach(() => {
    act(() => {
      useUi.getState().setShortcutsOpen(false)
    })
  })

  it('tells keys that do the same from keys pressed one after the other', () => {
    render(<ShortcutsDialog />)
    act(() => {
      useUi.getState().setShortcutsOpen(true)
    })
    const keys = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement
    expect(within(keys('Next period')).getByText('or')).toBeInTheDocument()
    expect(within(keys('Move a focused event')).getByText('then')).toBeInTheDocument()
    expect(within(keys('Move a focused event')).queryByText('or')).toBeNull()
  })
})
