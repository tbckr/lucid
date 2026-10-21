import { TriangleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/**
 * Said in an editor's footer once a save was refused as a conflict (FR-09): with the item's current
 * version `found`, that the next save replaces the other change, else how to see it. A line of its
 * own above the buttons, or the scope question that stands in for them; on narrow screens, where
 * the footer stacks, at its top. Save names it as its description (NFR-27).
 */
export function ConflictNotice({ id, found, className }: { id: string; found: boolean; className?: string }) {
  const { t } = useTranslation()
  return (
    // On the grid of the editor's rows (`EditorRow`): the icon in their icon column, the text on their fields.
    <p
      id={id}
      className={cn(
        'grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3 text-sm font-medium max-sm:order-last sm:order-first sm:basis-full',
        className,
      )}
    >
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      {found ? t('conflict.replace') : t('conflict.reopen')}
    </p>
  )
}
