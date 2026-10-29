import { de } from 'date-fns/locale/de'
import { enGB } from 'date-fns/locale/en-GB'
import { enUS } from 'date-fns/locale/en-US'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { type FormatPrefs } from './format'
import {
  allZones,
  canonicalZone,
  fieldZone,
  genericName,
  inYourZone,
  knownZone,
  PICKED_UTC,
  sameZone,
  wallDate,
  zoneCity,
  zoneGroups,
  zoneOffset,
  zonesInUse,
} from './zones'

// Tests run with TZ=Europe/Berlin (see vite.config.ts). Zone IDs below are the ones a stored item or a picker names;
// what Intl makes of them (`Asia/Calcutta` for `Asia/Kolkata`) is only compared, never spelled out (FR-18).

afterEach(() => {
  vi.restoreAllMocks()
})

describe('canonicalZone', () => {
  it('is the zone Intl formats in, so two names of one zone give one', () => {
    expect(canonicalZone('Asia/Kolkata')).toBe(canonicalZone('Asia/Calcutta'))
    expect(canonicalZone('Etc/UTC')).toBe(canonicalZone('UTC'))
    expect(canonicalZone('US/Eastern')).toBe(canonicalZone('America/New_York'))
  })

  it('is the input where Intl rejects it', () => {
    expect(canonicalZone('Mars/Olympus')).toBe('Mars/Olympus')
    expect(canonicalZone('')).toBe('')
  })
})

describe('sameZone', () => {
  it.each([
    ['Asia/Kolkata', 'Asia/Calcutta', true],
    ['Etc/UTC', 'UTC', true],
    ['Europe/Kyiv', 'Europe/Kiev', true],
    ['', 'UTC', false],
    ['', 'Etc/UTC', false],
    ['', '', true],
    ['Mars/Olympus', 'Mars/Olympus', true],
    ['Mars/Olympus', 'UTC', false],
    ['Europe/Berlin', 'Europe/Paris', false],
  ])('%j and %j: %j', (a, b, same) => {
    expect(sameZone(a, b)).toBe(same)
    expect(sameZone(b, a)).toBe(same)
  })
})

describe('knownZone', () => {
  it('is whether Intl can format in the zone', () => {
    expect(knownZone('Europe/Berlin')).toBe(true)
    expect(knownZone('Etc/UTC')).toBe(true)
    expect(knownZone('UTC')).toBe(true)
    expect(knownZone('Mars/Olympus')).toBe(false)
    expect(knownZone('')).toBe(false)
  })
})

describe('fieldZone', () => {
  it('is the zone a row is in, the browser zone where it has none or Intl does not know it', () => {
    expect(fieldZone('Mars/Olympus', 'Europe/Berlin')).toBe('Europe/Berlin')
    expect(fieldZone('', 'Europe/Berlin')).toBe('Europe/Berlin')
    expect(fieldZone('Asia/Tokyo', 'Europe/Berlin')).toBe('Asia/Tokyo')
  })
})

describe('zoneCity', () => {
  it('is the last segment of the ID, spaced', () => {
    expect(zoneCity('America/New_York')).toBe('New York')
    expect(zoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires')
    expect(zoneCity('Europe/Berlin')).toBe('Berlin')
  })

  it('calls every name of UTC "UTC"', () => {
    expect(zoneCity('UTC')).toBe('UTC')
    expect(zoneCity('Etc/UTC')).toBe('UTC')
    expect(zoneCity('GMT')).toBe('UTC')
  })

  it('keeps the name of a zone Intl does not know', () => {
    expect(zoneCity('Mars/Olympus_Mons')).toBe('Olympus Mons')
  })
})

describe('zoneOffset', () => {
  const autumn = new Date('2026-10-28T12:00:00Z')

  it('is the wall clock minus the instant, with a true minus', () => {
    expect(zoneOffset('Europe/Berlin', autumn)).toBe('UTC+1')
    expect(zoneOffset('America/New_York', autumn)).toBe('UTC−4')
    expect(zoneOffset('Asia/Kolkata', autumn)).toBe('UTC+5:30')
    expect(zoneOffset('America/St_Johns', autumn)).toBe('UTC−2:30')
    expect(zoneOffset('UTC', autumn)).toBe('UTC+0')
    expect(zoneOffset(PICKED_UTC, autumn)).toBe('UTC+0')
  })

  it("is the instant's, so daylight saving time moves it", () => {
    expect(zoneOffset('America/New_York', new Date('2026-11-02T12:00:00Z'))).toBe('UTC−5')
    expect(zoneOffset('Europe/Berlin', new Date('2026-07-01T12:00:00Z'))).toBe('UTC+2')
  })

  it('reads minutes past the hour of a negative offset right', () => {
    expect(zoneOffset('America/St_Johns', new Date('2026-12-01T12:00:00Z'))).toBe('UTC−3:30')
    expect(zoneOffset('Pacific/Kiritimati', autumn)).toBe('UTC+14')
  })

  it('does not let the milliseconds of the instant shift it', () => {
    expect(zoneOffset('America/New_York', new Date('2026-10-28T12:00:00.750Z'))).toBe('UTC−4')
    expect(zoneOffset('Europe/Berlin', new Date('1969-12-31T23:59:59.250Z'))).toBe('UTC+1')
  })

  it('is empty for a zone Intl does not know', () => {
    expect(zoneOffset('Mars/Olympus', autumn)).toBe('')
  })
})

describe('allZones', () => {
  it('is the zones Intl lists, and UTC picked as Etc/UTC', () => {
    const zones = allZones()
    expect(zones).toContain('Europe/Berlin')
    expect(zones).toContain('America/New_York')
    expect(zones).toContain(PICKED_UTC)
    expect(zones).toHaveLength(new Set(zones).size)
  })

  it('has UTC once where Intl lists it', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Europe/Berlin', 'UTC'])
    expect(allZones()).toEqual(['Europe/Berlin', PICKED_UTC])
  })

  it('is UTC alone without the API', () => {
    const supported = Intl.supportedValuesOf
    Reflect.set(Intl, 'supportedValuesOf', undefined)
    try {
      expect(allZones()).toEqual([PICKED_UTC])
    } finally {
      Reflect.set(Intl, 'supportedValuesOf', supported)
    }
  })
})

