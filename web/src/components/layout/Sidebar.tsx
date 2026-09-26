import { PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { defaultCreateTimes } from '@/components/views/createDefaults'
import { type DateRange } from '@/lib/dates'
import { type FormatPrefs } from '@/lib/format'
import { useUi } from '@/stores/ui'
import { CalendarList } from './CalendarList'
import { MiniMonth } from './MiniMonth'

export function Sidebar({
  date,
  now,
  range,
  prefs,
  onNavigate,
}: {
  date: Date
  now: Date
  range: DateRange | null
  prefs: FormatPrefs
  onNavigate?: () => void
}) {
  const { t } = useTranslation()
  const setDate = useUi((s) => s.setDate)
  const openEditor = useUi((s) => s.openEditor)
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto pt-3 pb-6 scrollbar-thin">
      <div className="px-4">
        <Button
          size="lg"
          className="h-11 rounded-xl px-5 shadow-sm"
          onClick={() => {
            openEditor({ mode: 'create', defaults: defaultCreateTimes(date, now) })
          }}
        >
          <PlusIcon className="size-5" aria-hidden />
          {t('event.create')}
        </Button>
      </div>
      <MiniMonth
        date={date}
        now={now}
        range={range}
        prefs={prefs}
        onSelect={(d) => {
          setDate(d)
          onNavigate?.()
        }}
      />
      <CalendarList />
    </div>
  )
}
