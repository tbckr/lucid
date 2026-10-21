import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { type CalItem, eventTitle } from '@/lib/events'
import { type ReportCandidate } from '@/stores/ui'
import { CorruptedEvent } from './CorruptedEvent'

/**
 * Isolates rendering failures of a single event or task (FR-19). Its placeholder adds `item` to the problem report
 * (FR-36), whose structure is what reproduces the failure.
 */
export function EventBoundary({ item, children, className }: { item: CalItem; children: ReactNode; className?: string }) {
  const { t } = useTranslation()
  return (
    <ErrorBoundary
      fallback={(error) => (
        <CorruptedEvent
          reason={error.message}
          candidate={reportCandidate(item, t('event.untitled'))}
          {...(className ? { className } : {})}
        />
      )}
      onError={(error) => {
        console.error('event failed to render', error)
      }}
    >
      {children}
    </ErrorBoundary>
  )
}

/** `item` as an item of the problem report: a task by its todo, which the report reads. */
function reportCandidate(item: CalItem, untitled: string): ReportCandidate {
  return item.kind === 'task'
    ? { objectId: item.todo.id, kind: 'todo', label: eventTitle(item.todo, untitled), calendarId: item.calendarId }
    : { objectId: item.id, kind: 'event', label: eventTitle(item, untitled), calendarId: item.calendarId }
}
