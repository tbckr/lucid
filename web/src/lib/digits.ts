const decimal = /\p{Nd}/u

/**
 * `text` with the digits of every script as ASCII digits and full-width forms
 * as ASCII ones, so the typed date and time fields read the numbers a keyboard
 * of any script types: `２８．１０．２０２６`, `٢٨/١٠/٢٠٢٦`, `۲۸`, `９：４０`
 * (FR-09). NFKC folds the full-width digits and punctuation; the digits of a
 * script of its own (Arabic-Indic, Persian, Devanagari, Thai, ...) fold to
 * nothing, so each one reads as its place in its run: Unicode encodes every
 * decimal digit in a run of ten from 0 to 9, and runs that follow each other
 * (Myanmar's Pao and Eastern Pwo Karen digits) count on by tens.
 */
export function latinDigits(text: string): string {
  return text.normalize('NFKC').replace(/\p{Nd}/gu, (digit) => {
    let at = digit.codePointAt(0) ?? 0
    let place = 0
    while (decimal.test(String.fromCodePoint(at - 1))) {
      at--
      place++
    }
    return String(place % 10)
  })
}