describe('zonesInUse', () => {
  it('has each zone once, without no zone and the browser zone, by city', () => {
    expect(
      zonesInUse(['America/New_York', '', 'Europe/Berlin', 'US/Eastern', 'Asia/Tokyo'], 'Europe/Berlin'),
    ).toEqual(['America/New_York', 'Asia/Tokyo'])
  })

  it('takes another name of the browser zone for the browser zone', () => {
    expect(zonesInUse(['Asia/Calcutta', 'Asia/Kolkata'], 'Asia/Kolkata')).toEqual([])
  })

  it('keeps a zone Intl does not know', () => {
    expect(zonesInUse(['Mars/Olympus', 'Mars/Olympus', 'Asia/Tokyo'], 'Europe/Berlin')).toEqual([
      'Mars/Olympus',
      'Asia/Tokyo',
    ])
  })

  it('takes any iterable', () => {
    expect(zonesInUse(new Set(['Asia/Tokyo', 'Asia/Tokyo']), 'Europe/Berlin')).toEqual(['Asia/Tokyo'])
  })

  it('keeps eight', () => {
    const nine = [
      'Asia/Tokyo',
      'Asia/Seoul',
      'Asia/Dubai',
      'Asia/Manila',
      'Asia/Karachi',
      'Africa/Cairo',
      'Africa/Lagos',
      'America/Lima',
      'America/Chicago',
    ]
    const zones = zonesInUse(nine, 'Europe/Berlin')
    expect(zones).toHaveLength(8)
    expect(zones).toEqual([
      'Africa/Cairo',
      'America/Chicago',
      'Asia/Dubai',
      'Asia/Karachi',
      'Africa/Lagos',
      'America/Lima',
      'Asia/Manila',
      'Asia/Seoul',
    ])
  })
})

