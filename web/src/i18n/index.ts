import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import { SUPPORTED_LANGUAGES } from '@/lib/locale'
import de from './locales/de.json'
import en from './locales/en.json'

export const resources = {
  en: { translation: en },
  de: { translation: de },
} as const

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    load: 'languageOnly',
    // The persisted setting (Zustand) decides overrides; detection only
    // looks at the browser and never writes cookies/localStorage.
    detection: { order: ['navigator', 'htmlTag'], caches: [] },
    interpolation: { escapeValue: false }, // React escapes output
    returnNull: false,
  })

function syncHtmlLang(lng: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lng
}
syncHtmlLang(i18n.resolvedLanguage ?? 'en')
i18n.on('languageChanged', syncHtmlLang)

export default i18n
