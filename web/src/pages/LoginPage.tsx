import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { format, isSameDay, isSameMonth } from 'date-fns'
import { CircleAlertIcon } from 'lucide-react'
import { startTransition, useActionState, useId } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { AppVersion } from '@/components/AppVersion'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { queryKeys } from '@/hooks/queries'
import { usePrefs } from '@/hooks/usePrefs'
import { endpoints } from '@/lib/api/endpoints'
import { dayKey, monthGrid } from '@/lib/dates'
import { apiErrorMessage } from '@/lib/errors'
import { weekdayNames, type FormatPrefs } from '@/lib/format'
import { loginSchema, type LoginValues } from '@/lib/loginForm'
import { safeRedirect } from '@/lib/redirect'
import { navigate, useLocation } from '@/lib/router'
import { cn } from '@/lib/utils'
import { useSettings } from '@/stores/settings'

interface LoginState {
  error: string | null
}

export function LoginPage() {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const qc = useQueryClient()
  const { search } = useLocation()
  const lastServerUrl = useSettings((s) => s.lastServerUrl)
  const updateSettings = useSettings((s) => s.update)
  const id = useId()

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { serverUrl: lastServerUrl, username: '', password: '' },
  })
  const { register, handleSubmit, formState, resetField } = form

  // React 19 action state: pending flag + last error without extra useState.
  const [state, login, pending] = useActionState<LoginState, LoginValues>(async (_prev, values) => {
    try {
      const session = await endpoints.login(values)
      updateSettings({ lastServerUrl: values.serverUrl.trim() })
      qc.setQueryData(queryKeys.session, session)
      navigate(safeRedirect(search.get('redirect')) ?? '/', { replace: true })
      return { error: null }
    } catch (err) {
      resetField('password')
      return { error: apiErrorMessage(t, err) }
    }
  }, { error: null })

  const onSubmit = handleSubmit((values) => {
    startTransition(() => {
      login(values)
    })
  })

  const fieldError = (name: keyof LoginValues) => {
    const m = formState.errors[name]?.message
    return m ? t(m as 'login.validation.serverRequired') : undefined
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.1fr)_minmax(26rem,1fr)]">
      <MonthPoster prefs={prefs} />

      <main className="flex items-center justify-center bg-surface px-6 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <div className="mb-10 flex items-center gap-2.5 lg:hidden">
            <Logo className="size-8" />
            <span className="font-display text-xl font-semibold tracking-tight">Lucid</span>
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">{t('login.title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('login.subtitle')}</p>

          <form onSubmit={(e) => void onSubmit(e)} noValidate className="mt-8 grid gap-5" aria-describedby={state.error ? `${id}-error` : undefined}>
            {state.error && (
              <div
                id={`${id}-error`}
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/8 px-3.5 py-3 text-sm text-destructive"
              >
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{state.error}</span>
              </div>
            )}

            <Field id={`${id}-server`} label={t('login.serverUrl')} error={fieldError('serverUrl')} hint={t('login.serverHint')}>
              <Input
                id={`${id}-server`}
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                autoCapitalize="none"
                placeholder="https://cloud.example.com"
                aria-invalid={formState.errors.serverUrl ? true : undefined}
                aria-describedby={formState.errors.serverUrl ? `${id}-server-error` : `${id}-server-hint`}
                {...register('serverUrl')}
              />
            </Field>
            <Field id={`${id}-user`} label={t('login.username')} error={fieldError('username')}>
              <Input
                id={`${id}-user`}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={formState.errors.username ? true : undefined}
                aria-describedby={formState.errors.username ? `${id}-user-error` : undefined}
                {...register('username')}
              />
            </Field>
            <Field id={`${id}-pass`} label={t('login.password')} error={fieldError('password')}>
              <Input
                id={`${id}-pass`}
                type="password"
                autoComplete="current-password"
                aria-invalid={formState.errors.password ? true : undefined}
                aria-describedby={formState.errors.password ? `${id}-pass-error` : undefined}
                {...register('password')}
              />
            </Field>

            <Button type="submit" size="lg" className="mt-2 h-11" disabled={pending}>
              {pending && <Spinner />}
              {pending ? t('login.submitting') : t('login.submit')}
            </Button>
          </form>
          <p className="mt-8 text-xs leading-relaxed text-muted-foreground">{t('login.privacy')}</p>
          <AppVersion className="mt-3" />
        </div>
      </main>
    </div>
  )
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string
  label: string
  error: string | undefined
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** The current month set as a typographic poster: the brand moment of the login screen. */
function MonthPoster({ prefs }: { prefs: FormatPrefs }) {
  const now = new Date()
  const weeks = monthGrid(now, prefs.weekStartsOn)
  const names = weekdayNames(prefs, 'narrow')
  return (
    <section
      aria-hidden
      className="relative hidden overflow-hidden bg-background px-14 py-12 lg:flex lg:flex-col lg:justify-between"
    >
      <div className="flex items-center gap-2.5">
        <Logo className="size-8" />
        <span className="font-display text-xl font-semibold tracking-tight">Lucid</span>
      </div>
      <div className="max-w-xl">
        <p className="font-display text-[clamp(3.5rem,7vw,6.5rem)] leading-[0.9] font-bold tracking-[-0.04em]">
          {format(now, 'LLLL', { locale: prefs.locale })}
        </p>
        <div className="mt-8 grid grid-cols-7 gap-y-1 font-display">
          {names.map((n, i) => (
            <span key={`h${i}`} className="pb-2 text-sm font-medium text-muted-foreground">
              {n}
            </span>
          ))}
          {weeks.flat().map((d) => (
            <span
              key={dayKey(d)}
              className={cn(
                'tabular flex size-[clamp(2.25rem,3.6vw,3.25rem)] items-center justify-center rounded-full text-[clamp(1rem,1.7vw,1.5rem)] font-semibold',
                !isSameMonth(d, now) && 'text-muted-foreground/40 font-normal',
                isSameDay(d, now) && 'bg-primary text-primary-foreground',
              )}
            >
              {format(d, 'd')}
            </span>
          ))}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{format(now, 'yyyy', { locale: prefs.locale })}</p>
    </section>
  )
}
