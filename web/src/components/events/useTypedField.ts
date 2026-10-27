import {
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react'

// The one move of the focus `followFocus` waits to check: the document has one focus, and a later move replaces
// an earlier one still waiting, which would otherwise take the focus back.
let following: ReturnType<typeof setTimeout> | undefined

/**
 * Sends the focus on to `next`, where it was going when the field was left, if the commit took it elsewhere
 * (NFR-27). A commit that takes a node out of a Radix dialog or modal popover, such as a note that no longer
 * applies, does so while the focus is on its way, on the body: the dialog's focus trap then keeps the focus
 * itself, and the next Tab would start over at its top.
 */
function followFocus(next: EventTarget | null) {
  clearTimeout(following)
  if (!(next instanceof HTMLElement)) return
  following = setTimeout(() => {
    const at = document.activeElement
    if (at !== next && next.isConnected && at instanceof HTMLElement && at.contains(next)) next.focus()
  })
}

/** How a typed field's value was committed: Enter, a pick in its popover, or leaving the field (FR-09). */
export type CommitVia = 'enter' | 'pick' | 'blur'

/** The text in the field while it has the focus, and whether the user changed it since the focus or the last commit. */
interface Draft {
  text: string
  edited: boolean
}

/**
 * The typing behind the date and time fields (FR-09): a text input that reads
 * what was typed on Enter, when it is left, or takes what is picked in its
 * popover, and passes the result up through `onChange` as the form holds it.
 *
 * `value` is the form's: canonical (`canonical`), `''`, or text the field
 * couldn't read, which it passed up as typed, so the form's checks keep it
 * from being saved. At rest the field shows `restText` of a canonical value,
 * on focus `editText`, all selected, so typing replaces it; text it couldn't
 * read shows as it is, and marks the input `aria-invalid`.
 *
 * A commit reads the text with `read`: what it reads goes up if it differs
 * from `value`, and the text becomes its `editText`, all selected, so the
 * field shows what was read and the next keystroke replaces it. Empty text
 * clears an `optional` field and restores a required one; text it can't
 * read goes up trimmed, as it is. Leaving the field without typing commits
 * nothing.
 *
 * A click or tap opens the popover, typing and ArrowDown too; focus by Tab
 * doesn't (NFR-27). `preview` is what a commit would take now (`''` for an
 * optional field emptied), `null` while the text can't be read: the popover
 * follows it before anything is committed. `lastRead` is the last value the
 * field could read (`''` before there was one), which it keeps to while its
 * text can't be read, such as for its width.
 */
export function useTypedField(o: {
  value: string
  canonical: (v: string) => boolean
  restText: (v: string) => string
  editText: (v: string) => string
  read: (text: string) => string | null
  optional: boolean
  onChange: (value: string, via: CommitVia) => void
}): {
  text: string
  focused: boolean
  open: boolean
  /** Opens or closes the popover; it doesn't open while the field is disabled, by a prop or a fieldset around. */
  setOpen: (open: boolean) => void
  preview: string | null
  unreadable: boolean
  lastRead: string
  commit: (via: CommitVia, value?: string) => void
  restore: () => void
  /** Writes `text` into the field as if typed, without opening the popover: an entry the arrow keys reach. */
  setText: (text: string) => void
  /**
   * Leaves the field for `next`, as a blur of the input does: for a popover the focus can go into (the date
   * field's month).
   */
  leave: (next: EventTarget | null) => void
  inputProps: InputHTMLAttributes<HTMLInputElement> & { ref: RefObject<HTMLInputElement | null> }
} {
  const { value, canonical, restText, editText, read, optional, onChange } = o
  const ref = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [open, setOpen] = useState(false)
  const [lastRead, setLastRead] = useState(canonical(value) ? value : '')
  if (canonical(value) && value !== lastRead) setLastRead(value)
  // Select all once the text the render shows is in the input.
  const selectAll = useRef(false)
  // A press that focuses the field: its release selects all, as browsers place the caret there.
  const pressFocus = useRef(false)

  // Text the field couldn't read shows as it is, at rest and while focused.
  const shown = (v: string, as: (v: string) => string) => (v !== '' && canonical(v) ? as(v) : v)
  const unreadable = value !== '' && !canonical(value)
  const text = focused ? (draft?.text ?? shown(value, editText)) : shown(value, restText)
  const trimmed = text.trim()
  const preview = trimmed === '' ? (optional ? '' : null) : read(trimmed)

  useLayoutEffect(() => {
    if (!selectAll.current) return
    selectAll.current = false
    if (ref.current === document.activeElement) ref.current?.select()
  })

  // A fieldset around the field can disable it, which no prop says: then nothing opens its popover, so nothing is
  // picked there either, as on a series Lucid can only keep or remove (FR-17).
  const openIf = (next: boolean) => {
    if (next && ref.current?.matches(':disabled')) return
    setOpen(next)
  }

  const restore = () => {
    setOpen(false)
    setDraft(null)
    selectAll.current = true
  }

  const commit = (via: CommitVia, picked?: string) => {
    setOpen(false)
    let next: string
    if (picked !== undefined) next = picked
    // Nothing typed since the focus or the last commit: nothing to read again.
    else if (!draft?.edited) next = value
    else if (trimmed === '') next = ''
    else next = read(trimmed) ?? trimmed
    if (next === '' && !optional) {
      restore()
      return
    }
    if (next !== value) onChange(next, via)
    setDraft({ text: shown(next, editText), edited: false })
    selectAll.current = true
  }

  const leave = (next: EventTarget | null) => {
    commit('blur')
    setFocused(false)
    setDraft(null)
    followFocus(next)
  }

  const inputProps = {
    ref,
    type: 'text',
    value: text,
    autoComplete: 'off',
    spellCheck: false,
    'aria-invalid': unreadable || undefined,
    onFocus: () => {
      setFocused(true)
      setDraft(null)
      selectAll.current = true
    },
    onBlur: (e: FocusEvent<HTMLInputElement>) => {
      leave(e.relatedTarget)
    },
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setDraft({ text: e.target.value, edited: true })
      openIf(true)
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing) return
      if (e.key === 'Enter') {
        // Commits only: the form around the field isn't sent.
        e.preventDefault()
        commit('enter')
      } else if (e.key === 'ArrowDown' && !open) {
        e.preventDefault()
        openIf(true)
      }
    },
    onMouseDown: (e: MouseEvent<HTMLInputElement>) => {
      pressFocus.current = e.currentTarget !== document.activeElement
    },
    onMouseUp: (e: MouseEvent<HTMLInputElement>) => {
      if (!pressFocus.current) return
      pressFocus.current = false
      const input = e.currentTarget
      // Unless the press dragged over a part of the text.
      if (input.selectionStart === input.selectionEnd) {
        e.preventDefault()
        input.select()
      }
    },
    onClick: () => {
      openIf(true)
    },
  }

  return {
    text,
    focused,
    open,
    setOpen: openIf,
    preview,
    unreadable,
    lastRead,
    commit,
    restore,
    setText: (next: string) => {
      setDraft({ text: next, edited: true })
    },
    leave,
    inputProps,
  }
}

/**
 * The last start, date and time, that could be read (FR-09): the start itself
 * while `readable`, else the one before its field took text it couldn't read.
 * A start corrected after such text moves the end from there, so the entry
 * keeps its length across the unreadable step; while the start can't be read,
 * the end stays.
 */
export function useReadableStart(date: string, time: string, readable: boolean): { date: string; time: string } {
  const [last, setLast] = useState({ date, time })
  if (readable && (last.date !== date || last.time !== time)) setLast({ date, time })
  return readable ? { date, time } : last
}
