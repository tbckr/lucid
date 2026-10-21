import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { AppErrorBoundary } from './App'

function Boom(): never {
  throw new TypeError('boom')
}

describe('AppErrorBoundary (FR-19)', () => {
  it('shows the crash screen with the error folded below the reload', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderWithProviders(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    )
    expect(screen.getByRole('heading', { name: 'Something broke' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload Lucid' })).toBeInTheDocument()
    expect(screen.getByText('Error details')).toBeInTheDocument()
    expect(screen.getByText(/TypeError: boom/)).not.toBeVisible()
    spy.mockRestore()
  })
})
