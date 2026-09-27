import { CheckIcon, ListTodoIcon, LockIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@/components/ui/spinner'
import { useCalendars } from '@/hooks/queries'
import { readableTextColor } from '@/lib/color'
import { useSettings } from '@/stores/settings'

/** Calendar list with color swatches and show/hide toggles (FR-04..06). */
export function CalendarList() {
  const { t } = useTranslation()
  const { data: calendars = [], isLoading, isError, refetch } = useCalendars()
  const hidden = useSettings((s) => s.hiddenCalendars)
  const toggle = useSettings((s) => s.toggleCalendar)

  return (
    <section aria-labelledby="calendars-heading" className="px-3">
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
              <label className="group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={visible}
                  onChange={() => {
                    toggle(c.id)
                  }}
                  data-testid={`calendar-toggle-${c.id}`}
                />
                <span
                  aria-hidden
                  className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border-2"
                  style={{ borderColor: c.color, backgroundColor: visible ? c.color : 'transparent' }}
                >
                  {visible && <CheckIcon className="size-3" strokeWidth={3.5} style={{ color: readableTextColor(c.color) }} />}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {!c.supportsEvents && (
                  <ListTodoIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label={t('calendars.tasksOnly')} />
                )}
                {c.readOnly && (
                  <LockIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label={t('calendars.readOnly')} />
                )}
              </label>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
