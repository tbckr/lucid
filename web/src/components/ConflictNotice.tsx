import { TriangleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** What an editor says once a save was refused as a conflict (FR-09): see `ConflictNotice`. */
export type ConflictState = 'replace' | 'reopen' | null

/**
 * Said in an editor's footer once a save was refused as a conflict (FR-09): with the item's current
 * version found, that the next save replaces the other change (`replace`), else how to see it
 * (`reopen`). A line of its own above the buttons, or the scope question that stands in for them;
 * on narrow screens, where the footer stacks, at its top. Save names it as its description, and a
 * status that is there before the conflict announces it (NFR-27).
 */
export function ConflictNotice({ id, state }: { id: string; state: ConflictState }) {
  const { t } = useTranslation()
  const text = state === null ? '' : t(state === 'replace' ? 'conflict.replace' : 'conflict.reopen')
  return (
    <>
      <span role="status" className="sr-only">
        {text}
      </span>
      {text && (
        // On the grid of the editor's rows (`EditorRow`): the icon in their icon column, the text on their fields.
        <p
          id={id}
          className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3 text-sm font-medium max-sm:order-last sm:order-first sm:basis-full"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          {text}
        </p>
      )}
    </>
  )
}
