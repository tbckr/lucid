/**
 * Color helpers ensuring readable text on calendar colors (WCAG 2.1 AA).
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

export const FALLBACK_COLOR = '#4a45d6'

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m?.[1]) return null
  let h = m[1]
  if (h.length === 3) h = h.replace(/./g, '$&$&')
  const n = Number.parseInt(h, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

function channel(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance. */
export function luminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/** WCAG contrast ratio between two colors. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const INK: Rgb = { r: 17, g: 22, b: 32 }

/** Text color (near-black or white) with the higher contrast on `background`. */
const FALLBACK_RGB: Rgb = { r: 0x4a, g: 0x45, b: 0xd6 }

export function readableTextColor(background: string): string {
  const bg = parseHex(background) ?? FALLBACK_RGB
  return contrastRatio(bg, WHITE) >= contrastRatio(bg, INK) ? '#ffffff' : toHex(INK)
}

/** Linear mix of two colors; `amount` of `b` in [0, 1]. */
export function mix(a: string, b: string, amount: number): string {
  const ca = parseHex(a) ?? FALLBACK_RGB
  const cb = parseHex(b) ?? FALLBACK_RGB
  const t = Math.min(1, Math.max(0, amount))
  return toHex({ r: ca.r + (cb.r - ca.r) * t, g: ca.g + (cb.g - ca.g) * t, b: ca.b + (cb.b - ca.b) * t })
}

/**
 * Darken or lighten `color` until it reaches `ratio` contrast against
 * `background` (used for colored text such as timed chips on a tinted fill).
 */
export function ensureContrast(color: string, background: string, ratio = 4.5): string {
  const bg = parseHex(background) ?? WHITE
  const target = luminance(bg) > 0.4 ? '#000000' : '#ffffff'
  let current = color
  for (let i = 0; i <= 20; i++) {
    const rgb = parseHex(current)
    if (rgb && contrastRatio(rgb, bg) >= ratio) return current
    current = mix(color, target, i / 20)
  }
  return target
}

/** Style tokens for an event in a given calendar color and theme. */
export function eventColors(
  color: string,
  dark: boolean,
): { solid: string; onSolid: string; tint: string; onTint: string } {
  const rgb = parseHex(color)
  const solid = rgb ? toHex(rgb) : FALLBACK_COLOR
  const surface = dark ? '#181d28' : '#ffffff'
  const tint = mix(surface, solid, dark ? 0.28 : 0.16)
  return {
    solid,
    onSolid: readableTextColor(solid),
    tint,
    onTint: ensureContrast(mix(solid, dark ? '#ffffff' : '#000000', dark ? 0.55 : 0.45), tint, 4.5),
  }
}
