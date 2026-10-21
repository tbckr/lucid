import { describe, expect, it } from 'vitest'
import { monthWheel, scrollParent, scrollRoom, type ScrollRoom, type WheelLike } from './wheel'

const wheel = (timeStamp: number, deltaY: number, p: Partial<WheelLike> = {}): WheelLike => ({
  deltaX: 0,
  deltaY,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  timeStamp,
  ...p,
})

const fits: ScrollRoom = { up: false, down: false }

describe('monthWheel', () => {
  it('steps forward on a downward scroll and back on an upward one', () => {
    const onWheel = monthWheel()
    expect(onWheel(wheel(0, 100), fits)).toEqual({ step: 1, swallow: true })
    expect(onWheel(wheel(1000, -4), fits)).toEqual({ step: -1, swallow: true })
  })

  it('steps once per gesture, however long its momentum runs or wherever it turns', () => {
    const onWheel = monthWheel()
    const steps = [120, 80, 50, 30, 12, 4, 1, -3, -40].map((dy, i) => onWheel(wheel(i * 16, dy), fits))
    expect(steps.map((s) => s.step)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('starts a new gesture after a pause', () => {
    const onWheel = monthWheel()
    expect(onWheel(wheel(0, 100), fits).step).toBe(1)
    expect(onWheel(wheel(100, 100), fits).step).toBe(0)
    expect(onWheel(wheel(200, 100), fits).step).toBe(0)
    expect(onWheel(wheel(450, 100), fits).step).toBe(1)
  })

  it('leaves zooming and sideways scrolling to the browser', () => {
    const onWheel = monthWheel()
    const none = { step: 0, swallow: false }
    expect(onWheel(wheel(0, 100, { ctrlKey: true }), fits)).toEqual(none)
    expect(onWheel(wheel(0, 100, { metaKey: true }), fits)).toEqual(none)
    expect(onWheel(wheel(0, 100, { shiftKey: true }), fits)).toEqual(none)
    expect(onWheel(wheel(0, 100, { altKey: true }), fits)).toEqual(none)
    expect(onWheel(wheel(0, 10, { deltaX: 30 }), fits)).toEqual(none)
    expect(onWheel(wheel(0, 0), fits)).toEqual(none)
    // None of them took up the gesture.
    expect(onWheel(wheel(16, 100), fits).step).toBe(1)
  })

  it('does not swallow a sideways swipe after a step, which may be the browser going back', () => {
    const onWheel = monthWheel()
    expect(onWheel(wheel(0, 100), fits).step).toBe(1)
    expect(onWheel(wheel(16, 5, { deltaX: 60 }), fits)).toEqual({ step: 0, swallow: false })
  })

  it('swallows the rest of a gesture that stepped, so its momentum does not scroll the new month', () => {
    const onWheel = monthWheel()
    expect(onWheel(wheel(0, 100), fits).step).toBe(1)
    expect(onWheel(wheel(16, 80), { up: false, down: true })).toEqual({ step: 0, swallow: true })
  })

  it('scrolls a month taller than its window first, and steps only with a new gesture at its edge', () => {
    const onWheel = monthWheel()
    expect(onWheel(wheel(0, 100), { up: false, down: true })).toEqual({ step: 0, swallow: false })
    // The same gesture reaches the bottom: it stays a scroll.
    expect(onWheel(wheel(16, 100), { up: true, down: false })).toEqual({ step: 0, swallow: false })
    expect(onWheel(wheel(400, 100), { up: true, down: false })).toEqual({ step: 1, swallow: true })
    expect(onWheel(wheel(800, -100), { up: true, down: false })).toEqual({ step: 0, swallow: false })
    expect(onWheel(wheel(1200, -100), { up: false, down: true })).toEqual({ step: -1, swallow: true })
  })
})

describe('scrollRoom', () => {
  const box = (scrollTop: number, clientHeight: number, scrollHeight: number) => {
    const el = document.createElement('div')
    Object.defineProperties(el, {
      scrollTop: { value: scrollTop },
      clientHeight: { value: clientHeight },
      scrollHeight: { value: scrollHeight },
    })
    return el
  }

  it('tells which ways the container can still scroll', () => {
    expect(scrollRoom(box(0, 500, 500))).toEqual({ up: false, down: false })
    expect(scrollRoom(box(0, 500, 700))).toEqual({ up: false, down: true })
    expect(scrollRoom(box(100, 500, 700))).toEqual({ up: true, down: true })
    expect(scrollRoom(box(200, 500, 700))).toEqual({ up: true, down: false })
    // Zoomed displays scroll by fractions of a pixel and stop short of the end.
    expect(scrollRoom(box(199.5, 500, 700))).toEqual({ up: true, down: false })
    expect(scrollRoom(null)).toEqual({ up: false, down: false })
  })
})

describe('scrollParent', () => {
  it('finds the nearest ancestor that scrolls vertically', () => {
    const outer = document.createElement('div')
    outer.style.overflowY = 'auto'
    const sideways = document.createElement('div')
    sideways.style.overflowX = 'auto'
    sideways.style.overflowY = 'hidden'
    const el = document.createElement('div')
    outer.append(sideways)
    sideways.append(el)
    document.body.append(outer)
    expect(scrollParent(el)).toBe(outer)
    outer.style.overflowY = 'scroll'
    expect(scrollParent(el)).toBe(outer)
    outer.style.overflowY = 'visible'
    expect(scrollParent(el)).toBeNull()
    outer.remove()
  })
})