describe('zoneGroups', () => {
  const at = new Date('2026-10-28T12:00:00Z')
  const base = {
    query: '',
    at,
    tag: 'en',
    browserZone: 'Europe/Berlin',
    inUse: ['America/New_York', 'Asia/Tokyo'],
    current: 'Europe/Berlin',
  }

  it('is the browser zone, the zones in use and every zone, without a query', () => {
    const groups = zoneGroups(base)
    expect(groups.map((g) => g.kind)).toEqual(['here', 'inUse', 'all'])
    expect(groups[0]?.zones).toEqual(['Europe/Berlin'])
    expect(groups[1]?.zones).toEqual(['America/New_York', 'Asia/Tokyo'])
    expect(groups[2]?.zones).toContain(PICKED_UTC)
    expect(groups[2]?.zones).toContain('Europe/Berlin')
  })

  it('lists every zone by city, then ID', () => {
    const all = zoneGroups(base).find((g) => g.kind === 'all')?.zones ?? []
    const cities = all.map(zoneCity)
    expect(cities).toEqual([...cities].sort(new Intl.Collator('en').compare))
    expect(all.indexOf('Europe/Berlin')).toBeLessThan(all.indexOf('Asia/Tokyo'))
  })

  it('adds the current zone where the list has no name of it', () => {
    const all = (current: string) => zoneGroups({ ...base, current }).find((g) => g.kind === 'all')?.zones ?? []
    expect(all('Mars/Olympus')).toContain('Mars/Olympus')
    expect(all('Mars/Olympus').indexOf('Mars/Olympus')).toBeGreaterThan(all('Europe/Berlin').indexOf('Europe/Berlin'))
    // A name the list has under another: Intl.
    expect(all('Asia/Kolkata').filter((z) => sameZone(z, 'Asia/Kolkata'))).toHaveLength(1)
    expect(all('UTC').filter((z) => sameZone(z, 'UTC'))).toEqual([PICKED_UTC])
    // No zone is no entry.
    expect(all('')).not.toContain('')
  })

  it('narrows to the zones a query matches and drops the groups that stay empty', () => {
    const groups = zoneGroups({ ...base, query: 'new y', browserZone: 'Europe/Lisbon' })
    expect(groups.map((g) => g.kind)).toEqual(['inUse', 'all'])
    expect(groups[0]?.zones).toEqual(['America/New_York'])
    expect(groups[1]?.zones).toContain('America/New_York')
    expect(groups[1]?.zones).not.toContain('Europe/Berlin')
  })

  it('keeps the browser zone while it matches', () => {
    const groups = zoneGroups({ ...base, query: 'berl' })
    expect(groups.map((g) => g.kind)).toEqual(['here', 'all'])
  })

  it('matches without regard to case, accents and the underscore of an ID', () => {
    const all = (query: string) => zoneGroups({ ...base, query }).find((g) => g.kind === 'all')?.zones ?? []
    expect(all('NEW YORK')).toContain('America/New_York')
    expect(all('new_york')).toContain('America/New_York')
    expect(all('america/new')).toContain('America/New_York')
    expect(all('são')).toContain('America/Sao_Paulo')
    expect(all('sao')).toContain('America/Sao_Paulo')
  })

  it('matches the name of the zone in the language of the tag', () => {
    const all = (tag: string, query: string) =>
      zoneGroups({ ...base, tag, query }).find((g) => g.kind === 'all')?.zones ?? []
    expect(all('de', 'Mitteleurop')).toContain('Europe/Berlin')
    expect(all('de', 'mez')).toContain('Europe/Berlin')
    expect(all('de', 'moskau')).toContain('Europe/Moscow')
    expect(all('en', 'central european')).toContain('Europe/Berlin')
    expect(all('en', 'Mitteleurop')).not.toContain('Europe/Berlin')
  })

  it('matches by city and ID where the tag is no language', () => {
    const groups = zoneGroups({ ...base, tag: 'not a tag', query: 'berl' })
    expect(groups.find((g) => g.kind === 'all')?.zones).toContain('Europe/Berlin')
  })

  it('matches the offset at the date, a minus with the hyphen too', () => {
    const all = (query: string, when = at) =>
      zoneGroups({ ...base, query, at: when }).find((g) => g.kind === 'all')?.zones ?? []
    expect(all('-4')).toContain('America/New_York')
    expect(all('−4')).toContain('America/New_York')
    expect(all('utc−4')).toContain('America/New_York')
    expect(all('UTC-4')).toContain('America/New_York')
    // The list's name of Kolkata is Intl's.
    expect(all('+5:30').some((zone) => sameZone(zone, 'Asia/Kolkata'))).toBe(true)
    expect(all('-4')).not.toContain('Europe/Berlin')
    // Offsets are the date's.
    expect(all('-5', new Date('2026-11-02T12:00:00Z'))).toContain('America/New_York')
    expect(all('-5')).not.toContain('America/New_York')
  })

  it('does not take "utc" for every offset', () => {
    const all = zoneGroups({ ...base, query: 'utc' }).find((g) => g.kind === 'all')?.zones ?? []
    expect(all).toContain(PICKED_UTC)
    expect(all).not.toContain('Europe/Berlin')
  })

  it('finds nothing for a query no zone matches', () => {
    expect(zoneGroups({ ...base, query: 'zzzzzz' })).toEqual([])
  })

  it('lists a current zone Intl does not know where it matches', () => {
    const groups = zoneGroups({ ...base, query: 'olympus', current: 'Mars/Olympus' })
    expect(groups).toEqual([{ kind: 'all', zones: ['Mars/Olympus'] }])
  })
})

