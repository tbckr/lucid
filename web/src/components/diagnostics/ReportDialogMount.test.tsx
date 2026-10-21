import { act, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUi } from '@/stores/ui'
import { renderWithProviders } from '@/test/render'
import { ReportDialogMount } from './ReportDialogMount'

/** Whether the dialog's chunk fails to load, as after an upgrade removed it or with the network down. */
const chunk = vi.hoisted(() => ({ fails: true, imports: 0 }))

vi.mock('./ReportDialog', () => {
  chunk.imports++
  if (chunk.fails) throw new Error('Failed to fetch dynamically imported module')
  return { ReportDialog: () => <p>The report</p> }
})

afterEach(() => {
  useUi.setState({ report: { open: false, candidates: [] } })
  toast.dismiss()
})

describe('ReportDialogMount', () => {
  it('says so when the dialog fails to load, closes the report and tries again at the next opening', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderWithProviders(
      <>
        <p>The app</p>
        <ReportDialogMount />
      </>,
    )

    act(() => {
      useUi.getState().openReport()
    })

    await waitFor(() => {
      expect(toast.getToasts().some((x) => x.id === 'report-failed')).toBe(true)
    })
    const shown = toast.getToasts().find((x) => x.id === 'report-failed')
    expect(shown && 'title' in shown ? shown.title : null).toBe(
      "Lucid couldn't open the problem report. Reload the page and try again.",
    )
    // The app goes on, and no dialog is left open that would hold back its shortcuts.
    expect(screen.getByText('The app')).toBeInTheDocument()
    expect(useUi.getState().report.open).toBe(false)
    expect(consoleError).toHaveBeenCalled()

    chunk.fails = false
    act(() => {
      useUi.getState().openReport()
    })
    expect(await screen.findByText('The report')).toBeInTheDocument()
    expect(chunk.imports).toBe(2)
  })
})
