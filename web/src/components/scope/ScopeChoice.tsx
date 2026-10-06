import { useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { glyphSlots, type Scope, type ScopeItem } from '@/lib/scope'
import { ScopeGlyph } from './ScopeGlyph'

/**
 * Asks which events of a series a change is for (FR-17). One option per row,
 * from the smallest reach down to the largest, each with its reach as dots
 * and a line on what it reaches; a click or Enter on a row chooses it. One
 * component used after dropping an occurrence, in the editor's footer and
 * before deleting, so the three look alike.
 *
 * Accessibility (NFR-27): `role="alertdialog"`, labelled by the question.
 * Each row is named by its label and described by its line. Escape cancels.
 * The initial focus is the first row, the smallest change, except when
 * deleting, where it is "Cancel".
 */
export function ScopeChoice({
  question,
  items,
  color,
  tone = 'default',
  onChoose,
  onCancel,
  onPreview,
}: {
  question: string
  /** The options, smallest reach first (`eventScopeItems`). */
  items: ScopeItem[]
  /** The series' calendar color, for the dots of the events an option reaches. */
  color: string
  /** `destructive` when deleting: the dots of the events an option reaches are red. */
  tone?: 'default' | 'destructive'
  onChoose: (scope: Scope) => void
  onCancel: () => void
  /** Which option is focused or under the pointer, so a preview can follow it. */
  onPreview?: (scope: Scope | null) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (tone === 'destructive') cancelRef.current?.focus()
    else firstRef.current?.focus()
  }, [tone])

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- an alertdialog catching Escape to cancel is the ARIA APG pattern (NFR-27); jsx-a11y doesn't treat the role as interactive.
    <div
      role="alertdialog"
      aria-labelledby={`${id}-question`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <p id={`${id}-question`} className="text-sm font-medium">
        {question}
      </p>
      <div className="mt-3 divide-y divide-border overflow-hidden rounded-md border border-border">
        {items.map((item, i) => (
          // type="button": without it, a plain <button> defaults to "submit" and, inside the
          // editor's <form>, would also submit it (re-asking or saving a second time).
          <button
            key={item.scope}
            ref={i === 0 ? firstRef : undefined}
            type="button"
            aria-labelledby={`${id}-${item.scope}`}
            aria-describedby={`${id}-${item.scope}-note`}
            className="grid w-full grid-cols-[2.75rem_1fr] items-center gap-x-3 px-3 py-2 text-left transition-colors outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={() => {
              onChoose(item.scope)
            }}
            onFocus={() => onPreview?.(item.scope)}
            onMouseEnter={() => onPreview?.(item.scope)}
            onBlur={() => onPreview?.(null)}
            onMouseLeave={() => onPreview?.(null)}
          >
            <ScopeGlyph slots={glyphSlots(item.scope)} color={color} tone={tone} />
            <span id={`${id}-${item.scope}`} className="text-sm font-medium">
              {item.label}
            </span>
            <span id={`${id}-${item.scope}-note`} className="col-start-2 text-[0.8125rem] text-muted-foreground">
              {item.note}
            </span>
          </button>
        ))}
      </div>
      <div className="mt-2 flex justify-end">
        <Button ref={cancelRef} type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
