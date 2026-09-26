import { QueryClient } from '@tanstack/react-query'
import { isApiError } from './api/client'

/** Retry transient failures only; 4xx responses are final. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error)) {
    if (error.code === 'network') return false // paused via onlineManager instead
    if (error.status >= 400 && error.status < 500) return false
  }
  return failureCount < 2
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: shouldRetry,
        networkMode: 'online',
        refetchOnWindowFocus: true,
      },
      mutations: {
        networkMode: 'online',
        retry: false,
      },
    },
  })
}
