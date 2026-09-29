import { format, isSameDay } from 'date-fns'
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AppVersion } from '@/components/AppVersion'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formattingTag, usePrefs } from '@/hooks/usePrefs'
import { useNow } from '@/hooks/useNow'
import { dayKey, eachDay, VIEWS, visibleRange, type ViewKind } from '@/lib/dates'
import { formatTime, type FormatPrefs } from '@/lib/format'
import { browserLocale, detectHourCycle, detectWeekStart, pickLanguage } from '@/lib/locale'
import { cn } from '@/lib/utils'
import {
  useSettings,
  type LanguageSetting,
  type ThemeSetting,
  type TimeFormatSetting,
  type WeekStartSetting,
} from '@/stores/settings'
import { useUi } from '@/stores/ui'

const LANGUAGE_NAMES: Record<Exclude<LanguageSetting, 'auto'>, string> = { en: 'English', de: 'Deutsch' }
const WEEKDAY_KEY = { 0: 'sunday', 1: 'monday', 6: 'saturday' } as const

/**
 * User overrides for language and locale-derived formats (FR-21, FR-22). The
 * header shows this week as the settings format it, the way the editors show
 * their entry as it appears in the calendar; every choice is a switch that
 * shows its options at once.
 */
export function SettingsDialog() {
  const { t } = useTranslation()
  const open = useUi((s) => s.settingsOpen)
  const setOpen = useUi((s) => s.setSettingsOpen)
  const settings = useSettings()
  const prefs = usePrefs()
  const id = useId()
  const browser = browserLocale()
  // "Automatic" follows the locale used for formatting (browser, or the chosen language).
  const tag = formattingTag(settings.language, browser)
  const autoHc = detectHourCycle(tag)
  const autoWs = detectWeekStart(tag)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <header className="grid gap-4 border-b bg-background px-6 pt-5 pb-5">
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <Preview prefs={prefs} />
        </header>

        <div className="grid gap-6 px-6 pt-5 pb-6">
          <section aria-labelledby={`${id}-region`} className="grid gap-3">
            <div>
              <h3 id={`${id}-region`} className="font-display text-sm font-semibold">
                {t('settings.groups.region')}
              </h3>
              <p className="text-xs text-muted-foreground">{t('settings.autoHint')}</p>
            </div>
            <Choice
              label={t('settings.language')}
              value={settings.language}
              onChange={(v) => {
                settings.update({ language: v })
              }}
              options={[
                {
                  value: 'auto',
                  label: t('settings.automatic'),
                  name: t('settings.auto', { value: LANGUAGE_NAMES[pickLanguage(browser)] }),
                },
                { value: 'en', label: 'English', lang: 'en' },
                { value: 'de', label: 'Deutsch', lang: 'de' },
              ]}
            />
            <Choice<TimeFormatSetting>
              label={t('settings.timeFormat')}
              value={settings.timeFormat}
              onChange={(v) => {
                settings.update({ timeFormat: v })
              }}
              options={[
                { value: 'auto', label: t('settings.automatic'), name: t('settings.auto', { value: t(`settings.${autoHc}`) }) },
                // Examples of the format rather than words for it; the names say both.
                { value: '12h', label: '1:00 PM', name: t('settings.12h') },
                { value: '24h', label: '13:00', name: t('settings.24h') },
              ]}
            />
            <Choice
              label={t('settings.weekStart')}
              value={String(settings.weekStart)}
              onChange={(v) => {
                settings.update({ weekStart: (v === 'auto' ? 'auto' : Number(v)) as WeekStartSetting })
              }}
              options={[
                {
                  value: 'auto',
                  label: t('settings.automatic'),
                  name: t('settings.auto', { value: t(`weekdays.${WEEKDAY_KEY[autoWs]}`) }),
                },
                ...([1, 0, 6] as const).map((d) => ({
                  value: String(d),
                  label: t(`weekdaysShort.${WEEKDAY_KEY[d]}`),
                  name: t(`weekdays.${WEEKDAY_KEY[d]}`),
                })),
              ]}
            />
          </section>

          <section aria-labelledby={`${id}-display`} className="grid gap-3">
            <h3 id={`${id}-display`} className="font-display text-sm font-semibold">
              {t('settings.groups.display')}
            </h3>
            {/* The same switch as the views in the top bar. */}
            <Choice<ViewKind>
              label={t('settings.defaultView')}
              value={settings.defaultView}
              onChange={(v) => {
                settings.update({ defaultView: v })
              }}
              options={VIEWS.map((v) => ({ value: v, label: t(`views.${v}`) }))}
            />
            <Choice<ThemeSetting>
              label={t('settings.theme')}
              value={settings.theme}
              onChange={(v) => {
                settings.update({ theme: v })
              }}
              options={[
                { value: 'system', label: [<MonitorIcon key="i" aria-hidden />, t('settings.themeSystem')] },
                { value: 'light', label: [<SunIcon key="i" aria-hidden />, t('settings.themeLight')] },
                { value: 'dark', label: [<MoonIcon key="i" aria-hidden />, t('settings.themeDark')] },
              ]}
            />
            <Row label={<Label htmlFor={`${id}-completed`}>{t('settings.completedTasks')}</Label>}>
              <div className="flex h-8 items-center gap-2">
                <Switch
                  id={`${id}-completed`}
                  checked={settings.hideCompletedInCalendar}
                  onCheckedChange={(v) => {
                    settings.update({ hideCompletedInCalendar: v })
                  }}
                />
                <Label htmlFor={`${id}-completed`} className="font-normal">
                  {t('settings.hideInCalendar')}
                </Label>
              </div>
            </Row>
          </section>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-6 py-3">
          <DialogDescription className="text-xs">{t('settings.description')}</DialogDescription>
          <AppVersion />
        </footer>
      </DialogContent>
    </Dialog>
  )
}

