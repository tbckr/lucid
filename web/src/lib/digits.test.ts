import { describe, expect, it } from 'vitest'
import { latinDigits } from './digits'

describe('latinDigits', () => {
  it.each([
    ['keeps ASCII digits', '28.10.2026 9:40', '28.10.2026 9:40'],
    ['reads Arabic-Indic digits', '٢٨/١٠/٢٠٢٦', '28/10/2026'],
    ['reads Persian digits', '۲۰۲۶/۱۰/۲۸', '2026/10/28'],
    ['reads Devanagari digits', '२८.१०.२०२६', '28.10.2026'],
    ['reads Thai digits', '๙:๔๐', '9:40'],
    ['reads full-width digits and punctuation', '２８．１０．２０２６ ９：４０', '28.10.2026 9:40'],
    // Myanmar's Pao digits, then those of Eastern Pwo Karen: twenty in a row.
    ['reads the second of two runs of ten in a row', '\u{116D2}\u{116D8} \u{116DC}\u{116E2}', '28 28'],
    ['keeps letters', '9:40 nachm. 오후 г.', '9:40 nachm. 오후 г.'],
  ])('%s', (_, text, want) => {
    expect(latinDigits(text)).toBe(want)
  })
})
