import { useEffect } from 'react'
import { useSettings, type ThemeSetting } from '@/stores/settings'
import { useMediaQuery } from './useMediaQuery'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Whether the theme setting `theme` shows dark, where the system does (`systemDark`) for 'system'. */
function resolveDark(theme: ThemeSetting, systemDark: boolean): boolean {
  return theme === 'dark' || (theme === 'system' && systemDark)
}

/** Resolve the theme setting and apply the `dark` class to <html>. */
export function useTheme(): boolean {
  const theme = useSettings((s) => s.theme)
  const systemDark = useMediaQuery(DARK_QUERY)
  const dark = resolveDark(theme, systemDark)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])
  return dark
}

/** Read-only variant for components (does not touch the DOM). */
export function useIsDark(): boolean {
  const theme = useSettings((s) => s.theme)
  const systemDark = useMediaQuery(DARK_QUERY)
  return resolveDark(theme, systemDark)
}

/** Whether the app shows dark now, read once, without observing changes: for code outside a render, like a toast. */
export function isDarkNow(): boolean {
  return resolveDark(useSettings.getState().theme, window.matchMedia(DARK_QUERY).matches)
}
