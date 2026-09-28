import { zodResolver } from '@hookform/resolvers/zod'
import { PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useId, useMemo, useState, type ChangeEvent } from 'react'
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useDeleteTodo, useUpdateTodo, useVisibleCalendars } from '@/hooks/queries'
import { type Todo } from '@/lib/api/schemas'
import { browserTimeZone } from '@/lib/locale'
import { formToTodoInput, taskFormSchema, taskToForm, type TaskFormValues } from '@/lib/taskForm'
import { priorityLevel, priorityValue, type PriorityLevel } from '@/lib/tasks'
import { useUi } from '@/stores/ui'

const LEVELS: PriorityLevel[] = ['none', 'high', 'medium', 'low']

/** Edit a task: title, notes, start and due date, priority, checklist (FR-13, FR-14, FR-16). */
export function TaskEditorDialog() {
  const todo = useUi((s) => s.taskEditor)
  const open = useUi((s) => s.openTaskEditor)
  return (
    <Dialog
      open={todo !== null}
      onOpenChange={(o) => {
        if (!o) open(null)
      }}
    >
      {todo && (
        <DialogContent className="sm:max-w-lg">
          <TaskForm
            key={todo.id}
            todo={todo}
            onDone={() => {
              open(null)
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  )
}

function TaskForm({ todo, onDone }: { todo: Todo; onDone: () => void }) {
  const { t } = useTranslation()
  const id = useId()
  const tz = useMemo(() => browserTimeZone(), [])
  const { byId } = useVisibleCalendars()
  const readOnly = byId.get(todo.calendarId)?.readOnly ?? false
  const update = useUpdateTodo()
  const del = useDeleteTodo()
  const [newItem, setNewItem] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: taskToForm(todo, tz),
  })
  const { register, control, handleSubmit, formState, setValue } = form
  const checklist = useFieldArray({ control, name: 'checklist' })
  const startDate = useWatch({ control, name: 'startDate' })
  const dueDate = useWatch({ control, name: 'dueDate' })

  const onSubmit = handleSubmit((values) => {
    update.mutate({ todo, input: formToTodoInput(values, tz, todo) }, { onSuccess: onDone })
  })

  const msg = (m: string | undefined) => (m ? t(m as 'validation.date') : undefined)

  const addItem = () => {
    const text = newItem.trim()
    if (!text) return
    checklist.append({ text, done: false })
    setNewItem('')
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{t('tasks.edit')}</DialogTitle>
        <DialogDescription className="sr-only">{t('tasks.editDescription')}</DialogDescription>
      </DialogHeader>
      <fieldset disabled={readOnly} className="grid gap-5">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-title`}>{t('tasks.titleLabel')}</Label>
          <Input id={`${id}-title`} autoComplete="off" aria-invalid={formState.errors.title ? true : undefined} {...register('title')} />
          {formState.errors.title && <p className="text-sm text-destructive">{msg(formState.errors.title.message)}</p>}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-start`}>{t('tasks.start')}</Label>
            <Input
              id={`${id}-start`}
              type="date"
              className="tabular w-[10.5rem]"
              {...register('startDate', {
                // The time field is disabled without a date; drop its value too.
                onChange: (e: ChangeEvent<HTMLInputElement>) => {
                  if (!e.target.value) setValue('startTime', '')
                },
              })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-start-time`}>{t('tasks.startTime')}</Label>
            <Input
              id={`${id}-start-time`}
              type="time"
              step={300}
              className="tabular w-[8rem]"
              disabled={!startDate}
              {...register('startTime')}
            />
          </div>
        </div>
        {formState.errors.startDate && <p className="-mt-3 text-sm text-destructive">{msg(formState.errors.startDate.message)}</p>}

        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-due`}>{t('tasks.due')}</Label>
            <Input
              id={`${id}-due`}
              type="date"
              className="tabular w-[10.5rem]"
              {...register('dueDate', {
                onChange: (e: ChangeEvent<HTMLInputElement>) => {
                  if (!e.target.value) setValue('dueTime', '')
                },
              })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-time`}>{t('tasks.dueTime')}</Label>
            <Input
              id={`${id}-time`}
              type="time"
              step={300}
              className="tabular w-[8rem]"
              disabled={!dueDate}
              {...register('dueTime')}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-priority`}>{t('tasks.priority')}</Label>
            <Controller
              control={control}
              name="priority"
              render={({ field }) => (
                <Select
                  value={priorityLevel(field.value)}
                  onValueChange={(level) => {
                    // Keep the exact RFC 5545 value when the level does not change.
                    if (level !== priorityLevel(field.value)) field.onChange(priorityValue(level as PriorityLevel))
                  }}
                >
                  <SelectTrigger id={`${id}-priority`} className="w-[9rem]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVELS.map((l) => (
                      <SelectItem key={l} value={l}>
                        {t(`priority.${l}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </div>
        {formState.errors.dueDate && <p className="-mt-3 text-sm text-destructive">{msg(formState.errors.dueDate.message)}</p>}

        <div className="flex items-center gap-2">
          <Controller
            control={control}
            name="completed"
            render={({ field }) => (
              <Checkbox id={`${id}-done`} checked={field.value} onCheckedChange={(v) => { field.onChange(v === true) }} />
            )}
          />
          <Label htmlFor={`${id}-done`}>{t('tasks.markCompleted')}</Label>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-notes`}>{t('tasks.notes')}</Label>
          <Textarea id={`${id}-notes`} rows={3} className="max-h-40" {...register('description')} />
        </div>

        <fieldset className="grid gap-2">
          <legend className="pb-1.5 text-sm font-medium">{t('tasks.checklist')}</legend>
          {checklist.fields.length > 0 && (
            <ul className="grid gap-1">
              {checklist.fields.map((f, i) => (
                <li key={f.id} className="flex items-center gap-2">
                  <Controller
                    control={control}
                    name={`checklist.${i}.done`}
                    render={({ field }) => (
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(v) => { field.onChange(v === true) }}
                        aria-label={t('tasks.itemDone', { text: f.text })}
                      />
                    )}
                  />
                  <Input
                    className="h-8"
                    aria-label={t('tasks.itemText', { index: i + 1 })}
                    aria-invalid={formState.errors.checklist?.[i]?.text ? true : undefined}
                    {...register(`checklist.${i}.text`)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('tasks.removeItem', { text: f.text })}
                    onClick={() => {
                      checklist.remove(i)
                    }}
                  >
                    <XIcon aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <Input
              className="h-8"
              value={newItem}
              placeholder={t('tasks.addItem')}
              aria-label={t('tasks.addItem')}
              onChange={(e) => {
                setNewItem(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addItem()
                }
              }}
            />
            <Button type="button" variant="outline" size="icon-sm" aria-label={t('tasks.addItem')} onClick={addItem}>
              <PlusIcon aria-hidden />
            </Button>
          </div>
          {formState.errors.checklist?.message && (
            <p className="text-sm text-destructive">{msg(formState.errors.checklist.message)}</p>
          )}
        </fieldset>
      </fieldset>

      {confirmDelete && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted p-3 text-sm">
          {t('tasks.confirmDelete')}
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => { setConfirmDelete(false) }}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={del.isPending}
              onClick={() => {
                del.mutate(todo, { onSuccess: onDone })
              }}
            >
              {del.isPending && <Spinner />}
              {t('tasks.delete')}
            </Button>
          </div>
        </div>
      )}

      <DialogFooter className="sm:justify-between">
        {!readOnly ? (
          <Button type="button" variant="ghost" className="text-destructive" onClick={() => { setConfirmDelete(true) }}>
            <Trash2Icon aria-hidden />
            {t('tasks.delete')}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          {!readOnly && (
            <Button type="submit" disabled={update.isPending}>
              {update.isPending && <Spinner />}
              {t('common.save')}
            </Button>
          )}
        </div>
      </DialogFooter>
    </form>
  )
}
