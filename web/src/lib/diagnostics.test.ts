import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { diagnosticsReport } from '@/test/fixtures'
import { parseList, type CorruptedItem } from './api/schemas'
import {
  assembleReport,
  corruptedForReport,
  ISSUE_TEMPLATE,
  issueUrl,
  REPO_URL,
  reportFileName,
  SECURITY_URL,
  type ReportObject,
} from './diagnostics'

function reportObject(p: Partial<ReportObject> = {}): ReportObject {
  return { objectId: 'o1', source: 'event', skeleton: { text: 'BEGIN:VCALENDAR\nEND:VCALENDAR\n' }, ...p }
}

function corrupted(p: Partial<CorruptedItem> = {}): CorruptedItem {
  return {
    kind: 'corrupted',
    key: 'k1',
    calendarId: 'c1',
    start: new Date('2026-10-20T08:00:00Z'),
    reason: 'title: Invalid input',
    issues: [{ path: 'title', code: 'invalid_type' }],
    ...p,
  }
}

describe('constants', () => {
  it('point at the repository, its issue form and its private advisories', () => {
    expect(REPO_URL).toBe('https://github.com/tbckr/lucid')
    expect(ISSUE_TEMPLATE).toBe('caldav-server.yml')
    expect(SECURITY_URL).toBe('https://github.com/tbckr/lucid/security/advisories/new')
  })
})

