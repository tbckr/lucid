import { PencilIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { splitLinks } from '@/lib/links'
import { detailPlacement, lastKnownBox, type Box } from '@/lib/placement'

/*
 * Parts of the details popovers of events (FR-09) and tasks (FR-16): the
 * popover beside the item, the close button of the tinted header, the rows
 * with an icon column, and the footer that edits or deletes.
 */

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })

/**
 * Popover content at the item's block; focus goes to `initialFocus` and back
 * to the block (or `returnFocus`) on close. `measure` points it at a part of
 * `anchor`, such as the slot of a new event in a day column. A press or focus
 * beside it closes it unless `onInteractOutside` prevents that.
 */
export function DetailContent({
  anchor,
  measure,
  returnFocus,
  label,
  initialFocus,
  onInteractOutside,
  children,
}: {
  anchor: HTMLElement
  measure?: (() => Box) | undefined
  returnFocus?: HTMLElement | undefined
  label: string
  initialFocus: () => HTMLElement | null
  onInteractOutside?: ComponentProps<typeof PopoverContent>['onInteractOutside']
  children: ReactNode
}) {
  // Radix measures the anchor again on scroll and resize; the side stays the one it opened on.
  const { side, virtualRef } = useMemo(() => {
    const box = measure ?? lastKnownBox(anchor)
    return {
      side: detailPlacement(box(), viewport()).side,
      virtualRef: {
        current: { getBoundingClientRect: () => DOMRect.fromRect(detailPlacement(box(), viewport()).rect) },
      },
    }
  }, [anchor, measure])
  return (
    <>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        className="w-[min(24rem,calc(100vw-2rem))] overflow-hidden p-0"
        side={side}
        align="start"
        aria-label={label}
        onInteractOutside={onInteractOutside}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          initialFocus()?.focus()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          // Radix returns the focus a tick after the close. By then, a popover that
          // opened in this one's place has the focus and would close if it left.
          const focused = document.activeElement
          if (focused && focused !== document.body) return
          const target = returnFocus ?? anchor
          if (target.isConnected) target.focus()
        }}
      >
        {children}
      </PopoverContent>
    </>
  )
}

/** Close button in the corner of the tinted header. */
export function DetailClose({ ref, onClose }: { ref: Ref<HTMLButtonElement>; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      ref={ref}
      type="button"
      aria-label={t('common.close')}
      onClick={onClose}
      className="absolute top-3 right-3 rounded-md p-1.5 transition-colors outline-none hover:bg-current/10 focus-visible:ring-[3px] focus-visible:ring-current/50 [&_svg]:size-4"
    >
      <XIcon aria-hidden />
    </button>
  )
}

export function DetailRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1.25rem_1fr] items-start gap-3">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Plain text whose web addresses are links: elements, never HTML (NFR-29). */
export function Linked({ text }: { text: string }) {
  return splitLinks(text).map((part, i) =>
    part.href ? (
      <a
        key={i}
        href={part.href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {part.text}
      </a>
    ) : (
      part.text
    ),
  )
}

/** Delete and edit; deleting asks in place first. */
export function DetailActions({
  editRef,
  editLabel,
  deleteLabel,
  confirm,
  onEdit,
  onDelete,
}: {
  editRef: Ref<HTMLButtonElement>
  editLabel: string
  deleteLabel: string
  /** The question before deleting. */
  confirm: string
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const asked = useRef(false)

  useEffect(() => {
    // The footer asks in place: focus its "Cancel", and the delete button again once it is back (NFR-27).
    if (confirming) keepRef.current?.focus()
    else if (asked.current) deleteRef.current?.focus()
    asked.current = confirming
  }, [confirming])

  if (confirming) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{confirm}</p>
        <div className="ml-auto flex gap-2">
          <Button
            ref={keepRef}
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirming(false)
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="destructive" onClick={onDelete}>
            {deleteLabel}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between gap-2">
      {/* The trash hangs in the icon column of the rows above. */}
      <Button
        ref={deleteRef}
        size="sm"
        variant="ghost"
        className="-ml-2.5 text-destructive"
        onClick={() => {
          setConfirming(true)
        }}
      >
        <Trash2Icon aria-hidden />
        {deleteLabel}
      </Button>
      <Button ref={editRef} size="sm" variant="outline" onClick={onEdit}>
        <PencilIcon aria-hidden />
        {editLabel}
      </Button>
    </div>
  )
}
