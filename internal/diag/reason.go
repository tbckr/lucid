package diag

import (
	"regexp"
	"strings"
)

// maxReason caps Reason at this many runes.
const maxReason = 300

var (
	// runeLiteral matches a Go-quoted rune, 'x' with backslash escapes. It is
	// masked before quoted strings, or a '"' would pair with a later quote.
	runeLiteral = regexp.MustCompile(`'(?:[^'\\]|\\[^']+|\\')'`)
	// quoted matches a Go-quoted string, "..." with backslash escapes.
	quoted = regexp.MustCompile(`(?s)"(?:[^"\\]|\\.)*"`)
	// fixedWording matches a segment of a masked message that holds nothing
	// but lowercase ASCII letters, spaces and the placeholders.
	fixedWording = regexp.MustCompile(`^(?:[a-z ]|'…'|"…")*$`)
)

// Reason reduces err's message to its fixed wording, cut to 300 runes
// (NFR-36). The parsers put the value they choked on into the message, some
// quoted (`invalid VEVENT STATUS: "secret"`), some bare (`undefined frequency:
// secret`), and that value is calendar content. So Reason masks every quoted
// rune and string as '…' and "…", splits the message on ": " and keeps the
// leading segments that consist only of lowercase ASCII letters, spaces and
// those placeholders. The first segment with anything else, and all after it,
// are dropped. A nil error gives "".
//
// The shape is all Reason can go by: wording that starts with a capital, a
// digit or punctuation is dropped even if it is fixed, and an echoed value
// that is nothing but lowercase letters and spaces is kept.
func Reason(err error) string {
	if err == nil {
		return ""
	}
	msg := runeLiteral.ReplaceAllLiteralString(err.Error(), `'…'`)
	msg = quoted.ReplaceAllLiteralString(msg, `"…"`)

	segments := strings.Split(msg, ": ")
	keep := 0
	for keep < len(segments) && fixedWording.MatchString(segments[keep]) {
		keep++
	}
	return truncate(strings.Join(segments[:keep], ": "), maxReason)
}

// truncate cuts s to at most n runes.
func truncate(s string, n int) string {
	count := 0
	for i := range s {
		if count == n {
			return s[:i]
		}
		count++
	}
	return s
}
