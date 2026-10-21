import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api } from '@/lib/api/client'
import { type Session } from '@/lib/api/schemas'
import { loginPathFor } from '@/lib/redirect'
import { navigate } from '@/lib/router'
import { useUi } from '@/stores/ui'
import { queryKeys } from './queries'

/**
 * A 401 `unauthenticated` anywhere sends the app back to the login page, remembering where it was. A session that
 * was signed in ended without the user signing out, as in a forced logout, whose trace the server keeps (FR-36):
 * the login page then says so and offers the problem report.
 */
export function useUnauthenticatedRedirect(): void {
  const qc = useQueryClient()
  useEffect(
    () =>
      api.onUnauthenticated(() => {
        const current = window.location.pathname + window.location.search
        if (qc.getQueryData<Session>(queryKeys.session)?.authenticated === true) useUi.getState().setSignedOut(true)
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== queryKeys.session[0] })
        void qc.invalidateQueries({ queryKey: queryKeys.session })
        // The items added to the problem report carry titles of the account that is gone (FR-36).
        useUi.getState().clearReport()
        if (window.location.pathname !== '/login') navigate(loginPathFor(current), { replace: true })
      }),
    [qc],
  )
}
