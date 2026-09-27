import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api/client'
import { jsonResponse, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { LoginPage } from './LoginPage'

afterEach(() => {
  api.setCsrfToken(null)
  window.history.replaceState(null, '', '/')
})

async function fill(user: ReturnType<typeof userEvent.setup>, server: string, name: string, pass: string) {
  if (server) await user.type(screen.getByLabelText('Server address'), server)
  if (name) await user.type(screen.getByLabelText('Username'), name)
  if (pass) await user.type(screen.getByLabelText('Password'), pass)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('LoginPage', () => {
  it('validates fields before calling the API', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(jsonResponse(200, { authenticated: false, csrfToken: 't' })))
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)
    await fill(user, 'not a url', '', '')
    expect(await screen.findByText(/Enter a valid address/)).toBeInTheDocument()
    expect(screen.getByText('Enter your username.')).toBeInTheDocument()
    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
    expect(screen.getByLabelText('Server address')).toHaveAttribute('aria-invalid', 'true')
    expect(fetch.mock.calls.filter(([u]) => urlOf(u).endsWith('/auth/login'))).toHaveLength(0)
  })

  it('shows the server version', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { authenticated: false, csrfToken: 't', version: '1.2.3' })),
    )
    renderWithProviders(<LoginPage />)
    expect(await screen.findByText('Lucid 1.2.3')).toBeInTheDocument()
  })

  it('shows the API error for rejected credentials and clears the password', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = urlOf(input)
      if (url.endsWith('/session')) return Promise.resolve(jsonResponse(200, { authenticated: false, csrfToken: 't' }))
      return Promise.resolve(jsonResponse(401, { error: { code: 'invalid_credentials', message: 'no' } }))
    })
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)
    await fill(user, 'example.com', 'tim', 'wrong')
    expect(await screen.findByRole('alert')).toHaveTextContent('The server rejected this username or password.')
    expect(screen.getByLabelText('Password')).toHaveValue('')
  })

  it('logs in with the CSRF token and follows a safe redirect only', async () => {
    window.history.replaceState(null, '', '/login?redirect=%2F%2Fevil.example')
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = urlOf(input)
      if (url.endsWith('/session')) return Promise.resolve(jsonResponse(200, { authenticated: false, csrfToken: 'anon' }))
      return Promise.resolve(jsonResponse(200, { authenticated: true, username: 'tim', csrfToken: 'rotated' }))
    })
    const user = userEvent.setup()
    const { queryClient } = renderWithProviders(<LoginPage />)
    await fill(user, 'https://dav.example.com', 'tim', 'pw')
    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })
    const login = fetch.mock.calls.find(([u]) => urlOf(u).endsWith('/auth/login'))
    expect((login?.[1]?.headers as Record<string, string>)['X-CSRF-Token']).toBe('anon')
    expect(api.token).toBe('rotated')
    expect(queryClient.getQueryData(['session'])).toMatchObject({ authenticated: true })
  })

  it('follows a valid redirect', async () => {
    window.history.replaceState(null, '', '/login?redirect=%2Fweek%3Fx%3D1')
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).endsWith('/session')
          ? jsonResponse(200, { authenticated: false, csrfToken: 'anon' })
          : jsonResponse(200, { authenticated: true, csrfToken: 'r' }),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)
    await fill(user, 'example.com', 'tim', 'pw')
    await waitFor(() => {
      expect(window.location.pathname + window.location.search).toBe('/week?x=1')
    })
  })
})
