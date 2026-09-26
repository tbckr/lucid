import { type ReactNode } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { CorruptedEvent } from './CorruptedEvent'

/** Isolates rendering failures of a single event (FR-19). */
export function EventBoundary({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ErrorBoundary
      fallback={(error) => <CorruptedEvent reason={error.message} {...(className ? { className } : {})} />}
      onError={(error) => {
        console.error('event failed to render', error)
      }}
    >
      {children}
    </ErrorBoundary>
  )
}
