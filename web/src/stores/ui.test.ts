import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toCalEvent } from '@/lib/events'
import { apiEvent, todo } from '@/test/fixtures'
import { useUi, type OverflowState } from './ui'

function openedOverflow(): OverflowState {
  const home = document.createElement('div')
  const anchor = document.createElement('button')
  home.append(anchor)
  return {
    id: 'more:2026-09-25',
    day: new Date(2026, 8, 25),
    items: [toCalEvent(apiEvent())],
    drag: 'event',
    anchor,
    home,
    rect: new DOMRect(10, 20, 30, 40),
  }
}

describe('overflow (FR-07)', () => {
  beforeEach(() => {
    useUi.getState().openOverflow(openedOverflow())
    expect(useUi.getState().overflow).not.toBeNull()
  })
  afterEach(() => {
    useUi.setState({ overflow: null, editor: null, taskEditor: null })
  })

  it('opens and closes with the state it is given', () => {
    const state = openedOverflow()
    useUi.getState().openOverflow(state)
    expect(useUi.getState().overflow).toBe(state)
    useUi.getState().openOverflow(null)
    expect(useUi.getState().overflow).toBeNull()
  })

  describe('closes when the date or view changes', () => {
    it('on setDate', () => {
      useUi.getState().setDate(new Date(2026, 9, 1))
      expect(useUi.getState().overflow).toBeNull()
    })

    it('on setView', () => {
      useUi.getState().setView('week')
      expect(useUi.getState().overflow).toBeNull()
    })

    it('on openCreate', () => {
      useUi.getState().openCreate(null)
      expect(useUi.getState().overflow).toBeNull()
    })

    it('on openEditor', () => {
      useUi.getState().openEditor({ mode: 'edit', event: toCalEvent(apiEvent()) })
      expect(useUi.getState().overflow).toBeNull()
    })

    it('on openTaskEditor', () => {
      useUi.getState().openTaskEditor({ mode: 'edit', todo: todo() })
      expect(useUi.getState().overflow).toBeNull()
    })
  })
})
