package diag

import "regexp"

// maxReason caps Reason at this many runes.
const maxReason = 300

// quoted matches a Go-quoted string, "..." with backslash escapes.
var quoted = regexp.MustCompile(`(?s)"(?:[^"\\]|\\.)*"`)

// Reason returns err's message with every quoted string replaced by "…", cut
// to 300 runes (NFR-36). The parsers quote the value they choked on, which is
// calendar content: `ical: invalid VEVENT STATUS: "secret"` becomes
// `ical: invalid VEVENT STATUS: "…"`. A nil error gives "".
func Reason(err error) string {
	if err == nil {
		return ""
	}
	s := quoted.ReplaceAllLiteralString(err.Error(), `"…"`)
	n := 0
	for i := range s {
		if n == maxReason {
			return s[:i]
		}
		n++
	}
	return s
}
