import { describe, expect, it } from 'vitest'
import { detailPlacement, lastKnownBox } from './placement'

const desktop = { width: 1280, height: 800 }
const phone = { width: 390, height: 800 }

describe('detailPlacement', () => {
  it('opens beside a block that leaves room on either side', () => {
    // Week view: a block in the Friday column has room on its left only; Radix flips to it.
    const friday = { x: 900, y: 300, width: 130, height: 60 }
    expect(detailPlacement(friday, desktop)).toEqual({ side: 'right', rect: friday })
    const monday = { x: 490, y: 300, width: 130, height: 60 }
    expect(detailPlacement(monday, desktop)).toEqual({ side: 'right', rect: monday })
  })

  it('opens below the first line of a block as wide as the view', () => {
    // Day view: 390 px on the left and 130 px on the right are both less than the popover needs.
    const block = { x: 390, y: 560, width: 760, height: 120 }
    expect(detailPlacement(block, desktop)).toEqual({ side: 'bottom', rect: { x: 390, y: 560, width: 760, height: 40 } })
  })

  it('opens below an agenda row on a phone', () => {
    const row = { x: 16, y: 480, width: 358, height: 36 }
    expect(detailPlacement(row, phone)).toEqual({ side: 'bottom', rect: row })
  })

  it('points at the visible part of a block that sticks out of the view', () => {
    const allDay = { x: 390, y: -200, width: 1000, height: 900 }
    expect(detailPlacement(allDay, desktop)).toEqual({ side: 'bottom', rect: { x: 390, y: 0, width: 890, height: 40 } })
  })
})

describe('lastKnownBox', () => {
  it('follows the anchor and keeps its last box once it has left the page', () => {
    const anchor = { isConnected: true, getBoundingClientRect: () => ({ x: 10, y: 20, width: 30, height: 40 }) }
    const box = lastKnownBox(anchor)
    expect(box()).toEqual({ x: 10, y: 20, width: 30, height: 40 })
    anchor.getBoundingClientRect = () => ({ x: 10, y: 120, width: 30, height: 40 })
    expect(box()).toEqual({ x: 10, y: 120, width: 30, height: 40 })
    // Removed from the page: the browser reports an empty box at the corner.
    anchor.isConnected = false
    anchor.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 })
    expect(box()).toEqual({ x: 10, y: 120, width: 30, height: 40 })
  })
})
