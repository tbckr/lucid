import { useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type Scope = 'this' | 'all'

/**
 * Asks which events of a series a change is for (FR-17): just this one, or
 * all of them. One component used after dropping an occurrence, in the
 * editor's footer and before deleting, so the three look alike.
 *
 * Accessibility (NFR-27): `role="alertdialog"`, labelled by the question and
 * described by the note (or, without `allowAll`, by the reason it is
 * missing). Escape cancels. The initial focus is the smallest change -
 * "Only this event" - except when deleting, where it is "Cancel".
 */
export function ScopeChoice({
  question,
  note,
  tone = 'default',
  allowAll,
  onChoose,
  onCancel,
  onPreview,
}: {
  question: string
  /** What "All events" means beyond the obvious, where that is not obvious. */
  note?: string
  tone?: 'default' | 'destructive'
  /** Whether the series can follow the change at all (see `seriesShift`). */
  allowAll: boolean
  onChoose: (scope: Scope) => void
  onCancel: () => void
  /** Which choice is focused or under the pointer, so a preview can follow it. */
  onPreview?: (scope: Scope | null) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const thisRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (tone === 'destructive') cancelRef.current?.focus()
    else thisRef.current?.focus()
  }, [tone])

  const shownNote = allowAll ? note : t('event.scope.fixedDays')
  const preview = (scope: Scope) => ({
    onFocus: () => onPreview?.(scope),
    onMouseEnter: () => onPreview?.(scope),
    onBlur: () => onPreview?.(null),
    onMouseLeave: () => onPreview?.(null),
  })

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- an alertdialog catching Escape to cancel is the ARIA APG pattern (NFR-27); jsx-a11y doesn't treat the role as interactive.
    <div
      role="alertdialog"
      aria-labelledby={`${id}-question`}
      aria-describedby={shownNote ? `${id}-note` : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <p id={`${id}-question`} className="text-sm font-medium">
        {question}
      </p>
      {shownNote && (
        <p id={`${id}-note`} className="mt-1 text-[0.8125rem] text-muted-foreground">
          {shownNote}
        </p>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button ref={cancelRef} size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        {allowAll && (
          <Button
            size="sm"
            variant="outline"
            className={cn(tone === 'destructive' && 'border-destructive text-destructive')}
            onClick={() => onChoose('all')}
            {...preview('all')}
          >
            {t('event.scope.all')}
          </Button>
        )}
        <Button
          ref={thisRef}
          size="sm"
          variant={tone === 'destructive' ? 'destructive' : 'default'}
          onClick={() => onChoose('this')}
          {...preview('this')}
        >
          {t('event.scope.this')}
        </Button>
      </div>
    </div>
  )
}
