import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { AppVersion } from '@/components/AppVersion'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { VIEWS, type ViewKind } from '@/lib/dates'
import { formattingTag } from '@/hooks/usePrefs'
import { browserLocale, detectHourCycle, detectWeekStart, pickLanguage } from '@/lib/locale'
import {
  useSettings,
  type LanguageSetting,
  type ThemeSetting,
  type TimeFormatSetting,
  type WeekStartSetting,
} from '@/stores/settings'
import { useUi } from '@/stores/ui'

const LANGUAGE_NAMES: Record<Exclude<LanguageSetting, 'auto'>, string> = { en: 'English', de: 'Deutsch' }

/** User overrides for language and locale-derived formats (FR-21, FR-22). */
export function SettingsDialog() {
  const { t } = useTranslation()
  const open = useUi((s) => s.settingsOpen)
  const setOpen = useUi((s) => s.setSettingsOpen)
  const settings = useSettings()
  const id = useId()
  const browser = browserLocale()
  // "Automatic" follows the locale used for formatting (browser, or the chosen language).
  const tag = formattingTag(settings.language, browser)
  const autoHc = detectHourCycle(tag)
  const autoWs = detectWeekStart(tag)
  const weekdayKey = { 0: 'sunday', 1: 'monday', 6: 'saturday' } as const

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogDescription>{t('settings.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field id={`${id}-lang`} label={t('settings.language')}>
            <Select
              value={settings.language}
              onValueChange={(v) => {
                settings.update({ language: v as LanguageSetting })
              }}
            >
              <SelectTrigger id={`${id}-lang`} data-testid="settings-language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  {t('settings.auto', { value: LANGUAGE_NAMES[pickLanguage(browser)] })}
                </SelectItem>
                <SelectItem value="en" lang="en">
                  English
                </SelectItem>
                <SelectItem value="de" lang="de">
                  Deutsch
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field id={`${id}-time`} label={t('settings.timeFormat')}>
            <Select
              value={settings.timeFormat}
              onValueChange={(v) => {
                settings.update({ timeFormat: v as TimeFormatSetting })
              }}
            >
              <SelectTrigger id={`${id}-time`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t('settings.auto', { value: t(`settings.${autoHc}`) })}</SelectItem>
                <SelectItem value="24h">{t('settings.24h')}</SelectItem>
                <SelectItem value="12h">{t('settings.12h')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field id={`${id}-week`} label={t('settings.weekStart')}>
            <Select
              value={String(settings.weekStart)}
              onValueChange={(v) => {
                settings.update({ weekStart: (v === 'auto' ? 'auto' : Number(v)) as WeekStartSetting })
              }}
            >
              <SelectTrigger id={`${id}-week`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t('settings.auto', { value: t(`weekdays.${weekdayKey[autoWs]}`) })}</SelectItem>
                <SelectItem value="1">{t('weekdays.monday')}</SelectItem>
                <SelectItem value="0">{t('weekdays.sunday')}</SelectItem>
                <SelectItem value="6">{t('weekdays.saturday')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field id={`${id}-view`} label={t('settings.defaultView')}>
            <Select
              value={settings.defaultView}
              onValueChange={(v) => {
                settings.update({ defaultView: v as ViewKind })
              }}
            >
              <SelectTrigger id={`${id}-view`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VIEWS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(`views.${v}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field id={`${id}-theme`} label={t('settings.theme')}>
            <Select
              value={settings.theme}
              onValueChange={(v) => {
                settings.update({ theme: v as ThemeSetting })
              }}
            >
              <SelectTrigger id={`${id}-theme`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">{t('settings.themeSystem')}</SelectItem>
                <SelectItem value="light">{t('settings.themeLight')}</SelectItem>
                <SelectItem value="dark">{t('settings.themeDark')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <AppVersion className="border-t pt-4" />
      </DialogContent>
    </Dialog>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-3">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}
