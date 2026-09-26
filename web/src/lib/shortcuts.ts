import { type ViewKind } from './dates'

export type ShortcutAction =
  | { type: 'today' }
  | { type: 'step'; dir: 1 | -1 }
  | { type: 'view'; view: ViewKind }
  | { type: 'create' }
  | { type: 'help' }
  | { type: 'toggleTasks' }

export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  target: EventTarget | null
}

/** Documented shortcuts, used by the help dialog. */
export const SHORTCUTS: { keys: string[]; labelKey: string }[] = [
  { keys: ['t'], labelKey: 'shortcuts.today' },
  { keys: ['j', '→'], labelKey: 'shortcuts.next' },
  { keys: ['k', '←'], labelKey: 'shortcuts.previous' },
  { keys: ['m'], labelKey: 'shortcuts.month' },
  { keys: ['w'], labelKey: 'shortcuts.week' },
  { keys: ['d'], labelKey: 'shortcuts.day' },
  { keys: ['a'], labelKey: 'shortcuts.agenda' },
  { keys: ['c'], labelKey: 'shortcuts.create' },
  { keys: ['g'], labelKey: 'shortcuts.tasks' },
  { keys: ['?'], labelKey: 'shortcuts.help' },
]

function isEditable(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object' || !('tagName' in target)) return false
  const el = target as HTMLElement
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (el.isContentEditable) return true
  const role = el.getAttribute('role')
  return role === 'textbox' || role === 'combobox' || role === 'listbox' || role === 'option'
}

/** Resolve a keydown to an app shortcut, or null when it should be ignored. */
export function resolveShortcut(e: KeyLike): ShortcutAction | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null
  if (isEditable(e.target)) return null
  switch (e.key) {
    case 't':
    case 'T':
      return { type: 'today' }
    case 'j':
    case 'n':
    case 'ArrowRight':
      return { type: 'step', dir: 1 }
    case 'k':
    case 'p':
    case 'ArrowLeft':
      return { type: 'step', dir: -1 }
    case 'm':
      return { type: 'view', view: 'month' }
    case 'w':
      return { type: 'view', view: 'week' }
    case 'd':
      return { type: 'view', view: 'day' }
    case 'a':
      return { type: 'view', view: 'agenda' }
    case 'c':
      return { type: 'create' }
    case 'g':
      return { type: 'toggleTasks' }
    case '?':
      return { type: 'help' }
    default:
      return null
  }
}
