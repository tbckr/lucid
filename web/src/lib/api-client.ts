import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios'

// Create axios instance
const instance: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8080',
  timeout: 30000,
  withCredentials: true,
})

// Request interceptor to add CSRF token
instance.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // Get CSRF token from meta tag or cookie
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
    
    if (csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(config.method?.toUpperCase() || '')) {
      config.headers['X-CSRF-Token'] = csrfToken
    }
    
    return config
  },
  (error) => Promise.reject(error)
)

// Response interceptor for error handling
instance.interceptors.response.use(
  (response) => response,
  (error) => {
    // Handle CSRF token refresh on 403
    if (error.response?.status === 403 && error.response?.data?.error === 'csrf') {
      // Could implement token refresh here
      console.error('CSRF token invalid')
    }

    return Promise.reject(error)
  }
)

export const apiClient = instance