describe('genericName', () => {
  const at = new Date('2026-10-28T12:00:00Z')

  it('is the name of the zone in the language of the tag, whichever the date', () => {
    expect(genericName('America/New_York', 'en-US', 'longGeneric', at)).toBe('Eastern Time')
    expect(genericName('America/New_York', 'en-US', 'longGeneric', new Date('2026-01-15T12:00:00Z'))).toBe('Eastern Time')
    expect(genericName('Europe/Berlin', 'de', 'longGeneric', at)).toMatch(/^Mitteleurop/)
    expect(genericName('Europe/Berlin', 'de', 'shortGeneric', at)).toBe('MEZ')
  })

  it('is empty where Intl rejects the zone or the tag', () => {
    expect(genericName('Mars/Olympus', 'en', 'longGeneric', at)).toBe('')
    expect(genericName('Europe/Berlin', 'not a tag', 'longGeneric', at)).toBe('')
  })
})

describe('wallDate', () => {
  it("is a local Date with the instant's wall clock in the zone", () => {
    const d = wallDate(new Date('2026-11-10T23:00:00Z'), 'America/New_York')
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([
      2026, 10, 10, 18, 0, 0,
    ])
  })

  it('moves the day across midnight and keeps the milliseconds', () => {
    const d = wallDate(new Date('2026-11-10T23:30:15.250Z'), 'Asia/Tokyo')
    expect([d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      11, 8, 30, 15, 250,
    ])
  })
})

describe('inYourZone', () => {
  const us: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
  const gb: FormatPrefs = { tag: 'en-GB', locale: enGB, hourCycle: '24h', weekStartsOn: 1 }
  const deDE: FormatPrefs = { tag: 'de-DE', locale: de, hourCycle: '24h', weekStartsOn: 1 }
  const en = i18n.getFixedT('en')
  const now = new Date(2026, 9, 28)
  const berlin = 'Europe/Berlin'
  const ny = 'America/New_York'
  // 18:00 to 23:00 in New York on Tuesday, 27 October 2026: 23:00 to 04:00 the next day in Berlin.
  const start = new Date('2026-10-27T22:00:00Z')
  const end = new Date('2026-10-28T03:00:00Z')
  /** Whitespace a line can break at before the dash, or between a number and a word beside it. */
  const breaks = /[ \u2009]–|\d\.? (?=\p{L})|\p{L}\.? (?=\d)/u

  it('says where an item in another zone lies here, a day keeping its month, a time its "PM" and the dash its first time', () => {
    const text = inYourZone(en, us, now, { zones: [ny, ny], browserZone: berlin, start, end })
    expect(text).toBe('In your time zone (Berlin): Tue, Oct\u00a027, 11:00\u202fPM\u202f–\u2009Wed, Oct\u00a028, 4:00\u202fAM')
    expect(text).not.toMatch(breaks)
  })

  it('says one time where the item has one, such as a task due then', () => {
    // Intl separates "PM" by a plain space here, as browsers do in ranges too.
    expect(inYourZone(en, us, now, { zones: [ny], browserZone: berlin, start, end: start })).toBe(
      'In your time zone (Berlin): Tue, Oct\u00a027, 11:00\u00a0PM',
    )
  })

  it.each([
    ['en-GB', gb, en, 'In your time zone (Berlin): Tue\u00a027\u00a0Oct, 23:00\u202f–\u2009Wed\u00a028\u00a0Oct, 04:00'],
    ['de', deDE, i18n.getFixedT('de'), 'In deiner Zeitzone (Berlin): Di., 27.\u00a0Okt., 23:00\u202f–\u2009Mi., 28.\u00a0Okt., 04:00'],
  ])('keeps a day with its month and weekday in %s', (_, prefs, t, want) => {
    const text = inYourZone(t, prefs, now, { zones: [ny, ny], browserZone: berlin, start, end })
    expect(text).toBe(want)
    expect(text).not.toMatch(breaks)
  })

  it("names the browser's zone, and its times", () => {
    expect(inYourZone(en, us, now, { zones: [berlin, berlin], browserZone: ny, start, end: start })).toBe(
      'In your time zone (New York): Tue, Oct\u00a027, 6:00\u00a0PM',
    )
  })

  it('says it while one row is in another zone', () => {
    expect(inYourZone(en, us, now, { zones: ['', ny], browserZone: berlin, start, end })).not.toBeNull()
  })

  it.each([
    ['without a zone', ['', ''], berlin],
    ["in the browser's", [berlin, ''], berlin],
    ["in the browser's under another name", ['Asia/Calcutta'], 'Asia/Kolkata'],
    ["in one Intl does not know, whose fields are the browser's", ['Mars/Olympus'], berlin],
    ['none, without rows', [], berlin],
  ])('says nothing while every row is %s', (_, zones, browserZone) => {
    expect(inYourZone(en, us, now, { zones, browserZone, start, end })).toBeNull()
  })

  it('says nothing for an end before the start, which the form refuses', () => {
    expect(inYourZone(en, us, now, { zones: [ny], browserZone: berlin, start: end, end: start })).toBeNull()
  })
})
