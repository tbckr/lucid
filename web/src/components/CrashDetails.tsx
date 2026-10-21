import { CopyIcon, ExternalLinkIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useSession } from '@/hooks/queries'
import { bugIssueUrl, crashDetails } from '@/lib/diagnostics'
import { browserLocale, browserTimeZone } from '@/lib/locale'

/**
 * The details of a crash (FR-19), folded below the crash screen's reload: what a bug report needs to reproduce it,
 * on the same paper sheet as the problem report's file, to copy into the bug form. Nothing is kept or sent; the user
 * sees what they copy.
 */
export function CrashDetails({ error }: { error: Error }) {
  const { t } = useTranslation()
  const version = useSession().data?.version
  const [copy, setCopy] = useState<'copied' | 'failed' | null>(null)
  const text = crashDetails({
    error,
    ...(version === undefined ? {} : { version }),
    timeZone: browserTimeZone(),
    locale: browserLocale(),
    userAgent: navigator.userAgent,
    origin: window.location.origin,
  })
  return (
    <details className="mt-4 w-full max-w-xl text-left">
      <summary className="mx-auto w-fit cursor-pointer rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/60">
        {t('boot.crashDetails')}
      </summary>
      <pre
        role="region"
        aria-label={t('boot.crashDetails')}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a region that scrolls must take the focus to scroll by keyboard
        tabIndex={0}
        className="scrollbar-thin mt-3 max-h-64 overflow-auto rounded-lg border bg-surface px-4 py-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground shadow-xs outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {text}
      </pre>
      <p className="mt-3 text-sm text-pretty text-muted-foreground">{t('boot.crashHint')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => {
            navigator.clipboard.writeText(text).then(
              () => {
                setCopy('copied')
              },
              () => {
                setCopy('failed')
              },
            )
          }}
        >
          <CopyIcon aria-hidden />
          {t('boot.copyDetails')}
        </Button>
        <Button variant="ghost" asChild>
          <a href={bugIssueUrl(version)} target="_blank" rel="noopener noreferrer">
            {t('diagnostics.openIssue')}
            <ExternalLinkIcon aria-hidden />{' '}
            <span className="sr-only">{t('diagnostics.newTab')}</span>
          </a>
        </Button>
        <span role="status" className="text-sm text-muted-foreground">
          {copy === 'copied' ? t('boot.copied') : copy === 'failed' ? t('boot.copyFailed') : ''}
        </span>
      </div>
    </details>
  )
}
