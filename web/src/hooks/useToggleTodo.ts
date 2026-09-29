import { startTransition, useOptimistic } from 'react'
import { type Todo } from '@/lib/api/schemas'
import { isDone, todoToInput, toggledStatus } from '@/lib/tasks'
import { useUpdateTodo } from './queries'

/** Completion state of a task and a toggle that shows the new state at once (FR-15). */
export function useToggleTodo(todo: Todo): { done: boolean; toggle: () => void } {
  const update = useUpdateTodo(todo.id)
  // React 19: show the new state instantly while the request is in flight.
  const [done, setOptimisticDone] = useOptimistic(isDone(todo))

  const toggle = () => {
    const status = toggledStatus(todo)
    startTransition(async () => {
      setOptimisticDone(status === 'COMPLETED')
      try {
        await update.mutateAsync({ todo, input: todoToInput(todo, { status }) })
      } catch {
        // Reported by the mutation; the optimistic state reverts automatically.
      }
    })
  }
  return { done, toggle }
}
