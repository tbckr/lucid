import { useQueries, useQuery } from '@tanstack/react-query'
import { ChevronDownIcon, ExternalLinkIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { useCorruptedItems, useVisibleCalendars } from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { endpoints } from '@/lib/api/endpoints'
import { type DiagnosticsReport } from '@/lib/api/schemas'
import { assembleReport, issueUrl, reportFileName, SECURITY_URL, type ReportObject } from '@/lib/diagnostics'
import { cn } from '@/lib/utils'
import { useUi, type ReportCandidate } from '@/stores/ui'

/*
 * The problem report (FR-36): a file the user downloads to hand a CalDAV server problem to the maintainers.
 * The left pane explains and chooses, the right pane is the file itself, exactly as it downloads. It holds no
 * calendar contents (NFR-36) unless the user, for one object at a time, asks to see its content and then ticks
 * the box that adds it. What was shown and ticked lives here only and is gone once the dialog closes.
 */

/** An object's raw content as the dialog shows it: asked for one at a time, never cached. */
type Shown = { status: 'loading' } | { status: 'failed' } | { status: 'shown'; text: string }

/** No retries and no refetch behind the user's back: the file must not change while they read it. */
const ONCE = { staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false } as const

/** The problem report dialog, mounted once for both screens; the store opens it. */
export function ReportDialog() {
  const { t } = useTranslation()
  const open = useUi((s) => s.report.open)
  const closeReport = useUi((s) => s.closeReport)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  // Each opening starts afresh, even one while the last is still fading out.
  const [opening, setOpening] = useState(0)

  useEffect(
    () =>
      useUi.subscribe((s, prev) => {
        if (!s.report.open || prev.report.open) return
        // Back to the item whose details it was opened from, or to what opened it, once it closes.
        const active = document.activeElement
        returnFocus.current =
          prev.detail?.anchor ?? (active instanceof HTMLElement && active !== document.body ? active : null)
        setOpening((n) => n + 1)
      }),
    [],
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeReport()
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:h-[min(90dvh,56rem)] sm:max-h-none sm:max-w-4xl"
        onOpenAutoFocus={(e) => {
          // Screen readers start with what the report contains, not with a button.
          e.preventDefault()
          headingRef.current?.focus()
        }}
        onCloseAutoFocus={(e) => {
          const target = returnFocus.current
          returnFocus.current = null
          if (target?.isConnected) {
            e.preventDefault()
            target.focus()
          }
        }}
      >
        <DialogHeader className="border-b px-6 pt-6 pb-4">
          <DialogTitle>{t('diagnostics.title')}</DialogTitle>
          <DialogDescription className="max-w-prose">{t('diagnostics.description')}</DialogDescription>
        </DialogHeader>
        <ReportBody key={opening} headingRef={headingRef} />
      </DialogContent>
    </Dialog>
  )
}

function ReportBody({ headingRef }: { headingRef: RefObject<HTMLHeadingElement | null> }) {
  const { t } = useTranslation()
  const id = useId()
  const candidates = useUi((s) => s.report.candidates)
  const removeCandidate = useUi((s) => s.removeReportCandidate)
  const clearReport = useUi((s) => s.clearReport)
  const corrupted = useCorruptedItems()
  const report = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => endpoints.getDiagnostics(signal),
    ...ONCE,
  })
  const server = report.data
  // Objects can be read for an authenticated session only, and only then does the report name any.
  const signedIn = server?.authenticated === true
  const skeletons = useQueries({
    queries: candidates.map((c) => ({
      queryKey: ['diagnostics', 'objects', c.objectId],
      queryFn: () => endpoints.getObjectSkeleton(c.objectId),
      enabled: signedIn,
      ...ONCE,
    })),
  })
  const [shown, setShown] = useState<ReadonlyMap<string, Shown>>(new Map())
  const [included, setIncluded] = useState<ReadonlySet<string>>(new Set())
  const [announcement, setAnnouncement] = useState('')
  const [fileOpen, setFileOpen] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrollTo = useRef<string | null>(null)

  // The objects of the file: each added item by its skeleton, then each problem whose content was ticked. The
  // content goes along wherever it was shown, and assembleReport writes it for the ticked ones only.
  const objects: ReportObject[] = []
  if (server && signedIn) {
    const listed = new Set<string>()
    const contentOf = (objectId: string) => {
      const s = shown.get(objectId)
      return s?.status === 'shown' ? { content: s.text } : {}
    }
    candidates.forEach((c, i) => {
      listed.add(c.objectId)
      const skeleton = skeletons[i]?.data?.skeleton
      if (skeleton) objects.push({ objectId: c.objectId, source: c.kind, skeleton, ...contentOf(c.objectId) })
    })
    for (const p of server.problems) {
      if (p.objectId === undefined || listed.has(p.objectId) || !included.has(p.objectId)) continue
      listed.add(p.objectId)
      objects.push({ objectId: p.objectId, source: 'problem', skeleton: p.skeleton, ...contentOf(p.objectId) })
    }
  }
  // The preview is the file, byte for byte.
  const text = server ? JSON.stringify(assembleReport(server, corrupted, objects, included), null, 2) : null
  const fileName = useMemo(() => reportFileName(new Date(report.dataUpdatedAt)), [report.dataUpdatedAt])
  const lineCount = text === null ? 0 : text.split('\n').length
  const ready = text !== null && !(signedIn && skeletons.some((s) => s.isLoading))

  // Ticking scrolls the file to the lines it added, whose wash then fades (the one motion of the dialog). Only
  // where the file scrolls on its own, beside the items: in one column it would pull the box away from the user.
  useEffect(() => {
    const objectId = scrollTo.current
    const sheet = sheetRef.current
    if (objectId === null || !sheet) return
    scrollTo.current = null
    const line = [...sheet.querySelectorAll<HTMLElement>('[data-consent]')].find((l) => l.dataset.consent === objectId)
    if (!line || sheet.scrollHeight <= sheet.clientHeight) return
    const top = Math.max(0, line.offsetTop - sheet.clientHeight / 3)
    // A long glide would end after the wash: far lines are there at once.
    const near = Math.abs(top - sheet.scrollTop) < sheet.clientHeight * 2
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    sheet.scrollTo({ top, behavior: near && !reduced ? 'smooth' : 'auto' })
  }, [text])

  function showContent(objectId: string) {
    setShown((m) => new Map(m).set(objectId, { status: 'loading' }))
    void endpoints.getObjectContent(objectId).then(
      ({ content }) => {
        setShown((m) => new Map(m).set(objectId, { status: 'shown', text: content }))
      },
      () => {
        setShown((m) => new Map(m).set(objectId, { status: 'failed' }))
      },
    )
  }

  function include(objectId: string, on: boolean) {
    setIncluded((s) => {
      const next = new Set(s)
      if (on) next.add(objectId)
      else next.delete(objectId)
      return next
    })
    setAnnouncement(t(on ? 'diagnostics.content.added' : 'diagnostics.content.removed'))
    scrollTo.current = on ? objectId : null
  }

  function download() {
    if (text === null) return
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.append(link)
    link.click()
    link.remove()
    // The download reads the file after the click returns; give it time before the URL goes.
    setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 10_000)
    clearReport()
    toast.success(t('diagnostics.downloaded'))
  }

  const consent = (objectId: string) => ({
    state: shown.get(objectId),
    included: included.has(objectId),
    onShow: () => {
      showContent(objectId)
    },
    onInclude: (on: boolean) => {
      include(objectId, on)
    },
  })

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] sm:grid-rows-[minmax(0,1fr)] sm:overflow-hidden">
        <div className="scrollbar-thin grid content-start gap-7 px-6 py-5 sm:overflow-y-auto">
          <section aria-labelledby={`${id}-summary`} className="grid gap-3">
            <h3 ref={headingRef} id={`${id}-summary`} tabIndex={-1} className="font-display text-sm font-semibold outline-none">
              {t('diagnostics.summary.heading')}
            </h3>
            {server && <Summary report={server} corrupted={corrupted.length} />}
          </section>

          <section aria-labelledby={`${id}-items`} className="grid gap-2">
            <h3 id={`${id}-items`} className="font-display text-sm font-semibold">
              {t('diagnostics.items.heading')}
            </h3>
            <p className="text-xs text-muted-foreground">
              {server && !signedIn ? t('diagnostics.items.signedOut') : t('diagnostics.items.hint')}
            </p>
            {server && (signedIn || server.problems.length > 0) && (
              <ul className="mt-1 divide-y border-y">
                {signedIn && candidates.length === 0 && (
                  <li className="py-3 text-sm text-muted-foreground">{t('diagnostics.items.empty')}</li>
                )}
                {signedIn &&
                  candidates.map((c, i) => {
                    const skeleton = skeletons[i]
                    return (
                      <CandidateRow
                        key={c.objectId}
                        candidate={c}
                        failed={skeleton?.isError === true}
                        onRetry={() => void skeleton?.refetch()}
                        onRemove={() => {
                          removeCandidate(c.objectId)
                        }}
                        {...consent(c.objectId)}
                      />
                    )
                  })}
                {server.problems.map((p, i) => (
                  <ProblemRow
                    key={i}
                    kind={p.kind}
                    {...(signedIn && p.objectId !== undefined ? { consent: consent(p.objectId) } : {})}
                  />
                ))}
              </ul>
            )}
          </section>
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </div>

        <div className="flex min-h-0 flex-col bg-background px-6 py-5 sm:border-l">
          {report.isError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center text-sm">
              <p>{t('diagnostics.failed')}</p>
              <Button variant="outline" size="sm" onClick={() => void report.refetch()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : text === null ? (
            <div role="status" className="flex flex-1 items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner />
              {t('diagnostics.loading')}
            </div>
          ) : (
            <>
              <button
                type="button"
                aria-expanded={fileOpen}
                aria-controls={`${id}-file`}
                onClick={() => {
                  setFileOpen((o) => !o)
                }}
                className="flex items-center gap-2 rounded-md text-left text-sm font-medium sm:hidden"
              >
                <ChevronDownIcon className={cn('size-4 shrink-0 transition-transform', fileOpen && 'rotate-180')} aria-hidden />
                {t('diagnostics.file.show', { count: lineCount })}
              </button>
              <div id={`${id}-file`} className={cn('min-h-0 flex-1 flex-col max-sm:mt-4', fileOpen ? 'flex' : 'hidden sm:flex')}>
                <div className="mb-3 grid gap-0.5">
                  <p className="font-display text-[0.8125rem] font-medium [overflow-wrap:anywhere]">{fileName}</p>
                  <p className="text-xs text-muted-foreground">{t('diagnostics.file.lines', { count: lineCount })}</p>
                </div>
                <div
                  ref={sheetRef}
                  role="region"
                  aria-label={t('diagnostics.file.region')}
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a region that scrolls must take the focus to scroll by keyboard
                  tabIndex={0}
                  className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto rounded-lg border bg-surface px-4 py-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground break-all shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <Sheet text={text} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t px-6 py-4 sm:flex-row sm:items-center sm:gap-3">
        <div className="grid gap-0.5 text-xs text-muted-foreground sm:mr-auto">
          <p>{t('diagnostics.notice.public')}</p>
          <p>
            <a
              href={SECURITY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-sm underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground hover:decoration-foreground"
            >
              {t('diagnostics.notice.security')}{' '}
              <span className="sr-only">{t('diagnostics.newTab')}</span>
            </a>
          </p>
        </div>
        {server ? (
          <a
            href={issueUrl(server)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 self-start rounded-md text-sm font-medium underline decoration-muted-foreground/50 underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60 sm:h-9 sm:self-auto sm:border sm:bg-surface sm:px-3 sm:no-underline sm:transition-colors sm:hover:bg-muted [&_svg]:size-4"
          >
            {t('diagnostics.openIssue')}
            <ExternalLinkIcon aria-hidden />{' '}
            <span className="sr-only">{t('diagnostics.newTab')}</span>
          </a>
        ) : (
          <Button variant="outline" disabled className="max-sm:hidden">
            {t('diagnostics.openIssue')}
            <ExternalLinkIcon aria-hidden />
          </Button>
        )}
        {/* Ink, not iris: in this dialog iris means content that leaves with the user's consent, and nothing else. */}
        <Button onClick={download} disabled={!ready} className="bg-foreground text-background hover:bg-foreground/85 max-sm:w-full">
          {t('diagnostics.download')}
        </Button>
      </div>
    </>
  )
}

function Summary({ report, corrupted }: { report: DiagnosticsReport; corrupted: number }) {
  const { t } = useTranslation()
  const { version, mode } = report.lucid
  const { host, product } = report.server
  const modeName =
    mode === 'server' ? t('diagnostics.summary.modeServer') : mode === 'local' ? t('diagnostics.summary.modeLocal') : mode
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
      <Fact term={t('diagnostics.summary.lucid')}>{t('diagnostics.summary.lucidValue', { version, mode: modeName })}</Fact>
      {/* Before any request to a server there is none to name. */}
      {host !== '' && (
        <Fact term={t('diagnostics.summary.server')}>
          {product === ''
            ? t('diagnostics.summary.serverUnknown', { host })
            : t('diagnostics.summary.serverValue', { product, host })}
        </Fact>
      )}
      <Fact term={t('diagnostics.summary.requests')}>
        {t('diagnostics.summary.requestsValue', { count: report.exchanges.length })}
      </Fact>
      {report.problems.length > 0 && (
        <Fact term={t('diagnostics.summary.problems')}>
          {t('diagnostics.summary.problemsValue', { count: report.problems.length })}
        </Fact>
      )}
      {corrupted > 0 && (
        <Fact term={t('diagnostics.summary.corrupted')}>
          {t('diagnostics.summary.corruptedValue', { count: corrupted })}
        </Fact>
      )}
    </dl>
  )
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

interface ConsentProps {
  state: Shown | undefined
  included: boolean
  onShow: () => void
  onInclude: (on: boolean) => void
}

type ContentProps = ConsentProps & {
  /** The row's label, which names the shown content. */
  labelledBy: string
}

/** An event or task the user added: its calendar's bar, title and calendar, which the file never gets. */
function CandidateRow({
  candidate,
  failed,
  onRetry,
  onRemove,
  ...consent
}: ConsentProps & { candidate: ReportCandidate; failed: boolean; onRetry: () => void; onRemove: () => void }) {
  const { t } = useTranslation()
  const id = useId()
  const { byId } = useVisibleCalendars()
  const colors = useCalendarColors()(candidate.calendarId)
  const calendar = byId.get(candidate.calendarId)?.name ?? t('event.unknownCalendar')
  return (
    <li aria-labelledby={`${id}-label`} className="py-3">
      <div className="relative border-l-[3px] pl-3" style={{ borderLeftColor: colors.solid }}>
        <div className="pr-9">
          <p id={`${id}-label`} className="text-sm font-medium [overflow-wrap:anywhere]">
            {candidate.label}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(candidate.kind === 'event' ? 'diagnostics.items.event' : 'diagnostics.items.task', { calendar })}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('diagnostics.items.remove', { label: candidate.label })}
          onClick={onRemove}
          className="absolute -top-1 right-0 text-muted-foreground"
        >
          <XIcon aria-hidden />
        </Button>
        {/* Without its skeleton the item is not in the file, so its content can't be either. */}
        {failed ? (
          <Failure message={t('diagnostics.content.failed')} onRetry={onRetry} />
        ) : (
          <Content labelledBy={`${id}-label`} {...consent} />
        )}
      </div>
    </li>
  )
}

/** A problem the server recorded, in words; its content can be shown when it names an object (signed in only). */
function ProblemRow({ kind, consent }: { kind: string; consent?: ConsentProps }) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <li aria-labelledby={`${id}-label`} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 py-3">
      <TriangleAlertIcon className="mt-0.5 size-4 text-destructive" aria-hidden />
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-sm">
          {t(`diagnostics.problem.${kind}` as 'diagnostics.problem.invalid_xml', { defaultValue: kind })}
        </p>
        {consent && <Content labelledBy={`${id}-label`} {...consent} />}
      </div>
    </li>
  )
}

