import { describe, expect, it } from 'vitest'
import { contrastRatio, ensureContrast, eventColors, mix, parseHex, readableTextColor, toHex } from './color'

describe('color', () => {
  it('parses and formats hex', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHex('3b82f6')).toEqual({ r: 59, g: 130, b: 246 })
    expect(parseHex('red')).toBeNull()
    expect(toHex({ r: 300, g: -5, b: 16.4 })).toBe('#ff0010')
  })

  it('computes WCAG contrast', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 0)
  })

  it('picks readable text on calendar colors (AA)', () => {
    for (const bg of ['#3b82f6', '#16a34a', '#facc15', '#e0692e', '#111111', '#ffffff', 'bogus']) {
      const fg = readableTextColor(bg)
      const ratio = contrastRatio(parseHex(bg) ?? parseHex('#4a45d6')!, parseHex(fg)!)
      expect(ratio).toBeGreaterThanOrEqual(3.5)
    }
    expect(readableTextColor('#facc15')).not.toBe('#ffffff')
    expect(readableTextColor('#1e3a8a')).toBe('#ffffff')
  })

  it('mixes colors', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#000000', '#ffffff', 2)).toBe('#ffffff')
    expect(mix('nope', 'nope', 0)).toBe('#4a45d6')
  })

  it('ensures contrast against a background', () => {
    const fg = ensureContrast('#facc15', '#ffffff', 4.5)
    expect(contrastRatio(parseHex(fg)!, parseHex('#ffffff')!)).toBeGreaterThanOrEqual(4.5)
    const dark = ensureContrast('#1e3a8a', '#181d28', 4.5)
    expect(contrastRatio(parseHex(dark)!, parseHex('#181d28')!)).toBeGreaterThanOrEqual(4.5)
    expect(ensureContrast('#000000', '#ffffff')).toBe('#000000')
  })

  it('derives accessible event colors in light and dark themes', () => {
    for (const dark of [false, true]) {
      for (const c of ['#3b82f6', '#facc15', '#16a34a', 'nonsense']) {
        const t = eventColors(c, dark)
        expect(contrastRatio(parseHex(t.onTint)!, parseHex(t.tint)!)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(parseHex(t.onSolid)!, parseHex(t.solid)!)).toBeGreaterThanOrEqual(3.5)
      }
    }
  })
})
