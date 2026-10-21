import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { RefreshCwIcon } from 'lucide-react'
import { lazy, Suspense, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { CrashDetails } from '@/components/CrashDetails'
import { ReportDialogMount } from '@/components/diagnostics/ReportDialogMount'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSession } from '@/hooks/queries'
import { useTheme } from '@/hooks/useTheme'
import { useUnauthenticatedRedirect } from '@/hooks/useUnauthenticatedRedirect'
import i18n from '@/i18n'
import { apiErrorMessage } from '@/lib/errors'
import { loginPathFor, safeRedirect } from '@/lib/redirect'
import { navigate, useLocation } from '@/lib/router'
import { useSettings } from '@/stores/settings'

// Split the two screens: first-time visitors only download the login page.
const CalendarPage = lazy(() => import('@/pages/CalendarPage').then((m) => ({ default: m.CalendarPage })))
const LoginPage = lazy(() => import('@/pages/LoginPage').then((m) => ({ default: m.LoginPage })))

export function App({ queryClient }: { queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppErrorBoundary>
          <Root />
          {/* On both screens: the login screen reports a failed login, and a forced logout keeps it open (FR-36). */}
          <ReportDialogMount />
        </AppErrorBoundary>
        <ThemedToaster />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

/** Sonner's own offsets, raised by the room the problem report's tray takes while it waits (FR-36). */
const TOAST_OFFSET = { bottom: 'calc(24px + var(--report-tray-space, 0px))' }
const TOAST_MOBILE_OFFSET = { bottom: 'calc(16px + var(--report-tray-space, 0px))' }

function ThemedToaster() {
  const dark = useTheme()
  return (
    <Toaster
      theme={dark ? 'dark' : 'light'}
      position="bottom-center"
      offset={TOAST_OFFSET}
      mobileOffset={TOAST_MOBILE_OFFSET}
      closeButton
    />
  )
}

/** Apply the persisted language override (FR-21). */
function useLanguageSync() {
  const language = useSettings((s) => s.language)
  useEffect(() => {
    // "auto" re-runs browser detection.
    void i18n.changeLanguage(language === 'auto' ? undefined : language)
  }, [language])
}

/** Session gate: loads /session and routes between login and the calendar. */
function Root() {
  const { t } = useTranslation()
  const { href, pathname, search } = useLocation()
  const session = useSession()
  const authenticated = session.data?.authenticated === true
  useLanguageSync()
  // 401 unauthenticated anywhere → back to login, remembering where we were.
  useUnauthenticatedRedirect()

  useEffect(() => {
    if (!session.data) return
    if (!authenticated && pathname !== '/login') navigate(loginPathFor(href), { replace: true })
    if (authenticated && pathname === '/login') navigate(safeRedirect(search.get('redirect')) ?? '/', { replace: true })
  }, [session.data, authenticated, pathname, href, search])

  if (session.isPending) return <Splash />
  if (session.isError) {
    return (
      <FullScreenMessage
        title={t('boot.unreachableTitle')}
        body={apiErrorMessage(t, session.error)}
        action={t('common.retry')}
        onAction={() => void session.refetch()}
      />
    )
  }
  return (
    <Suspense fallback={<Splash />}>
      {pathname === '/login' || !authenticated ? authenticated ? <Splash /> : <LoginPage /> : <CalendarPage />}
    </Suspense>
  )
}

function Splash() {
  const { t } = useTranslation()
  return (
    <div className="flex h-dvh items-center justify-center" role="status" aria-label={t('common.loading')}>
      <Logo className="size-10 animate-pulse motion-reduce:animate-none" />
    </div>
  )
}

function FullScreenMessage({
  title,
  body,
  action,
  onAction,
  children,
}: {
  title: string
  body: string
  action: string
  onAction: () => void
  children?: React.ReactNode
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8 text-center" role="alert">
      <Logo className="size-10" />
      <h1 className="font-display text-2xl font-semibold">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      <Button onClick={onAction}>
        <RefreshCwIcon aria-hidden />
        {action}
      </Button>
      {children}
    </div>
  )
}

/** Last line of defence (FR-19): never show a blank page, and fold below it what a bug report needs. */
export function AppErrorBoundary({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <ErrorBoundary
      onError={(error) => {
        console.error('unhandled render error', error)
      }}
      fallback={(error, reset) => (
        <FullScreenMessage
          title={t('boot.crashTitle')}
          body={t('boot.crashBody')}
          action={t('boot.reload')}
          onAction={() => {
            reset()
            window.location.reload()
          }}
        >
          <CrashDetails error={error} />
        </FullScreenMessage>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
