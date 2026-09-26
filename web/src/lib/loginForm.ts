import { z } from 'zod'

/** Login form (FR-01). Messages are i18n keys. */
export const loginSchema = z.object({
  serverUrl: z
    .string()
    .trim()
    .min(1, 'login.validation.serverRequired')
    .max(2048, 'validation.tooLong')
    .refine((v) => {
      // Bare domains are allowed (auto-discovery); otherwise require http(s).
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`
      try {
        const u = new URL(withScheme)
        return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.length > 0 && !/\s/.test(v)
      } catch {
        return false
      }
    }, 'login.validation.serverInvalid'),
  username: z.string().trim().min(1, 'login.validation.usernameRequired').max(1024, 'validation.tooLong'),
  password: z.string().min(1, 'login.validation.passwordRequired').max(4096, 'validation.tooLong'),
})

export type LoginValues = z.infer<typeof loginSchema>
