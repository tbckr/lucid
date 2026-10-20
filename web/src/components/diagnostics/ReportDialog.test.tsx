import { type QueryClient } from '@tanstack/react-query'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries'
import { diagnosticsReportSchema, type CorruptedItem, type DiagnosticsReport } from '@/lib/api/schemas'
import { assembleReport, issueUrl } from '@/lib/diagnostics'
import { toCalEvent } from '@/lib/events'
import { useUi, type ReportCandidate } from '@/stores/ui'
import { apiEvent, calendar, diagnosticsReport, jsonResponse, urlOf } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { ReportDialogMount } from './ReportDialogMount'

/** The raw text of every object, as `GET .../content` answers: what must not leave without consent (NFR-36). */
const CONTENT = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Therapy\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
/** The skeleton `GET .../objects/{id}` answers for an object the user added. */
const SKELETON = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:<text 7>\nEND:VEVENT\nEND:VCALENDAR\n'

const dentist: ReportCandidate = { objectId: 'ev-1', kind: 'event', label: 'Dentist', calendarId: 'c1' }
const rent: ReportCandidate = { objectId: 'td-1', kind: 'todo', label: 'Pay rent', calendarId: 'c1' }

const failure = () => jsonResponse(502, { error: { code: 'upstream_error', message: 'down' } })

/**
 * The API of the dialog: the report, and each object's skeleton and content. `failContent` and `failSkeleton` fail
 * the first answer of their kind.
 */
function mockApi(
  report: DiagnosticsReport = diagnosticsReport(),
  opts: { failContent?: boolean; failSkeleton?: boolean } = {},
) {
  let failContent = opts.failContent ?? false
  let failSkeleton = opts.failSkeleton ?? false
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = urlOf(input)
    if (url.endsWith('/diagnostics')) return Promise.resolve(jsonResponse(200, report))
    const m = /\/diagnostics\/objects\/([^/]+)(\/content)?$/.exec(url)
    if (m?.[1] && m[2]) {
      if (failContent) {
        failContent = false
        return Promise.resolve(failure())
      }
      return Promise.resolve(jsonResponse(200, { id: decodeURIComponent(m[1]), content: CONTENT }))
    }
    if (m?.[1]) {
      if (failSkeleton) {
        failSkeleton = false
        return Promise.resolve(failure())
      }
      return Promise.resolve(jsonResponse(200, { id: decodeURIComponent(m[1]), skeleton: { text: SKELETON } }))
    }
    return Promise.resolve(jsonResponse(404, { error: { code: 'not_found', message: '' } }))
  })
}

/** `URL.createObjectURL` and `revokeObjectURL`, which jsdom lacks, stubbed for this test only. */
function stubObjectUrls() {
  const saved = {
    create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
    revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
  }
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:report')
  const revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
  onTestFinished(() => {
    for (const [name, descriptor] of [
      ['createObjectURL', saved.create],
      ['revokeObjectURL', saved.revoke],
    ] as const) {
      if (descriptor) Object.defineProperty(URL, name, descriptor)
      else Reflect.deleteProperty(URL, name)
    }
  })
  return { createObjectURL, revokeObjectURL }
}

/** Mount the dialog as the app does, with calendar `c1` ("Personal") loaded; it opens after the render, as in the app. */
function mount(seed?: (qc: QueryClient) => void) {
  return renderWithProviders(<ReportDialogMount />, (qc) => {
    qc.setQueryData(queryKeys.calendars, [calendar()])
    seed?.(qc)
  })
}

/** Open the report, optionally adding `candidate`, and wait until the file is put together. */
async function open(candidate?: ReportCandidate) {
  act(() => {
    useUi.getState().openReport(candidate)
  })
  const dialog = await screen.findByRole('dialog', { name: 'Report a problem' })
  const sheet = await within(dialog).findByRole('region', { name: 'The file that will be downloaded' })
  return { dialog, sheet }
}

