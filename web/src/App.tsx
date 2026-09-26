import { QueryClientProvider, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { RefreshCwIcon } from 'lucide-react'
import { lazy, Suspense, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { queryKeys, useSession } from '@/hooks/queries'
import { useTheme } from '@/hooks/useTheme'
import i18n from '@/i18n'
import { api } from '@/lib/api/client'
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
        </AppErrorBoundary>
        <ThemedToaster />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

function ThemedToaster() {
  const dark = useTheme()
  return <Toaster theme={dark ? 'dark' : 'light'} position="bottom-center" closeButton />
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
  const qc = useQueryClient()
  const { href, pathname, search } = useLocation()
  const session = useSession()
  const authenticated = session.data?.authenticated === true
  useLanguageSync()

  // 401 unauthenticated anywhere → back to login, remembering where we were.
  useEffect(
    () =>
      api.onUnauthenticated(() => {
        const current = window.location.pathname + window.location.search
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== queryKeys.session[0] })
        void qc.invalidateQueries({ queryKey: queryKeys.session })
        if (window.location.pathname !== '/login') navigate(loginPathFor(current), { replace: true })
      }),
    [qc],
  )

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
}: {
  title: string
  body: string
  action: string
  onAction: () => void
}) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 p-8 text-center" role="alert">
      <Logo className="size-10" />
      <h1 className="font-display text-2xl font-semibold">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      <Button onClick={onAction}>
        <RefreshCwIcon aria-hidden />
        {action}
      </Button>
    </div>
  )
}

/** Last line of defence (FR-19): never show a blank page. */
function AppErrorBoundary({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <ErrorBoundary
      onError={(error) => {
        console.error('unhandled render error', error)
      }}
      fallback={(_error, reset) => (
        <FullScreenMessage
          title={t('boot.crashTitle')}
          body={t('boot.crashBody')}
          action={t('boot.reload')}
          onAction={() => {
            reset()
            window.location.reload()
          }}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
