import { ArrowUpRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSession } from '@/hooks/queries'
import { cn } from '@/lib/utils'

const REPO_URL = 'https://github.com/tbckr/lucid'

/** Version of the running binary (from the session) and a link to the source code. */
export function AppVersion({ className }: { className?: string }) {
  const { t } = useTranslation()
  const version = useSession().data?.version
  return (
    <p className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      {version && (
        <>
          <span>{t('about.version', { version })}</span>
          <span aria-hidden>·</span>
        </>
      )}
      <a
        href={REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('about.source')}
        className="inline-flex items-center gap-0.5 rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        GitHub
        <ArrowUpRightIcon className="size-3" aria-hidden />
      </a>
    </p>
  )
}
