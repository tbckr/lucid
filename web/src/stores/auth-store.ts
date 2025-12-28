import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthSession {
  sessionID: string
  username: string
  caldavURL: string
}

interface AuthStore {
  isAuthenticated: boolean
  session: AuthSession | null
  setAuthenticated: (authenticated: boolean) => void
  setSession: (session: AuthSession | null) => void
  logout: () => void
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      session: null,
      setAuthenticated: (authenticated: boolean) => set({ isAuthenticated: authenticated }),
      setSession: (session: AuthSession | null) => set({ session }),
      logout: () => set({ isAuthenticated: false, session: null }),
    }),
    {
      name: 'auth-storage',
    }
  )
)
