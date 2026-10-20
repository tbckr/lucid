package diag

import (
	"regexp"
	"strings"
)

// maxReason caps Reason at this many runes.
const maxReason = 300

// fixedNames are the uppercase tokens a parser message may carry without
// them being calendar content: names of the protocols and of the iCalendar
// vocabulary (RFC 5545), which the parsers use in their wording ("invalid
// VEVENT STATUS"). A token is a run of capitals and inner hyphens (UTF-8 is the
// one with a digit); anything else uppercase is dropped by Reason.
var fixedNames = []string{
	// Parsers and encodings.
	"EOF", "XML", "UTF", "UTF-8",
	// Components (3.6).
	"VCALENDAR", "VEVENT", "VTODO", "VJOURNAL", "VFREEBUSY", "VTIMEZONE", "VALARM", "STANDARD", "DAYLIGHT",
	// Properties (3.7, 3.8).
	"CALSCALE", "METHOD", "PRODID", "VERSION",
	"ATTACH", "CATEGORIES", "CLASS", "COMMENT", "DESCRIPTION", "GEO", "LOCATION", "PERCENT-COMPLETE",
	"PRIORITY", "RESOURCES", "STATUS", "SUMMARY",
	"COMPLETED", "DTEND", "DUE", "DTSTART", "DURATION", "FREEBUSY", "TRANSP",
	"TZID", "TZNAME", "TZOFFSETFROM", "TZOFFSETTO", "TZURL",
	"ATTENDEE", "CONTACT", "ORGANIZER", "RECURRENCE-ID", "RELATED-TO", "URL", "UID",
	"EXDATE", "RDATE", "RRULE",
	"ACTION", "REPEAT", "TRIGGER",
	"CREATED", "DTSTAMP", "LAST-MODIFIED", "SEQUENCE",
	"REQUEST-STATUS", "BEGIN", "END",
	// Parameters (3.2).
	"ALTREP", "CN", "CUTYPE", "DELEGATED-FROM", "DELEGATED-TO", "DIR", "ENCODING", "FMTTYPE", "FBTYPE",
	"LANGUAGE", "MEMBER", "PARTSTAT", "RANGE", "RELATED", "RELTYPE", "ROLE", "RSVP", "SENT-BY", "VALUE",
	// Value types (3.3).
	"BINARY", "BOOLEAN", "CAL-ADDRESS", "DATE", "DATE-TIME", "FLOAT", "INTEGER", "PERIOD", "RECUR", "TEXT",
	"TIME", "URI", "UTC-OFFSET",
}

var (
	// runeLiteral matches a Go-quoted rune, 'x' with backslash escapes. It is
	// masked before quoted strings, or a '"' would pair with a later quote.
	runeLiteral = regexp.MustCompile(`'(?:[^'\\]|\\[^']+|\\')'`)
	// quoted matches a Go-quoted string, "..." with backslash escapes.
	quoted = regexp.MustCompile(`(?s)"(?:[^"\\]|\\.)*"`)
	// fixedWording matches a segment of a masked message that holds nothing
	// but lowercase ASCII letters, spaces, the placeholders, a position after
	// "line " or "column " (encoding/xml reports where it failed) and the
	// fixedNames as whole tokens.
	fixedWording = compileFixedWording()
)

func compileFixedWording() *regexp.Regexp {
	names := make([]string, len(fixedNames))
	for i, name := range fixedNames {
		names[i] = regexp.QuoteMeta(name)
	}
	return regexp.MustCompile(`^(?:[a-z ]|'…'|"…"|\b(?:line|column) [0-9]+\b|\b(?:` + strings.Join(names, "|") + `)\b)*$`)
}

// Reason reduces err's message to its fixed wording, cut to 300 runes
// (NFR-36). The parsers put the value they choked on into the message, some
// quoted (`invalid VEVENT STATUS: "secret"`), some bare (`undefined frequency:
// secret`), and that value is calendar content. So Reason masks every quoted
// rune and string as '…' and "…", splits the message on ": " and keeps the
// leading segments that consist only of lowercase ASCII letters, spaces, those
// placeholders, the fixedNames and a number after "line " or "column ". The
// first segment with anything else, and all after it, are dropped. A message
// of which nothing is kept gives "…". A nil error gives "".
//
// The shape is all Reason can go by: wording with a capital, a digit or
// punctuation outside those exceptions is dropped even if it is fixed, and an
// echoed value that is nothing but lowercase letters and spaces is kept.
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
	if keep == 0 {
		return "…"
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
