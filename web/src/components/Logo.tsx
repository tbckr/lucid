import { cn } from '@/lib/utils'

/** Lucid mark: a calendar page with a clear "lens" dot. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('shrink-0', className)} aria-hidden focusable="false">
      <rect x="2" y="4" width="28" height="26" rx="7" className="fill-primary" />
      <path d="M2 11a7 7 0 0 1 7-7h14a7 7 0 0 1 7 7v1H2z" className="fill-foreground/25" />
      <circle cx="21" cy="21" r="4.5" className="fill-surface" />
    </svg>
  )
}
