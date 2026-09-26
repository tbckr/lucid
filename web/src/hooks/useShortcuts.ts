import { useEffect } from 'react'
import { resolveShortcut, type ShortcutAction } from '@/lib/shortcuts'
import { isModalOpen, useUi } from '@/stores/ui'

/** Global keyboard shortcuts (NFR-27); suspended while dialogs are open. */
export function useShortcuts(handler: (action: ShortcutAction) => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isModalOpen(useUi.getState())) return
      // Popovers/menus (Radix) handle their own keys.
      if (e.target instanceof Element && e.target.closest('[data-radix-popper-content-wrapper]')) return
      const action = resolveShortcut(e)
      if (!action) return
      e.preventDefault()
      handler(action)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [handler])
}