/** The text the sheet shows, line by line: the file that a download writes. */
function preview(sheet: HTMLElement): string {
  return [...sheet.querySelectorAll('[data-line]')].map((line) => line.textContent).join('\n')
}

const escaped = (s: string) => JSON.stringify(s).slice(1, -1)

afterEach(() => {
  useUi.setState({ report: { open: false, candidates: [] }, detail: null })
  toast.dismiss()
})

describe('ReportDialog (FR-36)', () => {
  it('shows no content until asked', async () => {
    mockApi()
    mount()
    const { dialog, sheet } = await open()
    // The server's report as parsed, and nothing added to it but empty client lists.
    const server = diagnosticsReportSchema.parse(diagnosticsReport())
    await waitFor(() => {
      expect(preview(sheet)).toBe(JSON.stringify(assembleReport(server, [], [], new Set()), null, 2))
    })
    expect(preview(sheet)).toContain(escaped('BEGIN:VCALENDAR\nVERSION:2.0\n'))
    expect(within(dialog).getByText("An item Lucid couldn't read")).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Show content' })).toBeInTheDocument()
    expect(within(dialog).queryByText(/SUMMARY:Therapy/)).toBeNull()
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    expect(preview(sheet)).not.toContain('Therapy')
  })

  it('puts the initial focus on what the report contains', async () => {
    mockApi()
    mount()
    const { dialog } = await open()
    await waitFor(() => {
      expect(within(dialog).getByRole('heading', { name: 'In the report' })).toHaveFocus()
    })
  })

  it('includes content only after the box is ticked', async () => {
    mockApi()
    const user = userEvent.setup()
    mount()
    const { dialog, sheet } = await open()
    await user.click(await within(dialog).findByRole('button', { name: 'Show content' }))

    expect(await within(dialog).findByText(/SUMMARY:Therapy/)).toBeInTheDocument()
    const box = within(dialog).getByRole('checkbox', { name: 'Add this content to the report' })
    expect(box).not.toBeChecked()
    expect(box).toHaveAccessibleDescription('It can contain names, places, notes and email addresses.')
    expect(preview(sheet)).not.toContain('Therapy')

    await user.click(box)
    expect(box).toBeChecked()
    expect(preview(sheet)).toContain(`"content": ${JSON.stringify(CONTENT)}`)
    expect(within(dialog).getByText('Content added to the report')).toBeInTheDocument()
    // The lines that leave with the user's consent are the only ones marked in the file.
    const marked = [...sheet.querySelectorAll('[data-consent]')]
    expect(marked.map((line) => line.textContent)).toEqual([`        "content": ${JSON.stringify(CONTENT)}`])

    await user.click(box)
    expect(box).not.toBeChecked()
    expect(preview(sheet)).not.toContain('Therapy')
    expect(within(dialog).getByText('Content removed from the report')).toBeInTheDocument()
  })

  it('offers to try again when the content fails to load', async () => {
    mockApi(diagnosticsReport(), { failContent: true })
    const user = userEvent.setup()
    mount()
    const { dialog } = await open()
    await user.click(await within(dialog).findByRole('button', { name: 'Show content' }))
    expect(await within(dialog).findByText("Lucid couldn't load this content.")).toBeInTheDocument()
    expect(within(dialog).queryByRole('checkbox')).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Try again' }))
    expect(await within(dialog).findByText(/SUMMARY:Therapy/)).toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: 'Add this content to the report' })).not.toBeChecked()
  })

  it('forgets shown content and ticks on close', async () => {
    mockApi()
    const user = userEvent.setup()
    mount()
    const { dialog } = await open(dentist)
    const row = within(dialog).getByRole('listitem', { name: 'Dentist' })
    await user.click(within(row).getByRole('button', { name: 'Show content' }))
    await user.click(await within(row).findByRole('checkbox', { name: 'Add this content to the report' }))

    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(useUi.getState().report).toEqual({ open: false, candidates: [dentist] })

    const again = await open()
    const listed = within(again.dialog).getByRole('listitem', { name: 'Dentist' })
    expect(within(listed).getByRole('button', { name: 'Show content' })).toBeInTheDocument()
    expect(within(again.dialog).queryByText(/SUMMARY:Therapy/)).toBeNull()
    expect(within(again.dialog).queryByRole('checkbox')).toBeNull()
    await waitFor(() => {
      expect(preview(again.sheet)).toContain(escaped(SKELETON))
    })
    expect(preview(again.sheet)).not.toContain('Therapy')
  })

  it('downloads exactly the preview', async () => {
    mockApi()
    const user = userEvent.setup()
    const { createObjectURL, revokeObjectURL } = stubObjectUrls()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const success = vi.spyOn(toast, 'success')
    const { unmount } = mount()
    const { dialog, sheet } = await open(dentist)
    const row = within(dialog).getByRole('listitem', { name: 'Dentist' })
    await user.click(within(row).getByRole('button', { name: 'Show content' }))
    await user.click(await within(row).findByRole('checkbox', { name: 'Add this content to the report' }))
    await waitFor(() => {
      expect(preview(sheet)).toContain(escaped(SKELETON))
    })
    const shown = preview(sheet)
    expect(shown).toContain(JSON.stringify(CONTENT))

    await user.click(within(dialog).getByRole('button', { name: 'Download report' }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0]![0]
    expect(blob.type).toBe('application/json')
    expect(await blob.text()).toBe(shown)
    const link = click.mock.contexts[0] as HTMLAnchorElement
    expect(link.download).toMatch(/^lucid-report-\d{8}-\d{6}Z\.json$/)
    expect(link.href).toBe('blob:report')
    expect(within(dialog).getByText(link.download)).toBeInTheDocument()

    expect(useUi.getState().report.candidates).toEqual([])
    expect(success).toHaveBeenCalledWith('Report downloaded')
    await waitFor(() => {
      expect(within(dialog).queryByText('Dentist')).toBeNull()
    })

    // The file's URL goes with the dialog at the latest, its timer with it.
    expect(revokeObjectURL).not.toHaveBeenCalled()
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report')
  })

  it('uses an event added to the report', async () => {
    const fetch = mockApi()
    const user = userEvent.setup()
    mount()
    const { dialog, sheet } = await open(dentist)
    const row = within(dialog).getByRole('listitem', { name: 'Dentist' })
    expect(within(row).getByText('Event in Personal')).toBeInTheDocument()
    await waitFor(() => {
      expect(preview(sheet)).toContain(escaped(SKELETON))
    })
    expect(fetch.mock.calls.some(([u]) => urlOf(u) === '/api/v1/diagnostics/objects/ev-1')).toBe(true)
    // The object with its kind, never its title or calendar.
    expect(preview(sheet)).toContain('"objectId": "ev-1"')
    expect(preview(sheet)).toContain('"source": "event"')
    expect(preview(sheet)).not.toContain('Dentist')
    expect(preview(sheet)).not.toContain('Personal')

    await user.click(within(row).getByRole('button', { name: 'Remove Dentist from the report' }))
    expect(within(dialog).queryByText('Dentist')).toBeNull()
    expect(preview(sheet)).not.toContain('ev-1')
    expect(useUi.getState().report.candidates).toEqual([])
    expect(within(dialog).getByText('To add an event or task, open it and choose Add to problem report.')).toBeInTheDocument()
  })

  it('names a task as a task', async () => {
    mockApi()
    mount()
    const { dialog, sheet } = await open({ objectId: 'td-1', kind: 'todo', label: 'Pay rent', calendarId: 'c1' })
    const row = within(dialog).getByRole('listitem', { name: 'Pay rent' })
    expect(within(row).getByText('Task in Personal')).toBeInTheDocument()
    await waitFor(() => {
      expect(preview(sheet)).toContain('"source": "todo"')
    })
  })

  it('anonymous session', async () => {
    // A forced logout keeps the problems without their object IDs; even one with an ID offers no content.
    const report = diagnosticsReport({
      authenticated: false,
      problems: [
        ...diagnosticsReport().problems,
        { kind: 'invalid_xml', path: '{home}/', reason: 'unexpected root element', skeleton: { text: '<d:multistatus/>' } },
      ],
    })
    mockApi(report)
    mount()
    const { dialog, sheet } = await open()
    expect(await within(dialog).findByText('Sign in to add events or tasks.')).toBeInTheDocument()
    expect(within(dialog).getByText("An item Lucid couldn't read")).toBeInTheDocument()
    expect(within(dialog).getByText("An answer Lucid couldn't read")).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Show content' })).toBeNull()
    await waitFor(() => {
      expect(preview(sheet)).toContain('"authenticated": false')
    })
  })

  it('sums up what the report holds', async () => {
    mockApi()
    const broken: CorruptedItem = {
      kind: 'corrupted',
      key: 'k1',
      calendarId: 'c1',
      start: null,
      reason: 'title: Invalid input: expected string, received number',
      issues: [{ path: 'title', code: 'invalid_type' }],
    }
    mount((qc) => {
      qc.setQueryData(queryKeys.events('c1', 'a', 'b'), { events: [], corrupted: [broken] })
    })
    const { dialog, sheet } = await open()
    const summary = within(dialog).getByRole('region', { name: 'In the report' })
    expect(within(summary).getByText('1.2.3, server mode')).toBeInTheDocument()
    expect(within(summary).getByText('Nextcloud at dav.example.com')).toBeInTheDocument()
    expect(within(summary).getByText('1 recent one, without contents')).toBeInTheDocument()
    expect(within(summary).getByText('1, as structure only')).toBeInTheDocument()
    expect(within(summary).getByText('1, field names only')).toBeInTheDocument()
    // The placeholder by its field names; never the reason, which can hold what Zod received.
    await waitFor(() => {
      expect(preview(sheet)).toContain('"code": "invalid_type"')
    })
    expect(preview(sheet)).not.toContain('received number')
  })

  it('links to the issue form and the private security advisories', async () => {
    mockApi()
    mount()
    const { dialog } = await open()
    const form = within(dialog).getByRole('link', { name: 'Open issue form (opens in a new tab)' })
    expect(form).toHaveAttribute('href', issueUrl(diagnosticsReport()))
    expect(form).toHaveAttribute('target', '_blank')
    expect(form).toHaveAttribute('rel', 'noopener noreferrer')
    const security = within(dialog).getByRole('link', { name: 'Report security problems privately. (opens in a new tab)' })
    expect(security).toHaveAttribute('href', 'https://github.com/tbckr/lucid/security/advisories/new')
    expect(security).toHaveAttribute('rel', 'noopener noreferrer')
    expect(within(dialog).getByText('Issues on GitHub are public.')).toBeInTheDocument()
  })

  it("can't download before the report is put together, and tries again after a failure", async () => {
    let fail = true
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      if (fail) {
        fail = false
        return Promise.resolve(jsonResponse(500, { error: { code: 'internal', message: '' } }))
      }
      return Promise.resolve(jsonResponse(200, diagnosticsReport()))
    })
    const user = userEvent.setup()
    mount()
    act(() => {
      useUi.getState().openReport()
    })
    const dialog = await screen.findByRole('dialog', { name: 'Report a problem' })
    expect(within(dialog).getByRole('button', { name: 'Download report' })).toBeDisabled()
    expect(await within(dialog).findByText("Lucid couldn't put the report together.")).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Download report' })).toBeDisabled()

    await user.click(within(dialog).getByRole('button', { name: 'Try again' }))
    expect(await within(dialog).findByRole('region', { name: 'The file that will be downloaded' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Download report' })).toBeEnabled()
  })

  it('drops the content of an added item that is removed after it was ticked', async () => {
    mockApi()
    const user = userEvent.setup()
    mount()
    const { dialog, sheet } = await open(dentist)
    const row = within(dialog).getByRole('listitem', { name: 'Dentist' })
    await user.click(within(row).getByRole('button', { name: 'Show content' }))
    await user.click(await within(row).findByRole('checkbox', { name: 'Add this content to the report' }))
    await waitFor(() => {
      expect(preview(sheet)).toContain(JSON.stringify(CONTENT))
    })

    await user.click(within(row).getByRole('button', { name: 'Remove Dentist from the report' }))
    expect(preview(sheet)).not.toContain('Therapy')
    expect(preview(sheet)).not.toContain('ev-1')
  })

  it('lists an object that is an added item and a problem once, as the item, with one tick for both', async () => {
    mockApi()
    const user = userEvent.setup()
    mount()
    // The problem of the fixture is about object `obj-id-1`; the user added the same object as an event.
    const { dialog, sheet } = await open({ ...dentist, objectId: 'obj-id-1' })
    const item = within(dialog).getByRole('listitem', { name: 'Dentist' })
    const problem = within(dialog).getByRole('listitem', { name: "An item Lucid couldn't read" })
    await user.click(within(item).getByRole('button', { name: 'Show content' }))
    // Shown once, in both rows.
    const box = await within(item).findByRole('checkbox', { name: 'Add this content to the report' })
    expect(within(problem).getByRole('checkbox', { name: 'Add this content to the report' })).not.toBeChecked()

    await user.click(box)
    expect(within(problem).getByRole('checkbox', { name: 'Add this content to the report' })).toBeChecked()
    await waitFor(() => {
      expect(preview(sheet)).toContain(JSON.stringify(CONTENT))
    })
    const file = JSON.parse(preview(sheet)) as { client: { objects: { objectId: string; source: string }[] } }
    expect(file.client.objects.map((o) => [o.objectId, o.source])).toEqual([['obj-id-1', 'event']])
    expect(preview(sheet).split('"content":')).toHaveLength(2)
  })

  it('announces each tick, also the same message twice in a row', async () => {
    mockApi()
    const user = userEvent.setup()
    mount()
    const { dialog } = await open(dentist)
    const live = dialog.querySelector('[aria-live="polite"]')!
    for (const name of ['Dentist', "An item Lucid couldn't read"]) {
      const row = within(dialog).getByRole('listitem', { name })
      await user.click(within(row).getByRole('button', { name: 'Show content' }))
      await user.click(await within(row).findByRole('checkbox', { name: 'Add this content to the report' }))
    }
    const second = live.firstElementChild
    expect(second).toHaveTextContent('Content added to the report')

    // A new node each time: screen readers announce what is added to a live region, not what stays.
    const row = within(dialog).getByRole('listitem', { name: 'Dentist' })
    await user.click(within(row).getByRole('checkbox', { name: 'Add this content to the report' }))
    await user.click(within(row).getByRole('checkbox', { name: 'Add this content to the report' }))
    expect(live.firstElementChild).toHaveTextContent('Content added to the report')
    expect(live.firstElementChild).not.toBe(second)
  })

  it('keeps an added item once, however often it is added', () => {
    act(() => {
      useUi.getState().openReport(dentist)
      useUi.getState().closeReport()
      useUi.getState().openReport({ ...dentist, label: 'Dentist again' })
    })
    expect(useUi.getState().report).toEqual({ open: true, candidates: [dentist] })
  })
})

