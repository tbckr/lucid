import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type MouseEvent } from 'react'
import { toast, type Action } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyReport, useUi, type ReportCandidate } from '@/stores/ui'
import { renderWithProviders } from '@/test/render'
import { ReportTray } from './ReportTray'

const dentist: ReportCandidate = { objectId: 'ev-1', kind: 'event', label: 'Dentist', calendarId: 'c1' }
const rent: ReportCandidate = { objectId: 'td-1', kind: 'todo', label: 'Pay rent', calendarId: 'c1' }

afterEach(() => {
  useUi.setState({ report: emptyReport })
  toast.dismiss()
})

function tray(): HTMLElement | null {
  return screen.queryByRole('region', { name: 'Problem report' })
}

/** The report waits with `candidates`, newest last, as the user added them. */
function waitWith(...candidates: ReportCandidate[]) {
  act(() => {
    for (const c of candidates) useUi.getState().openReport(c)
    useUi.getState().closeReport()
  })
}

/** Click Undo in the toast that says the report was discarded. */
function undo() {
  const shown = toast.getToasts().find((x) => x.id === 'report-discarded')
  expect(shown && 'title' in shown ? shown.title : null).toBe('Problem report discarded')
  const action = shown && 'action' in shown ? (shown.action as Action | undefined) : undefined
  expect(action?.label).toBe('Undo')
  act(() => {
    action?.onClick({} as MouseEvent<HTMLButtonElement>)
  })
}

describe('ReportTray (FR-36)', () => {
  it('shows nothing while no report waits', () => {
    renderWithProviders(<ReportTray />)
    expect(tray()).toBeNull()

    // An open report is the dialog, not the tray.
    act(() => {
      useUi.getState().openReport(dentist)
    })
    expect(tray()).toBeNull()
  })

  it('shows the report that waits, with its items and how to add one, and opens it', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ReportTray />)
    waitWith(dentist, rent)

    const region = tray()!
    expect(within(region).getByText('Pay rent, Dentist')).toBeInTheDocument()
    expect(region).toHaveTextContent('To add an item, open an event or task and choose Add to problem report.')

    await user.click(within(region).getByRole('button', { name: 'Open report' }))
    expect(useUi.getState().report.open).toBe(true)
    expect(tray()).toBeNull()
  })

  it('says so when the report waits for its first item', () => {
    renderWithProviders(<ReportTray />)
    act(() => {
      useUi.getState().openReport()
      useUi.getState().parkReport()
    })
    expect(within(tray()!).getByText('No items yet')).toBeInTheDocument()
  })

  it('discards the report, and undoes that', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ReportTray />)
    waitWith(dentist)
    act(() => {
      useUi.getState().showReportContent('ev-1', { status: 'shown', text: 'BEGIN:VCALENDAR' })
      useUi.getState().includeReportContent('ev-1', true)
    })
    const before = useUi.getState().report

    await user.click(within(tray()!).getByRole('button', { name: 'Discard report' }))
    expect(tray()).toBeNull()
    expect(useUi.getState().report).toEqual(emptyReport)

    undo()
    expect(useUi.getState().report).toEqual(before)
    expect(tray()).not.toBeNull()
  })

  it('undoes nothing once the report changed after the discard', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ReportTray />)
    waitWith(dentist)
    await user.click(within(tray()!).getByRole('button', { name: 'Discard report' }))
    waitWith(rent)

    undo()
    expect(useUi.getState().report.candidates).toEqual([rent])
  })

  it('moves the focus to the account menu once discarded', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <button type="button" data-account-menu="">
          Account
        </button>
        <ReportTray />
      </>,
    )
    waitWith(dentist)
    await user.click(within(tray()!).getByRole('button', { name: 'Discard report' }))
    expect(screen.getByRole('button', { name: 'Account' })).toHaveFocus()
  })

  it('tells the toasts the room it takes while it is shown and under them, so they stay above it', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120)
    // Bottom-left, 20rem wide, as on a screen of 1024px: a centred toast of 356px starts at 334px, over the tray.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, 600, 320, 120))
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024)
    const root = document.documentElement
    renderWithProviders(<ReportTray />)
    expect(root.style.getPropertyValue('--report-tray-space')).toBe('')

    // Its height and a gap of 12px.
    waitWith(dentist)
    expect(root.style.getPropertyValue('--report-tray-space')).toBe('132px')

    act(() => {
      useUi.getState().openReport()
    })
    expect(root.style.getPropertyValue('--report-tray-space')).toBe('')
  })

  it('leaves the toasts where they are on a screen wide enough for both', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, 600, 320, 120))
    let width = 1280
    vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width)
    const root = document.documentElement
    renderWithProviders(<ReportTray />)
    waitWith(dentist)
    expect(root.style.getPropertyValue('--report-tray-space')).toBe('')

    // Narrowed until the toasts would cover it.
    width = 1000
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(root.style.getPropertyValue('--report-tray-space')).toBe('132px')
  })
})
