import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api/client'
import { useSettings } from '@/stores/settings'
import { emptyReport, useUi } from '@/stores/ui'
import { jsonResponse, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { LoginPage } from './LoginPage'

afterEach(() => {
  api.setCsrfToken(null)
  window.history.replaceState(null, '', '/')
  useUi.setState({ report: emptyReport, signedOut: false })
  // A sign-in remembers its server, which the next test's form would start with.
  useSettings.setState({ lastServerUrl: '' })
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

  it('shows the reference of a failed login', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = urlOf(input)
      if (url.endsWith('/session')) return Promise.resolve(jsonResponse(200, { authenticated: false, csrfToken: 't' }))
      return Promise.resolve(
        jsonResponse(502, { error: { code: 'discovery_failed', message: 'no' } }, { 'X-Request-Id': '0123456789abcdef' }),
      )
    })
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)
    await fill(user, 'example.com', 'tim', 'pw')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No calendar service was found at this address.')
    expect(alert).toHaveTextContent('Reference: 01234567')
  })

  it('opens the problem report from the alert of an error with a reference (FR-36)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = urlOf(input)
      if (url.endsWith('/session')) return Promise.resolve(jsonResponse(200, { authenticated: false, csrfToken: 't' }))
      return Promise.resolve(
        jsonResponse(502, { error: { code: 'discovery_failed', message: 'no' } }, { 'X-Request-Id': '0123456789abcdef' }),
      )
    })
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)
    expect(screen.queryByRole('button', { name: 'Report a problem' })).toBeNull()
    await fill(user, 'example.com', 'tim', 'pw')
    const alert = await screen.findByRole('alert')
    const link = within(alert).getByRole('button', { name: 'Report a problem' })
    expect(link.querySelector('svg.lucide-life-buoy')).not.toBeNull()
    await user.click(link)
    expect(useUi.getState().report.open).toBe(true)
  })

  it('shows no reference for an error that is not a server problem', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = urlOf(input)
      if (url.endsWith('/session')) return Promise.resolve(jsonResponse(200, { authenticated: false, csrfToken: 't' }))
      return Promise.resolve(
        jsonResponse(429, { error: { code: 'rate_limited', message: 'no' } }, { 'X-Request-Id': '0123456789abcdef' }),
      )
    })
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)
    await fill(user, 'example.com', 'tim', 'pw')
    const alert = await screen.findByRole('alert')
    expect(alert).not.toHaveTextContent('Reference')
    expect(within(alert).queryByRole('button', { name: 'Report a problem' })).toBeNull()
  })

  it('shows the reference of a rejected login, and drops it with the next error', async () => {
    let status = 401
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = urlOf(input)
      if (url.endsWith('/session')) return Promise.resolve(jsonResponse(200, { authenticated: false, csrfToken: 't' }))
      return Promise.resolve(
        status === 401
          ? jsonResponse(401, { error: { code: 'invalid_credentials', message: 'no' } }, { 'X-Request-Id': 'fedcba9876543210' })
          : jsonResponse(429, { error: { code: 'rate_limited', message: 'no' } }),
      )
    })
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)
    await fill(user, 'example.com', 'tim', 'wrong')
    expect(await screen.findByRole('alert')).toHaveTextContent('Reference: fedcba98')

    status = 429
    await user.type(screen.getByLabelText('Password'), 'again')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Too many attempts')
    })
    expect(screen.getByRole('alert')).not.toHaveTextContent('Reference')
  })

  it('says that a session ended unasked and offers the problem report (FR-36)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { authenticated: false, csrfToken: 't' })),
    )
    useUi.setState({ signedOut: true })
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)

    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent('You were signed out. If that was unexpected, you can report the problem.')
    // A notice, not an error: no alert, and the icon of information.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(notice.querySelector('svg.lucide-info')).not.toBeNull()
    const link = within(notice).getByRole('button', { name: 'Report a problem' })
    expect(link.querySelector('svg.lucide-life-buoy')).not.toBeNull()
    await user.click(link)
    expect(useUi.getState().report.open).toBe(true)
  })

  it('says nothing of a sign-out the user chose', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { authenticated: false, csrfToken: 't' })),
    )
    renderWithProviders(<LoginPage />)
    expect(screen.queryByText(/You were signed out/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Report a problem' })).toBeNull()
  })

  it('forgets that the session ended once the user signs in again', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).endsWith('/session')
          ? jsonResponse(200, { authenticated: false, csrfToken: 'anon' })
          : jsonResponse(200, { authenticated: true, csrfToken: 'r' }),
      ),
    )
    window.history.replaceState(null, '', '/login')
    useUi.setState({ signedOut: true })
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)
    await fill(user, 'example.com', 'tim', 'pw')
    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })
    expect(useUi.getState().signedOut).toBe(false)
  })

  it('keeps the notice when the sign-in fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = urlOf(input)
      if (url.endsWith('/session')) return Promise.resolve(jsonResponse(200, { authenticated: false, csrfToken: 't' }))
      return Promise.resolve(jsonResponse(401, { error: { code: 'invalid_credentials', message: 'no' } }))
    })
    useUi.setState({ signedOut: true })
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)
    await fill(user, 'example.com', 'tim', 'wrong')
    expect(await screen.findByRole('alert')).toHaveTextContent('The server rejected this username or password.')
    expect(screen.getByRole('status')).toHaveTextContent('You were signed out.')
    expect(useUi.getState().signedOut).toBe(true)
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
