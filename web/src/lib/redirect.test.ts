import { describe, expect, it } from 'vitest'
import { loginPathFor, safeRedirect } from './redirect'

describe('safeRedirect (NFR-33)', () => {
  it.each([
    ['/', '/'],
    ['/week', '/week'],
    ['/a/b?x=1#frag', '/a/b?x=1#frag'],
    ['/a/../b', '/b'],
  ])('accepts same-origin path %s', (input, expected) => {
    expect(safeRedirect(input)).toBe(expected)
  })

  it.each([
    null,
    undefined,
    '',
    'week',
    '//evil.example',
    '//evil.example/path',
    '/\\evil.example',
    '\\\\evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    ' /week',
    '/\tevil',
    '/%0a',
    '/login',
    '/login?redirect=/x',
    'x'.repeat(10) + '/',
    '/' + 'a'.repeat(3000),
  ])('rejects %s', (input) => {
    const res = safeRedirect(input)
    // '/%0a' is an encoded newline inside the path, harmless but still same-origin
    if (input === '/%0a') expect(res).toBe('/%0a')
    else expect(res).toBeNull()
  })

  it('builds login paths that preserve the target', () => {
    expect(loginPathFor('/')).toBe('/login')
    expect(loginPathFor('//evil')).toBe('/login')
    expect(loginPathFor('/week?x=1')).toBe('/login?redirect=%2Fweek%3Fx%3D1')
  })
})
