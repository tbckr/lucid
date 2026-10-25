import { afterEach, describe, expect, it } from 'vitest'
import { tileOf } from './tiles'

/** An element as the views draw it, put on the page: `attrs` set, `text` or `children` inside. */
function el(tag: string, attrs: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  node.append(...children)
  return node
}

function page(...nodes: HTMLElement[]) {
  document.body.replaceChildren(...nodes)
}

/** A task's tile: its checkbox, then its title, which opens and drags it. */
const taskTile = (key: string, title: string) =>
  el('div', { 'data-task-key': key }, el('button', { role: 'checkbox', 'aria-label': `Completed: ${title}` }), el('button', {}, title))

describe('tileOf (NFR-27)', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it("finds an event's tile", () => {
    const standup = el('button', { 'data-event-key': 'e1' }, 'Standup')
    page(el('button', { 'data-event-key': 'e2' }, 'Other'), standup)
    expect(tileOf('e1')).toBe(standup)
  })

  it("finds a task's title button", () => {
    const tile = taskTile('task:t1', 'Call')
    page(tile)
    expect(tileOf('task:t1')).toBe(tile.lastElementChild)
  })

  it('falls back to the bundle or more that holds it', () => {
    const bundle = el('button', { 'data-holds': 'a b' }, '2 tasks')
    page(bundle, el('button', { 'data-holds': 'ab' }, '1 more'))
    expect(tileOf('b')).toBe(bundle)
    expect(tileOf('c')).toBeNull()
  })

  it('prefers the tile to a bundle that holds it, and finds keys CSS would misread', () => {
    const key = 't1@2026-09-25T00:00:00Z'
    const bundle = el('button', { 'data-holds': `x ${key}` }, '2 tasks')
    const tile = taskTile(key, 'Water')
    page(bundle, tile)
    expect(tileOf(key)).toBe(tile.lastElementChild)
    tile.remove()
    expect(tileOf(key)).toBe(bundle)
  })
})
