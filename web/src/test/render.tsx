import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderResult } from '@testing-library/react'
import { type ReactElement } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'

/** Render with the providers the app uses; `seed` fills the query cache before the first render. */
export function renderWithProviders(
  ui: ReactElement,
  seed?: (queryClient: QueryClient) => void,
): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  seed?.(queryClient)
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  )
  return { ...result, queryClient }
}