/** "Show content", then the content and the box that adds it: no agreement without sight. */
function Content({ state, included, onShow, onInclude, labelledBy }: ContentProps) {
  const { t } = useTranslation()
  const id = useId()
  if (state === undefined) {
    return (
      <Button variant="outline" size="sm" className="mt-2" onClick={onShow}>
        {t('diagnostics.content.show')}
      </Button>
    )
  }
  if (state.status === 'loading') {
    return (
      <p role="status" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner />
        {t('diagnostics.content.loading')}
      </p>
    )
  }
  if (state.status === 'failed') return <Failure message={t('diagnostics.content.failed')} onRetry={onShow} />
  return (
    <div className="mt-2 grid gap-2.5">
      <pre
        role="region"
        aria-labelledby={labelledBy}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the content must be read in full before it is added, by keyboard too
        tabIndex={0}
        className={cn(
          'scrollbar-thin max-h-44 overflow-y-auto rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring/60',
          included && 'border-primary ring-1 ring-primary',
        )}
      >
        {state.text}
      </pre>
      <div className="flex items-start gap-2.5">
        <Checkbox
          id={`${id}-include`}
          checked={included}
          onCheckedChange={(checked) => {
            onInclude(checked === true)
          }}
          aria-describedby={`${id}-hint`}
          className="mt-px"
        />
        <div className="grid gap-1">
          <Label htmlFor={`${id}-include`} className="leading-tight font-normal">
            {t('diagnostics.content.include')}
          </Label>
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {t('diagnostics.content.includeHint')}
          </p>
        </div>
      </div>
    </div>
  )
}

