import { useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * Asks before deleting, in a popover at the button that deletes, like the due
 * date asks at its own. "Cancel" takes the focus, and Escape or a click
 * outside keep everything; the focus goes back to the button (NFR-27).
 */
export function ConfirmDelete({
  question,
  note,
  action,
  onConfirm,
  children,
}: {
  question: string
  /** What deleting means beyond the list, where that is not obvious. */
  note?: string
  /** The confirming button, named for what it deletes. */
  action: string
  onConfirm: () => void
  /** The button that asks. */
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const keepRef = useRef<HTMLButtonElement>(null)
  const id = useId()

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        role="alertdialog"
        align="end"
        aria-labelledby={`${id}-question`}
        aria-describedby={note ? `${id}-note` : undefined}
        className="w-64 p-3"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          keepRef.current?.focus()
        }}
      >
        <p id={`${id}-question`} className="text-sm font-medium">
          {question}
        </p>
        {note && (
          <p id={`${id}-note`} className="mt-1 text-[0.8125rem] text-muted-foreground">
            {note}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <Button
            ref={keepRef}
            size="sm"
            variant="ghost"
            onClick={() => {
              setOpen(false)
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setOpen(false)
              onConfirm()
            }}
          >
            {action}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
