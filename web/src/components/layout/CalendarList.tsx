import { EyeOffIcon, ListTodoIcon, LockIcon, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCalendars } from '@/hooks/queries'
import { cn } from '@/lib/utils'
import { useSettings } from '@/stores/settings'

/*
 * Calendar list with show/hide toggles (FR-04..06). A calendar leads with the
 * bar its events carry in the grid; a hidden one fades its bar and name and
 * shows the crossed-out eye, which a visible one previews on hover.
 */
export function CalendarList() {
  const { t } = useTranslation()
  const { data: calendars = [], isLoading, isError, refetch } = useCalendars()
  const hidden = useSettings((s) => s.hiddenCalendars)
  const toggle = useSettings((s) => s.toggleCalendar)

  return (
    <section aria-labelledby="calendars-heading" className="px-2">
      <h2 id="calendars-heading" className="px-2 pb-1 font-display text-sm font-semibold">
        {t('calendars.title')}
      </h2>
      {isLoading && (
        <p className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
          <Spinner /> {t('common.loading')}
        </p>
      )}
      {isError && (
        <p className="px-2 py-1 text-sm text-destructive">
          {t('calendars.loadFailed')}{' '}
          <button type="button" className="underline" onClick={() => void refetch()}>
            {t('common.retry')}
          </button>
        </p>
      )}
      {!isLoading && !isError && calendars.length === 0 && (
        <p className="px-2 py-1 text-sm text-muted-foreground">{t('calendars.empty')}</p>
      )}
      <ul className="grid gap-px">
        {calendars.map((c) => {
          const visible = !hidden.includes(c.id)
          return (
            <li key={c.id}>
              <label className="group grid cursor-pointer grid-cols-[1.125rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={visible}
                  onChange={() => {
                    toggle(c.id)
                  }}
                  data-testid={`calendar-toggle-${c.id}`}
                />
                {/* In the column of the task checks, like the bar of the list in the task sidebar. */}
                <span aria-hidden className="flex justify-center">
                  <span
                    className={cn('h-4 w-1 rounded-full transition-opacity', !visible && 'opacity-35')}
                    style={{ backgroundColor: c.color }}
                  />
                </span>
                <span className={cn('truncate', !visible && 'text-muted-foreground')}>{c.name}</span>
                <span className="flex items-center gap-1.5">
                  {!c.supportsEvents && <StatusIcon icon={ListTodoIcon} label={t('calendars.tasksOnly')} />}
                  {c.readOnly && <StatusIcon icon={LockIcon} label={t('calendars.readOnly')} />}
                  <EyeOffIcon
                    aria-hidden
                    className={cn(
                      'size-3.5 shrink-0 text-muted-foreground',
                      visible && 'opacity-0 group-hover:opacity-60 group-has-[:focus-visible]:opacity-60',
                    )}
                  />
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * Calendar property icon with its label as accessible name and hover tooltip.
 * The icon is not focusable: it sits inside the toggle's <label>, and screen
 * readers get the label through aria-label.
 */
function StatusIcon({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={label} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
