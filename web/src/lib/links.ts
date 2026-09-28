/** A piece of plain text; `href` is set when the piece is a web URL. */
export interface TextPart {
  text: string
  href?: string
}

const CANDIDATE = /https?:\/\/[^\s<>"]+/gi
const PUNCTUATION = '.,;:!?\'"'
const OPENING: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

function count(s: string, c: string): number {
  return s.split(c).length - 1
}

// Sentence punctuation after a URL is not part of it, nor is a closing
// bracket the URL did not open ("(see https://example.com)").
function trimUrl(url: string): string {
  let u = url
  for (;;) {
    const last = u.at(-1) ?? ''
    const opening = OPENING[last]
    if (PUNCTUATION.includes(last) || (opening && count(u, last) > count(u, opening))) u = u.slice(0, -1)
    else return u
  }
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return (protocol === 'http:' || protocol === 'https:') && hostname !== ''
  } catch {
    return false
  }
}

/**
 * Split plain text into text and http(s) links, so the UI can render the
 * links as elements and everything else as text (never as HTML, NFR-29).
 */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  let pos = 0
  for (const m of text.matchAll(CANDIDATE)) {
    const url = trimUrl(m[0])
    if (!isWebUrl(url)) continue
    if (m.index > pos) parts.push({ text: text.slice(pos, m.index) })
    parts.push({ text: url, href: url })
    pos = m.index + url.length
  }
  if (pos < text.length) parts.push({ text: text.slice(pos) })
  return parts
}