describe('assembleReport', () => {
  it('keeps the server report verbatim and adds the client part', () => {
    const server = diagnosticsReport({ extra: { kept: true } })
    const before = structuredClone(server)
    const out = assembleReport(server, [], [], new Set())
    expect(out).toEqual({ ...before, client: { corrupted: [], objects: [] } })
    expect(Object.keys(out).at(-1)).toBe('client')
    expect(server).toEqual(before)
  })

  it('adds content only for included objects', () => {
    const objects = [
      reportObject({ objectId: 'o1', content: 'zz-canary one' }),
      reportObject({ objectId: 'o2', source: 'todo', content: 'zz-canary two' }),
      reportObject({ objectId: 'o3', source: 'problem' }),
    ]
    const out = assembleReport(diagnosticsReport(), [], objects, new Set(['o1', 'o3']))
    expect(out.client).toMatchObject({
      objects: [
        { objectId: 'o1', source: 'event', content: 'zz-canary one' },
        { objectId: 'o2', source: 'todo' },
        { objectId: 'o3', source: 'problem' },
      ],
    })
    const written = (out.client as { objects: Record<string, unknown>[] }).objects
    // Shown but not ticked: no content key at all; ticked but never loaded: none either.
    expect('content' in (written[1] ?? {})).toBe(false)
    expect('content' in (written[2] ?? {})).toBe(false)
    expect(JSON.stringify(out)).not.toContain('zz-canary two')
  })

  it('keeps skeletons of objects without consent', () => {
    const skeleton = { text: 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:\n', truncated: true }
    const out = assembleReport(
      diagnosticsReport(),
      [],
      [reportObject({ skeleton, content: 'zz-canary' })],
      new Set(),
    )
    expect(out.client).toEqual({
      corrupted: [],
      objects: [{ objectId: 'o1', source: 'event', skeleton }],
    })
    expect(JSON.stringify(out)).not.toContain('zz-canary')
  })

  it('never writes labels', () => {
    const withLabel = {
      ...reportObject({ content: 'BEGIN:VCALENDAR' }),
      label: 'zz-canary Dentist',
      calendarId: 'c1',
      skeleton: { text: 'BEGIN:VCALENDAR\n', label: 'zz-canary in the skeleton' },
    }
    const out = assembleReport(diagnosticsReport(), [], [withLabel], new Set(['o1']))
    expect(out.client).toEqual({
      corrupted: [],
      objects: [{ objectId: 'o1', source: 'event', skeleton: { text: 'BEGIN:VCALENDAR\n' }, content: 'BEGIN:VCALENDAR' }],
    })
    expect(JSON.stringify(out)).not.toContain('zz-canary')
  })

  it('reports corrupted items by field names only', () => {
    const out = assembleReport(diagnosticsReport(), [corrupted({ reason: 'title: zz-canary' })], [], new Set())
    expect(out.client).toEqual({
      corrupted: [{ key: 'k1', calendarId: 'c1', issues: [{ path: 'title', code: 'invalid_type' }] }],
      objects: [],
    })
    expect(JSON.stringify(out)).not.toContain('zz-canary')
  })
})

describe('corruptedForReport', () => {
  it('drops Zod messages from corrupted items', () => {
    const schema = z.object({
      id: z.string(),
      title: z.string().refine(() => false, { message: 'zz-canary is not allowed' }),
      nested: z.object({ n: z.number() }),
    })
    const { corrupted: items } = parseList(schema, [{ id: 'x', title: 'zz-canary', nested: { n: 'zz-canary' } }], 'cal')
    // The UI keeps the message; the report must not.
    expect(items[0]?.reason).toContain('zz-canary is not allowed')

    const out = corruptedForReport(items)
    expect(out).toEqual([
      {
        key: 'x',
        calendarId: 'cal',
        issues: [
          { path: 'title', code: 'custom' },
          { path: 'nested.n', code: 'invalid_type' },
        ],
      },
    ])
    expect(JSON.stringify(out)).not.toContain('zz-canary')
    expect(Object.keys(out[0] ?? {}).sort()).toEqual(['calendarId', 'issues', 'key'])
    for (const issue of out[0]?.issues ?? []) expect(Object.keys(issue).sort()).toEqual(['code', 'path'])
  })

  it('copies only path and code, whatever an issue carries', () => {
    const issues = [{ path: 'title', code: 'custom', message: 'zz-canary', received: 'zz-canary' }]
    const out = corruptedForReport([corrupted({ issues })])
    expect(out[0]?.issues).toEqual([{ path: 'title', code: 'custom' }])
    expect(JSON.stringify(out)).not.toContain('zz-canary')
  })

  it('returns an empty list for no items', () => {
    expect(corruptedForReport([])).toEqual([])
  })
})

describe('issueUrl', () => {
  it('builds the issue URL from non-content fields', () => {
    const report = diagnosticsReport({
      exchanges: [{ path: '{home}/zz-canary-exchange/', status: 500 }],
      problems: [
        {
          at: '2026-10-20T08:09:01Z',
          kind: 'unparsable_object',
          path: '{home}/zz-canary-problem.ics',
          reason: 'zz-canary-reason',
          skeleton: { text: 'zz-canary-skeleton' },
        },
      ],
    })
    const url = issueUrl(report)
    expect(url).toBe(
      'https://github.com/tbckr/lucid/issues/new?template=caldav-server.yml&lucid-version=1.2.3&mode=server&server-product=Nextcloud',
    )
    expect(url).not.toContain('zz-canary')
    expect(url).not.toContain('dav.example.com')
  })

  it('encodes the values', () => {
    const report = diagnosticsReport({
      lucid: { version: '1.2.3-rc.1+a&b', mode: 'local' },
      server: { host: 'h', product: 'Radicale/3.2 (x=y) #1', dav: '' },
    })
    const params = new URL(issueUrl(report)).searchParams
    expect(params.get('lucid-version')).toBe('1.2.3-rc.1+a&b')
    expect(params.get('mode')).toBe('local')
    expect(params.get('server-product')).toBe('Radicale/3.2 (x=y) #1')
    expect([...params.keys()]).toEqual(['template', 'lucid-version', 'mode', 'server-product'])
    expect(issueUrl(report)).not.toMatch(/[ #]/)
  })

  it('cuts the product to 100 characters, never inside a character', () => {
    const long = diagnosticsReport({ server: { host: 'h', product: 'x'.repeat(250), dav: '' } })
    expect(new URL(issueUrl(long)).searchParams.get('server-product')).toBe('x'.repeat(100))

    // The 100th character is outside the BMP: cutting at 100 UTF-16 units would leave half a pair, which cannot be encoded.
    const emoji = diagnosticsReport({ server: { host: 'h', product: `${'x'.repeat(99)}😀tail`, dav: '' } })
    expect(new URL(issueUrl(emoji)).searchParams.get('server-product')).toBe(`${'x'.repeat(99)}😀`)
  })

  it('sends an empty product while the server is unknown', () => {
    const unknown = diagnosticsReport({ server: { host: '', product: '', dav: '' } })
    expect(issueUrl(unknown)).toBe(
      'https://github.com/tbckr/lucid/issues/new?template=caldav-server.yml&lucid-version=1.2.3&mode=server&server-product=',
    )
  })
})

describe('reportFileName', () => {
  it('names the file by UTC time', () => {
    expect(reportFileName(new Date('2026-10-20T08:09:10Z'))).toBe('lucid-report-20261020-080910Z.json')
  })

  it('uses UTC, not the local zone (Europe/Berlin in tests)', () => {
    // 00:59:59 on 1 January 2027 in Berlin.
    expect(reportFileName(new Date('2026-12-31T23:59:59Z'))).toBe('lucid-report-20261231-235959Z.json')
  })

  it('pads every field to its width', () => {
    expect(reportFileName(new Date('2026-01-02T03:04:05.678Z'))).toBe('lucid-report-20260102-030405Z.json')
  })
})
