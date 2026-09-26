import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { SHORTCUTS } from '@/lib/shortcuts'
import { useUi } from '@/stores/ui'

export function ShortcutsDialog() {
  const { t } = useTranslation()
  const open = useUi((s) => s.shortcutsOpen)
  const setOpen = useUi((s) => s.setShortcutsOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shortcuts.description')}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.labelKey} className="contents">
              <dt>{t(s.labelKey as 'shortcuts.today')}</dt>
              <dd className="flex justify-end gap-1">
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dd>
            </div>
          ))}
          <div className="contents">
            <dt>{t('shortcuts.moveEvent')}</dt>
            <dd className="flex justify-end gap-1">
              <Kbd>Space</Kbd>
              <Kbd>←↑→↓</Kbd>
            </dd>
          </div>
        </dl>
      </DialogContent>
    </Dialog>
  )
}
