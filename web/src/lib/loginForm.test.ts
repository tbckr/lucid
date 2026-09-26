import { describe, expect, it } from 'vitest'
import { loginSchema } from './loginForm'

const valid = { serverUrl: 'https://cloud.example.com', username: 'tim', password: 'secret' }

describe('loginSchema', () => {
  it.each(['https://cloud.example.com', 'example.com', 'http://127.0.0.1:5232/', 'dav.example.com/remote.php/dav'])(
    'accepts %s',
    (serverUrl) => {
      expect(loginSchema.safeParse({ ...valid, serverUrl }).success).toBe(true)
    },
  )

  it.each(['', 'ftp://example.com', 'https://', 'exa mple.com', 'javascript:alert(1)'])('rejects %s', (serverUrl) => {
    expect(loginSchema.safeParse({ ...valid, serverUrl }).success).toBe(false)
  })

  it('requires username and password', () => {
    const r = loginSchema.safeParse({ ...valid, username: ' ', password: '' })
    expect(r.error?.issues.map((i) => i.message)).toEqual([
      'login.validation.usernameRequired',
      'login.validation.passwordRequired',
    ])
  })
})
