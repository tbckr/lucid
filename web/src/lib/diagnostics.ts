import { type SettingsState } from '@/stores/settings'
import { type CorruptedItem, type DiagnosticsReport, type Skeleton } from './api/schemas'
import { type HourCycle, type WeekStart } from './locale'

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
 * and not `start`: the reason holds Zod's messages, which can contain what was received (NFR-36). The reference is
 * the key without what follows an "@": the key of an occurrence is its ID and its start (`<id>@<RFC 3339>`), and
 * the report names no times of the user's calendar.
 */
export function corruptedForReport(items: readonly CorruptedItem[]): ReportCorrupted[] {
  return items.map((item) => ({
    key: item.key.split('@', 1)[0] ?? '',
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

type DayName = 'sunday' | 'monday' | 'saturday'

const DAY_NAMES: Record<WeekStart, DayName> = { 0: 'sunday', 1: 'monday', 6: 'saturday' }

/** What `clientContext` reads: the settings, what they resolved to, and the browser. */
export interface ContextInput {
  settings: Pick<SettingsState, 'language' | 'timeFormat' | 'weekStart' | 'hideCompletedInCalendar' | 'hiddenCalendars'>
  /** The language the UI is shown in. */
  language: string
  hourCycle: HourCycle
  weekStartsOn: WeekStart
  /** The stable IDs of the account's calendars, once they are loaded. */
  calendars?: readonly string[]
  timeZone: string
  locale: string
  userAgent: string
  viewport: { width: number; height: number }
}

/** The browser's part of the report, beside its placeholders and objects. */
export interface ClientContext {
  timeZone: string
  locale: string
  settings: {
    language: { setting: string; used: string }
    timeFormat: { setting: string; used: HourCycle }
    weekStart: { setting: 'auto' | DayName; used: DayName }
    hideCompletedInCalendar: boolean
    /** How many of the account's calendars are hidden in the sidebar; absent while they are unknown. */
    hiddenCalendars?: number
  }
  browser: string
  viewport: { width: number; height: number }
}

/**
 * What the browser tells about itself and the settings that change what is shown (FR-36): a wrong time or a
 * missing item depends on them. Field by field, so that no other setting, such as the last server URL, gets in. Of
 * the hidden calendars only their number among the account's calendars, no ID.
 */
export function clientContext(input: ContextInput): ClientContext {
  const { settings, calendars } = input
  const hidden = calendars?.filter((id) => settings.hiddenCalendars.includes(id)).length
  return {
    timeZone: input.timeZone,
    locale: input.locale,
    settings: {
      language: { setting: settings.language, used: input.language },
      timeFormat: { setting: settings.timeFormat, used: input.hourCycle },
      weekStart: {
        setting: settings.weekStart === 'auto' ? 'auto' : DAY_NAMES[settings.weekStart],
        used: DAY_NAMES[input.weekStartsOn],
      },
      hideCompletedInCalendar: settings.hideCompletedInCalendar,
      ...(hidden === undefined ? {} : { hiddenCalendars: hidden }),
    },
    browser: input.userAgent,
    viewport: { width: input.viewport.width, height: input.viewport.height },
  }
}

/**
 * The file the user downloads: the server's report verbatim, plus what the browser knows as `client`: `context`,
 * then the placeholders and objects. Of the `objects` only the listed fields are written, so a label the dialog
 * shows (an event's title, a calendar's name) cannot get into the file with them. `content` is added only for the
 * IDs in `included`.
 */
export function assembleReport(
  server: DiagnosticsReport,
  context: ClientContext,
  corrupted: readonly CorruptedItem[],
  objects: readonly ReportObject[],
  included: ReadonlySet<string>,
): Record<string, unknown> {
  return {
    ...server,
    client: {
      ...context,
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
