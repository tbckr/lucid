import { type CorruptedItem, type DiagnosticsReport, type Skeleton } from './api/schemas'

/**
 * The problem report (FR-36) is put together here, in the browser, from the server's report, the placeholders of
 * items the browser could not read and the objects the user added. Lucid sends it nowhere: the user downloads it.
 * By default it holds no calendar contents (NFR-36). An object's raw content goes in only when the user viewed it
 * and ticked it for that one object.
 */

export const REPO_URL = 'https://github.com/tbckr/lucid'
/** The issue form in `.github/ISSUE_TEMPLATE/`; the parameters of `issueUrl` are the ids of its fields. */
export const ISSUE_TEMPLATE = 'caldav-server.yml'
export const SECURITY_URL = `${REPO_URL}/security/advisories/new`

/** The server product goes into a URL, so it is cut to a length a GitHub form takes. */
const MAX_PRODUCT_CHARS = 100

/** A calendar object the user chose for the report, or that a problem is about. */
export interface ReportObject {
  objectId: string
  source: 'problem' | 'event' | 'todo'
  skeleton: Skeleton
  /** Raw content the user viewed. It is written only for an ID the user ticked (`included` of `assembleReport`). */
  content?: string
}

/** A placeholder in the report: a reference to the item and what failed in it, by field name. */
export interface ReportCorrupted {
  key: string
  calendarId: string
  issues: { path: string; code: string }[]
}

/**
 * The placeholders for the report: their reference and the field paths and codes of their Zod issues. Not `reason`
 * and not `start`: the reason holds Zod's messages, which can contain what was received (NFR-36).
 */
export function corruptedForReport(items: readonly CorruptedItem[]): ReportCorrupted[] {
  return items.map((item) => ({
    key: item.key,
    calendarId: item.calendarId,
    // Copied field by field, so that nothing but path and code gets in, whatever an issue carries.
    issues: item.issues.map(({ path, code }) => ({ path, code })),
  }))
}

/** One object of the report: its skeleton always, its content only if `included`. No label, title or calendar name. */
function reportObject(object: ReportObject, included: ReadonlySet<string>): Record<string, unknown> {
  const { text, truncated } = object.skeleton
  return {
    objectId: object.objectId,
    source: object.source,
    skeleton: { text, ...(truncated === undefined ? {} : { truncated }) },
    ...(object.content !== undefined && included.has(object.objectId) ? { content: object.content } : {}),
  }
}

/**
 * The file the user downloads: the server's report verbatim, plus what the browser knows as `client`. Of the
 * `objects` only the listed fields are written, so a label the dialog shows (an event's title, a calendar's name)
 * cannot get into the file with them. `content` is added only for the IDs in `included`.
 */
export function assembleReport(
  server: DiagnosticsReport,
  corrupted: readonly CorruptedItem[],
  objects: readonly ReportObject[],
  included: ReadonlySet<string>,
): Record<string, unknown> {
  return {
    ...server,
    client: {
      corrupted: corruptedForReport(corrupted),
      objects: objects.map((object) => reportObject(object, included)),
    },
  }
}

/**
 * The link to the issue form, prefilled with Lucid's version and mode and the server product: three short facts
 * from the report and nothing of what is in it (exchanges, problems, contents). The product is the server's own
 * header, cut to 100 characters, by code point so that the cut cannot leave half of a surrogate pair, which
 * `encodeURIComponent` refuses.
 */
export function issueUrl(report: DiagnosticsReport): string {
  const params: [string, string][] = [
    ['template', ISSUE_TEMPLATE],
    ['lucid-version', report.lucid.version],
    ['mode', report.lucid.mode],
    ['server-product', Array.from(report.server.product).slice(0, MAX_PRODUCT_CHARS).join('')],
  ]
  return `${REPO_URL}/issues/new?${params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')}`
}

/** `lucid-report-YYYYMMDD-HHMMSSZ.json`, in UTC whatever the zone of the browser. */
export function reportFileName(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  return `lucid-report-${stamp}Z.json`
}
