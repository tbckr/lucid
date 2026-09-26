import { useEffect } from 'react'
import { useSettings } from '@/stores/settings'
import { useMediaQuery } from './useMediaQuery'

/** Resolve the theme setting and apply the `dark` class to <html>. */
export function useTheme(): boolean {
  const theme = useSettings((s) => s.theme)
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])
  return dark
}

/** Read-only variant for components (does not touch the DOM). */
export function useIsDark(): boolean {
  const theme = useSettings((s) => s.theme)
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  return theme === 'dark' || (theme === 'system' && systemDark)
}
