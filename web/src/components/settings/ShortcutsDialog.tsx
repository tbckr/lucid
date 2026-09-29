import { Fragment, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { SHORTCUTS, type ShortcutGroup } from '@/lib/shortcuts'
import { useUi } from '@/stores/ui'

const GROUPS: ShortcutGroup[] = ['navigate', 'views', 'actions']

/**
 * The shortcuts by what they do. Keys that do the same are joined by "or",
 * keys pressed one after the other by "then", so the two never look alike.
 */
export function ShortcutsDialog() {
  const { t } = useTranslation()
  const open = useUi((s) => s.shortcutsOpen)
  const setOpen = useUi((s) => s.setShortcutsOpen)
  const id = useId()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shortcuts.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {GROUPS.map((group) => (
            <section key={group} aria-labelledby={`${id}-${group}`}>
              <h3 id={`${id}-${group}`} className="pb-1.5 font-display text-sm font-semibold">
                {t(`shortcuts.groups.${group}`)}
              </h3>
              <dl className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-1.5 text-sm">
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <div key={s.labelKey} className="contents">
                    <dt>{t(s.labelKey as 'shortcuts.today')}</dt>
                    <dd className="flex items-center justify-end gap-1.5">
                      {s.keys.map((k, i) => (
                        <Fragment key={k}>
                          {i > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {t(s.sequence ? 'shortcuts.then' : 'shortcuts.or')}
                            </span>
                          )}
                          <Kbd>{k}</Kbd>
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
