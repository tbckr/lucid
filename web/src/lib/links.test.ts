import { describe, expect, it } from 'vitest'
import { splitLinks } from './links'

describe('splitLinks', () => {
  it('keeps text without links as one part', () => {
    expect(splitLinks('Room 42\nsecond floor')).toEqual([{ text: 'Room 42\nsecond floor' }])
    expect(splitLinks('')).toEqual([])
  })

  it('links http and https URLs between the text', () => {
    expect(splitLinks('Join https://meet.example.com/abc?pw=1 or HTTP://example.org')).toEqual([
      { text: 'Join ' },
      { text: 'https://meet.example.com/abc?pw=1', href: 'https://meet.example.com/abc?pw=1' },
      { text: ' or ' },
      { text: 'HTTP://example.org', href: 'HTTP://example.org' },
    ])
  })

  it('leaves punctuation after a URL out of the link', () => {
    expect(splitLinks('Slides: https://example.com/deck.')).toEqual([
      { text: 'Slides: ' },
      { text: 'https://example.com/deck', href: 'https://example.com/deck' },
      { text: '.' },
    ])
    expect(splitLinks('"https://example.com/a",')).toEqual([
      { text: '"' },
      { text: 'https://example.com/a', href: 'https://example.com/a' },
      { text: '",' },
    ])
  })

  it('keeps closing brackets that belong to the URL', () => {
    expect(splitLinks('(see https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      { text: '(see ' },
      { text: 'https://en.wikipedia.org/wiki/Foo_(bar)', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { text: ')' },
    ])
    expect(splitLinks('<https://example.com>')).toEqual([
      { text: '<' },
      { text: 'https://example.com', href: 'https://example.com' },
      { text: '>' },
    ])
  })

  it('links nothing but web URLs', () => {
    expect(splitLinks('javascript:alert(1) ftp://example.com mailto:a@example.com https://')).toEqual([
      { text: 'javascript:alert(1) ftp://example.com mailto:a@example.com https://' },
    ])
    expect(splitLinks('https://.')).toEqual([{ text: 'https://.' }])
  })
})