describe('ReportDialog focus', () => {
  it('returns the focus to where the report was opened from', async () => {
    mockApi()
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <button
          type="button"
          onClick={() => {
            useUi.getState().openReport()
          }}
        >
          Opener
        </button>
        <ReportDialogMount />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Opener' }))
    const dialog = await screen.findByRole('dialog', { name: 'Report a problem' })
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Opener' })).toHaveFocus()
    })
  })

  it("returns the focus to the item's block when it was opened from the item's details", async () => {
    mockApi()
    const user = userEvent.setup()
    mount()
    renderWithProviders(<button type="button">Block</button>)
    const block = screen.getByRole('button', { name: 'Block' })
    act(() => {
      useUi.getState().openDetail({ item: toCalEvent(apiEvent({ title: 'Dentist' })), anchor: block })
    })
    // The details' button that opens the report goes with them: the block is where the user was.
    const { dialog } = await open(dentist)
    expect(useUi.getState().detail).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => {
      expect(block).toHaveFocus()
    })
  })

  it('returns the focus to the account menu when what opened the report is gone', async () => {
    mockApi()
    const user = userEvent.setup()
    function MenuItem() {
      const [shown, setShown] = useState(true)
      return shown ? (
        <button
          type="button"
          onClick={() => {
            useUi.getState().openReport()
            setShown(false)
          }}
        >
          Menu item
        </button>
      ) : null
    }
    renderWithProviders(
      <>
        <button type="button" data-account-menu="">
          Account
        </button>
        <MenuItem />
        <ReportDialogMount />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Menu item' }))
    const dialog = await screen.findByRole('dialog', { name: 'Report a problem' })
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Account' })).toHaveFocus()
    })
  })

  it('moves the focus to the content once it is shown', async () => {
    mockApi()
    const user = userEvent.setup()
    mount()
    const { dialog } = await open()
    const problem = within(dialog).getByRole('listitem', { name: "An item Lucid couldn't read" })
    within(problem).getByRole('button', { name: 'Show content' }).focus()
    await user.keyboard('{Enter}')
    // The content, named by its row, then its box by Tab.
    const content = await within(problem).findByRole('region', { name: "An item Lucid couldn't read" })
    await waitFor(() => {
      expect(content).toHaveFocus()
    })
    expect(content).toHaveTextContent('SUMMARY:Therapy')
    await user.tab()
    expect(within(problem).getByRole('checkbox', { name: 'Add this content to the report' })).toHaveFocus()
  })

  it('moves the focus to "Try again" when the content fails to load, and on to the content after it', async () => {
    mockApi(diagnosticsReport(), { failContent: true })
    const user = userEvent.setup()
    mount()
    const { dialog } = await open()
    const problem = within(dialog).getByRole('listitem', { name: "An item Lucid couldn't read" })
    within(problem).getByRole('button', { name: 'Show content' }).focus()
    await user.keyboard('{Enter}')
    const retry = await within(problem).findByRole('button', { name: 'Try again' })
    await waitFor(() => {
      expect(retry).toHaveFocus()
    })

    await user.keyboard('{Enter}')
    const content = await within(problem).findByRole('region', { name: "An item Lucid couldn't read" })
    await waitFor(() => {
      expect(content).toHaveFocus()
    })
  })

  it("moves the focus to an added item's content button once its structure loads after a failure", async () => {
    mockApi(diagnosticsReport(), { failSkeleton: true })
    const user = userEvent.setup()
    mount()
    const { dialog } = await open(dentist)
    const row = within(dialog).getByRole('listitem', { name: 'Dentist' })
    const retry = await within(row).findByRole('button', { name: 'Try again' })
    expect(within(row).getByText("Lucid couldn't load this content.")).toBeInTheDocument()
    retry.focus()
    await user.keyboard('{Enter}')
    const show = await within(row).findByRole('button', { name: 'Show content' })
    await waitFor(() => {
      expect(show).toHaveFocus()
    })
  })

  it("moves the focus to the next row's first control after a removal, else to the list's heading", async () => {
    mockApi(diagnosticsReport({ problems: [] }))
    const user = userEvent.setup()
    mount()
    act(() => {
      useUi.getState().openReport(dentist)
    })
    const { dialog } = await open(rent)
    await user.click(within(dialog).getByRole('button', { name: 'Remove Dentist from the report' }))
    expect(within(dialog).getByRole('button', { name: 'Remove Pay rent from the report' })).toHaveFocus()

    await user.click(within(dialog).getByRole('button', { name: 'Remove Pay rent from the report' }))
    expect(within(dialog).getByRole('heading', { name: 'Items' })).toHaveFocus()
  })
})
