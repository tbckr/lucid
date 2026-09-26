import { describe, expect, it } from 'vitest'
import { resolveShortcut, SHORTCUTS, type KeyLike } from './shortcuts'

const key = (k: string, p: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  defaultPrevented: false,
  target: document.body,
  ...p,
})

describe('resolveShortcut', () => {
  it.each([
    ['t', { type: 'today' }],
    ['j', { type: 'step', dir: 1 }],
    ['ArrowRight', { type: 'step', dir: 1 }],
    ['k', { type: 'step', dir: -1 }],
    ['ArrowLeft', { type: 'step', dir: -1 }],
    ['m', { type: 'view', view: 'month' }],
    ['w', { type: 'view', view: 'week' }],
    ['d', { type: 'view', view: 'day' }],
    ['a', { type: 'view', view: 'agenda' }],
    ['c', { type: 'create' }],
    ['g', { type: 'toggleTasks' }],
    ['?', { type: 'help' }],
  ])('%s', (k, action) => {
    expect(resolveShortcut(key(k))).toEqual(action)
  })

  it('ignores modifiers, handled events, unknown keys and editable targets', () => {
    expect(resolveShortcut(key('t', { ctrlKey: true }))).toBeNull()
    expect(resolveShortcut(key('t', { metaKey: true }))).toBeNull()
    expect(resolveShortcut(key('t', { altKey: true }))).toBeNull()
    expect(resolveShortcut(key('t', { defaultPrevented: true }))).toBeNull()
    expect(resolveShortcut(key('x'))).toBeNull()
    for (const tag of ['input', 'textarea', 'select']) {
      expect(resolveShortcut(key('t', { target: document.createElement(tag) }))).toBeNull()
    }
    const div = document.createElement('div')
    div.setAttribute('role', 'combobox')
    expect(resolveShortcut(key('t', { target: div }))).toBeNull()
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(resolveShortcut(key('t', { target: editable }))).toBeNull()
    expect(resolveShortcut(key('t', { target: null }))).toEqual({ type: 'today' })
  })

  it('documents every shortcut', () => {
    expect(SHORTCUTS.length).toBeGreaterThanOrEqual(10)
  })
})
