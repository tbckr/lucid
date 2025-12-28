import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@stores/auth-store'
import { useCalendarStore } from '@stores/calendar-store'
import Login from '@pages/Login'
import Calendar from '@pages/Calendar'
import { apiClient } from '@lib/api-client'

export default function App() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated)

  // Check auth status on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await apiClient.get('/api/auth/status')
        if (response.status === 200) {
          setAuthenticated(true)
        }
      } catch (error) {
        setAuthenticated(false)
      }
    }
    checkAuth()
  }, [setAuthenticated])

  return (
    <div className="min-h-screen bg-background">
      {isAuthenticated ? <Calendar /> : <Login />}
    </div>
  )
}