function Failure({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-sm font-medium underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
      >
        {t('common.retry')}
      </button>
    </div>
  )
}

interface SheetLine {
  key: string
  text: string
  /** The object whose content the line is: the lines that leave with the user's consent. */
  consent?: string
}

const CLIENT = '  "client": {'
const OBJECTS = '    "objects": ['
const OBJECT_ID = '        "objectId": '
const CONTENT = '        "content": '

/**
 * The lines of the file, with the content lines of `client.objects` marked by their object. A content line keeps
 * its key while lines come and go before it, so its wash plays once, when it is added.
 */
function sheetLines(text: string): SheetLine[] {
  let section: 'before' | 'client' | 'objects' | 'after' = 'before'
  let objectId: string | undefined
  return text.split('\n').map((line, i) => {
    if (section === 'before' && line === CLIENT) section = 'client'
    else if (section === 'client' && line === OBJECTS) section = 'objects'
    else if (section === 'objects' && line.startsWith('    ]')) section = 'after'
    else if (section === 'objects' && line.startsWith(OBJECT_ID)) {
      const value: unknown = JSON.parse(line.slice(OBJECT_ID.length).replace(/,$/, ''))
      objectId = typeof value === 'string' ? value : undefined
    } else if (section === 'objects' && objectId !== undefined && line.startsWith(CONTENT)) {
      return { key: `content:${objectId}`, text: line, consent: objectId }
    }
    return { key: `line:${i}`, text: line }
  })
}

const INDENT = /^ */
const KEY = /^"(?:[^"\\]|\\.)*"(?=: )/

/** The file as a sheet of paper: keys in slate, values in ink, the content the user added on an iris wash. */
const Sheet = memo(function Sheet({ text }: { text: string }) {
  const lines = useMemo(() => sheetLines(text), [text])
  return lines.map((line) => {
    const indent = INDENT.exec(line.text)?.[0] ?? ''
    const name = KEY.exec(line.text.slice(indent.length))?.[0] ?? ''
    // A long value wraps under its key, not at the edge of the sheet.
    const hang = `${indent.length + 2}ch`
    const consent = line.consent !== undefined
    return (
      <div
        key={line.key}
        data-line=""
        data-consent={line.consent}
        style={{ paddingLeft: consent ? `calc(1rem - 2px + ${hang})` : hang, textIndent: `-${hang}` }}
        className={cn(
          consent && '-mx-4 animate-consent-wash border-l-2 border-primary bg-primary/8 pr-4 motion-reduce:animate-none',
        )}
      >
        {indent}
        {name && <span className="text-muted-foreground">{name}</span>}
        {line.text.slice(indent.length + name.length)}
      </div>
    )
  })
})