/** This week as the settings format it: weekday names and first day, the date, and the time (FR-22). */
function Preview({ prefs }: { prefs: FormatPrefs }) {
  const { t } = useTranslation()
  const now = useNow()
  const days = eachDay(visibleRange('week', now, prefs.weekStartsOn))
  return (
    <figure aria-label={t('settings.preview')} className="grid gap-3">
      <ol className="grid grid-cols-7 text-center">
        {days.map((d) => (
          <li key={dayKey(d)} className="grid justify-items-center gap-1">
            <span className="text-xs text-muted-foreground">{format(d, 'EEE', { locale: prefs.locale })}</span>
            <span
              className={cn(
                'tabular flex size-7 items-center justify-center rounded-full text-sm',
                isSameDay(d, now) && 'bg-primary font-semibold text-primary-foreground',
              )}
            >
              {format(d, 'd')}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-sm">
        {new Intl.DateTimeFormat(prefs.tag, { dateStyle: 'full' }).format(now)}, {formatTime(now, prefs)}
      </p>
    </figure>
  )
}

interface Option<T extends string> {
  value: T
  label: ReactNode
  /** The accessible name where the label alone says less, e.g. what "Automatic" stands for. */
  name?: string
  lang?: string
}

/** A setting with few options, all shown at once as a switch. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
}) {
  const id = useId()
  return (
    <Row
      label={
        <span id={id} className="text-sm font-medium">
          {label}
        </span>
      }
    >
      <ToggleGroup
        type="single"
        aria-labelledby={id}
        value={value}
        onValueChange={(v) => {
          // Radix deselects on a second click (""); the setting stays.
          if (v) onChange(v as T)
        }}
        className="flex w-full"
      >
        {options.map((o) => (
          <ToggleGroupItem key={o.value} value={o.value} aria-label={o.name} lang={o.lang} className="flex-auto gap-1.5 px-2 [&_svg]:size-3.5">
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Row>
  )
}

/** Label and control side by side, stacked where the dialog is narrow. */
function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid items-center gap-x-3 gap-y-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
      {label}
      {children}
    </div>
  )
}
