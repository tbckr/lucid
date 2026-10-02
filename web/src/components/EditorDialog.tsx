import { useRef } from 'react'
import { EventEditor } from '@/components/events/EventEditor'
import { TaskEditor } from '@/components/tasks/TaskEditor'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useCalendars, useVisibleCalendars } from '@/hooks/queries'
import { writableFor } from '@/lib/quickCreate'
import { useUi } from '@/stores/ui'

/**
 * The dialog of the event and task editors (FR-09, FR-16): a new entry
 * switches between them while it stays open.
 */
export function EditorDialog() {
  const editor = useUi((s) => s.editor)
  const taskEditor = useUi((s) => s.taskEditor)
  const openEditor = useUi((s) => s.openEditor)
  const { isPending } = useCalendars()
  const { all } = useVisibleCalendars()
  const events = writableFor('event', all).length > 0
  const tasks = writableFor('task', all).length > 0
  const canSwitch = events && tasks
  // Where only task lists take a new entry, it is a task, as in the create popover.
  const task = editor?.mode === 'create' && !events && tasks ? editor : taskEditor
  // Holds how to cancel the editor's save scope question while it is open, for the Escape
  // handler below (FR-17, NFR-27).
  const cancelScope = useRef<(() => void) | null>(null)

  const close = () => {
    // Drops a stale cancel from an editor that is about to unmount (its own cleanup effects
    // never run, since this ref outlives it): otherwise the next editor's first Escape would
    // find a leftover `cancelScope.current` and get swallowed (NFR-27).
    cancelScope.current = null
    openEditor(null)
  }

  return (
    <Dialog
      open={editor !== null || taskEditor !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      {/* The editors choose a calendar and their form once: wait for the list, as `c` may come first. */}
      {!isPending && (editor ?? taskEditor) && (
        // At the top rather than centered: a switch of the kind, or a growing checklist, leaves the header in place.
        <DialogContent
          className="top-4 gap-0 translate-y-0 p-0 sm:top-[10dvh] sm:max-h-[calc(90dvh-1rem)]"
          showCloseButton={false}
          onEscapeKeyDown={(e) => {
            // While the save scope question is open, Escape cancels it instead of closing the
            // dialog (NFR-27): Radix would otherwise dismiss the editor before the question's
            // own handler ever ran.
            if (cancelScope.current) {
              e.preventDefault()
              cancelScope.current()
            }
          }}
        >
          {task ? (
            <TaskEditor
              key={task.mode === 'edit' ? task.todo.id : 'create'}
              state={task}
              canSwitch={canSwitch}
              onDone={close}
            />
          ) : (
            editor && (
              <EventEditor
                key={editor.mode === 'edit' ? editor.event.key : 'create'}
                editor={editor}
                canSwitch={canSwitch}
                onDone={close}
                onScopeOpenChange={(cancel) => {
                  cancelScope.current = cancel
                }}
              />
            )
          )}
        </DialogContent>
      )}
    </Dialog>
  )
}
