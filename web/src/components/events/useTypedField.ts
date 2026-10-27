import {
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react'

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
 * follows it before anything is committed.
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
  setOpen: (open: boolean) => void
  preview: string | null
  unreadable: boolean
  commit: (via: CommitVia, value?: string) => void
  restore: () => void
  /** Writes `text` into the field as if typed, without opening the popover: an entry the arrow keys reach. */
  setText: (text: string) => void
  inputProps: InputHTMLAttributes<HTMLInputElement> & { ref: RefObject<HTMLInputElement | null> }
} {
  const { value, canonical, restText, editText, read, optional, onChange } = o
  const ref = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [open, setOpen] = useState(false)
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
    onBlur: () => {
      commit('blur')
      setFocused(false)
      setDraft(null)
    },
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setDraft({ text: e.target.value, edited: true })
      setOpen(true)
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing) return
      if (e.key === 'Enter') {
        // Commits only: the form around the field isn't sent.
        e.preventDefault()
        commit('enter')
      } else if (e.key === 'ArrowDown' && !open) {
        e.preventDefault()
        setOpen(true)
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
      setOpen(true)
    },
  }

  return {
    text,
    focused,
    open,
    setOpen,
    preview,
    unreadable,
    commit,
    restore,
    setText: (next: string) => {
      setDraft({ text: next, edited: true })
    },
    inputProps,
  }
}
