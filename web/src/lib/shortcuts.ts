import { type ViewKind } from './dates'

export type ShortcutAction =
  | { type: 'today' }
  | { type: 'step'; dir: 1 | -1 }
  | { type: 'view'; view: ViewKind }
  | { type: 'create' }
  | { type: 'help' }
  | { type: 'toggleTasks' }
  | { type: 'refresh' }

export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  repeat: boolean
  target: EventTarget | null
}

export type ShortcutGroup = 'navigate' | 'views' | 'actions'

/**
 * Documented shortcuts, used by the help dialog. Any of `keys` does the same,
 * unless `sequence` has them pressed one after the other (moving an event is
 * dnd-kit's keyboard sensor, not an app shortcut).
 */
export const SHORTCUTS: { keys: string[]; labelKey: string; group: ShortcutGroup; sequence?: boolean }[] = [
  { keys: ['t'], labelKey: 'shortcuts.today', group: 'navigate' },
  { keys: ['j', '→'], labelKey: 'shortcuts.next', group: 'navigate' },
  { keys: ['k', '←'], labelKey: 'shortcuts.previous', group: 'navigate' },
  { keys: ['m'], labelKey: 'shortcuts.month', group: 'views' },
  { keys: ['w'], labelKey: 'shortcuts.week', group: 'views' },
  { keys: ['d'], labelKey: 'shortcuts.day', group: 'views' },
  { keys: ['a'], labelKey: 'shortcuts.agenda', group: 'views' },
  { keys: ['g'], labelKey: 'shortcuts.tasks', group: 'views' },
  { keys: ['c'], labelKey: 'shortcuts.create', group: 'actions' },
  { keys: ['r'], labelKey: 'shortcuts.refresh', group: 'actions' },
  { keys: ['Space', '←↑→↓'], labelKey: 'shortcuts.moveEvent', group: 'actions', sequence: true },
  { keys: ['?'], labelKey: 'shortcuts.help', group: 'actions' },
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
    case 'r':
    case 'R':
      // Once per press: a held key would refresh again and again.
      return e.repeat ? null : { type: 'refresh' }
    case 'g':
      return { type: 'toggleTasks' }
    case '?':
      return { type: 'help' }
    default:
      return null
  }
}
