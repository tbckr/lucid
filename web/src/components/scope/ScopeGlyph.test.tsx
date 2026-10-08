import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { glyphSlots, taskGlyphSlots } from '@/lib/scope'
import { ScopeGlyph } from './ScopeGlyph'

/** The five dots of a glyph, earliest first. */
function dots(container: HTMLElement): SVGCircleElement[] {
  return Array.from(container.querySelectorAll('circle'))
}

describe('ScopeGlyph', () => {
  it('draws the reach of each scope', () => {
    expect(glyphSlots('this')).toEqual(['kept', 'kept', 'affected', 'kept', 'kept'])
    expect(glyphSlots('following')).toEqual(['kept', 'kept', 'affected', 'affected', 'affected'])
    expect(glyphSlots('all')).toEqual(['affected', 'affected', 'affected', 'affected', 'affected'])
  })

  it('draws five dots on a line, the middle one larger, hidden from screen readers', () => {
    const { container } = render(<ScopeGlyph slots={glyphSlots('all')} color="#3b82f6" />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('width', '44')
    expect(svg).toHaveAttribute('height', '10')
    expect(dots(container).map((c) => [c.getAttribute('cx'), c.getAttribute('cy'), c.getAttribute('r')])).toEqual([
      ['4', '5', '3'],
      ['13', '5', '3'],
      ['22', '5', '4'],
      ['31', '5', '3'],
      ['40', '5', '3'],
    ])
  })

  it('fills the events a change reaches in the series color, and rings the ones it keeps', () => {
    const { container } = render(<ScopeGlyph slots={glyphSlots('this')} color="#3b82f6" />)
    const [kept, , affected] = dots(container)
    expect(affected).toHaveAttribute('fill', '#3b82f6')
    expect(kept).toHaveAttribute('fill', 'none')
    expect(kept).toHaveAttribute('stroke', 'var(--muted-foreground)')
    expect(kept).toHaveAttribute('stroke-width', '1.5')
    // A ring's stroke stays within the dot's size: r - 0.75.
    expect(kept).toHaveAttribute('r', '2.25')
  })

  it('fills them red when deleting', () => {
    const { container } = render(<ScopeGlyph slots={glyphSlots('this')} color="#3b82f6" tone="destructive" />)
    const [kept, , affected] = dots(container)
    expect(affected).toHaveAttribute('fill', 'var(--destructive)')
    expect(kept).toHaveAttribute('stroke', 'var(--muted-foreground)')
  })

  it('draws in the background color inside the ink pill, the kept ones fainter', () => {
    const { container } = render(<ScopeGlyph slots={glyphSlots('this')} color="#3b82f6" inverted />)
    const [kept, , affected] = dots(container)
    expect(affected).toHaveAttribute('fill', 'var(--background)')
    expect(kept).toHaveAttribute('stroke', 'var(--background)')
    expect(kept).toHaveAttribute('stroke-opacity', '0.5')
  })

  describe('a done repeat (FR-17)', () => {
    /** The checks of a glyph, earliest first. */
    function checks(container: HTMLElement): SVGPathElement[] {
      return Array.from(container.querySelectorAll('path'))
    }

    it('draws a done repeat as a 6px check in its place', () => {
      const { container } = render(<ScopeGlyph slots={taskGlyphSlots('all', 'upcoming')} color="#3b82f6" />)
      const [check, ...rest] = checks(container)
      expect(rest).toHaveLength(0)
      // A check spanning 6px around the first place, x = 4, centred on the line.
      expect(check).toHaveAttribute('d', 'M1 5L3 7L7 3')
      expect(check).toHaveAttribute('fill', 'none')
      expect(check).toHaveAttribute('stroke', 'var(--muted-foreground)')
      expect(check).toHaveAttribute('stroke-width', '1.5')
      // The other four places are dots.
      expect(dots(container).map((c) => c.getAttribute('cx'))).toEqual(['13', '22', '31', '40'])
    })

    it('draws checks in their places', () => {
      const { container } = render(<ScopeGlyph slots={taskGlyphSlots('this', 'current')} color="#3b82f6" />)
      expect(checks(container).map((p) => p.getAttribute('d'))).toEqual(['M1 5L3 7L7 3', 'M10 5L12 7L16 3'])
    })

    it('never draws a check in red', () => {
      const { container } = render(<ScopeGlyph slots={taskGlyphSlots('all', 'current')} color="#3b82f6" tone="destructive" />)
      for (const check of checks(container)) expect(check).toHaveAttribute('stroke', 'var(--muted-foreground)')
      expect(dots(container)[0]).toHaveAttribute('fill', 'var(--destructive)')
    })

    it('draws a check in the background color inside the ink pill, fainter', () => {
      const { container } = render(<ScopeGlyph slots={taskGlyphSlots('all', 'current')} color="#3b82f6" inverted />)
      const [check] = checks(container)
      expect(check).toHaveAttribute('stroke', 'var(--background)')
      expect(check).toHaveAttribute('stroke-opacity', '0.5')
    })
  })
})
