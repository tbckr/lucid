import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { renderWithProviders } from '@/test/render'
import { CrashDetails } from './CrashDetails'

function boom(): Error {
  const error = new TypeError('boom')
  error.stack = `TypeError: boom\n    at Xy (${window.location.origin}/assets/index-abc.js:1:2345)`
  return error
}

/** The crash screen's details as the app shows them, with the session of Lucid 1.2.3 loaded before the crash. */
function mount() {
  return renderWithProviders(<CrashDetails error={boom()} />, (qc) => {
    qc.setQueryData(queryKeys.session, { authenticated: true, csrfToken: 'tok', version: '1.2.3' })
  })
}

describe('CrashDetails (FR-19)', () => {
  it('keeps the details folded until asked, then shows them without the host', async () => {
    const user = userEvent.setup()
    mount()
    const sheet = screen.getByText(/TypeError: boom/)
    expect(sheet).not.toBeVisible()

    await user.click(screen.getByText('Error details'))
    expect(sheet).toBeVisible()
    expect(sheet.textContent).toBe(
      `Lucid 1.2.3\nEurope/Berlin, en-US\n${navigator.userAgent}\n\nTypeError: boom\n    at Xy (/assets/index-abc.js:1:2345)`,
    )
  })

  it('copies what it shows, and says so', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByText('Error details'))
    await user.click(screen.getByRole('button', { name: 'Copy details' }))
    expect(await navigator.clipboard.readText()).toBe(screen.getByText(/TypeError: boom/).textContent)
    expect(screen.getByRole('status')).toHaveTextContent('Copied')
  })

  it('says how to copy by hand when the browser refuses', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    mount()
    await user.click(screen.getByText('Error details'))
    await user.click(screen.getByRole('button', { name: 'Copy details' }))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent("Couldn't copy. Select the text and copy it.")
    })
  })

  it('links to the bug form with the version filled in, in a new tab', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByText('Error details'))
    const link = screen.getByRole('link', { name: 'Open issue form (opens in a new tab)' })
    expect(link).toHaveAttribute('href', 'https://github.com/tbckr/lucid/issues/new?template=bug.yml&lucid-version=1.2.3')
    expect(link).toHaveAttribute('target', '_blank')
  })
})
