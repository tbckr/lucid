import { type GlyphSlot } from '@/lib/scope'

/** The x of each of the five places; the middle one is the event acted on. */
const PLACES = [4, 13, 22, 31, 40]

/**
 * Which events of a series a change reaches, as five dots on a line (FR-17):
 * filled for an event it reaches, a ring for one it leaves as it is, and a
 * check for a task's repeat that is done and stays. The middle, larger dot is
 * the event acted on. Purely visual (`aria-hidden`): the text beside it says
 * the same in words (NFR-27).
 *
 * The dots it reaches take the series' calendar `color` (the text color
 * without one), or red when deleting; rings and checks are never red.
 * `inverted` draws it in the background color for the ink pill, the kept and
 * done ones fainter.
 */
export function ScopeGlyph({
  slots,
  color,
  tone = 'default',
  inverted = false,
  className,
}: {
  slots: GlyphSlot[]
  color?: string
  tone?: 'default' | 'destructive'
  inverted?: boolean
  className?: string
}) {
  const fill = inverted ? 'var(--background)' : tone === 'destructive' ? 'var(--destructive)' : (color ?? 'currentColor')
  const muted = inverted ? 'var(--background)' : 'var(--muted-foreground)'
  const faint = inverted ? 0.5 : undefined
  return (
    <svg width={44} height={10} viewBox="0 0 44 10" className={className} aria-hidden focusable="false">
      {slots.map((slot, i) => {
        const r = i === 2 ? 4 : 3
        const cx = PLACES[i] ?? 0
        switch (slot) {
          case 'affected':
            return <circle key={i} cx={cx} cy={5} r={r} fill={fill} />
          case 'kept':
            return (
              // The ring's stroke stays inside the dot's size.
              <circle
                key={i}
                cx={cx}
                cy={5}
                r={r - 0.75}
                fill="none"
                stroke={muted}
                strokeWidth={1.5}
                strokeOpacity={faint}
              />
            )
          case 'done':
            return (
              // A check 6px wide and 4px high, centred on the place.
              <path
                key={i}
                d={`M${cx - 3} 5L${cx - 1} 7L${cx + 3} 3`}
                fill="none"
                stroke={muted}
                strokeWidth={1.5}
                strokeOpacity={faint}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )
        }
      })}
    </svg>
  )
}
