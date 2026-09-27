import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { jsonResponse } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { AppVersion } from './AppVersion'

function serveSession(session: object) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { authenticated: false, csrfToken: 't', ...session }))
}

describe('AppVersion', () => {
  it('shows the server version and links to the repository in a new tab', async () => {
    serveSession({ version: '1.2.3' })
    renderWithProviders(<AppVersion />)
    expect(await screen.findByText('Lucid 1.2.3')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /GitHub/ })
    expect(link).toHaveAttribute('href', 'https://github.com/tbckr/lucid')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAccessibleName('GitHub (source code, opens in a new tab)')
  })

  it('shows only the link when the server reports no version', async () => {
    serveSession({})
    const { queryClient } = renderWithProviders(<AppVersion />)
    await waitFor(() => {
      expect(queryClient.getQueryState(queryKeys.session)?.status).toBe('success')
    })
    expect(screen.getByRole('link', { name: /GitHub/ })).toBeInTheDocument()
    expect(screen.queryByText(/Lucid/)).not.toBeInTheDocument()
  })
})
