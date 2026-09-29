import { type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { type CreateKind } from '@/lib/quickCreate'
import { cn } from '@/lib/utils'

// The switch on the tint: the chosen side as a paper pill.
const onTintItem = 'text-current/75 hover:text-current data-[state=on]:bg-surface data-[state=on]:text-foreground'

/**
 * Switches a new entry between event and task, in the tinted header of the
 * create popover and the editors (FR-09, FR-16). `ref` gets the chosen side.
 */
export function KindSwitch({
  ref,
  kind,
  onSwitch,
  className,
}: {
  ref?: Ref<HTMLButtonElement>
  kind: CreateKind
  onSwitch: (kind: CreateKind) => void
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <ToggleGroup
      type="single"
      aria-label={t('create.kind')}
      value={kind}
      onValueChange={(next) => {
        // Radix reports "" when the chosen side is clicked again.
        if ((next === 'event' || next === 'task') && next !== kind) onSwitch(next)
      }}
      className={cn('justify-self-start bg-current/10', className)}
    >
      <ToggleGroupItem ref={kind === 'event' ? ref : undefined} value="event" className={onTintItem}>
        {t('create.event')}
      </ToggleGroupItem>
      <ToggleGroupItem ref={kind === 'task' ? ref : undefined} value="task" className={onTintItem}>
        {t('create.task')}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
