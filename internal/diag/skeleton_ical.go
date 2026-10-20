package diag

import (
	"bytes"
	"regexp"
	"strings"
)

// malformedLine stands for a line that is no content line: no colon, or a
// name that is not one.
const malformedLine = "<malformed line>"

// dateKept are the characters, besides digits, that a date, a date-time and a
// list or period of them are made of. A value with any other is not one.
const dateKept = "TZ,/+-:. "

// dateProps are the properties whose value is a date, a date-time or a list or
// period of them. Their values show only the format.
var dateProps = map[string]bool{
	"DTSTART": true, "DTEND": true, "DUE": true, "DTSTAMP": true, "CREATED": true, "LAST-MODIFIED": true,
	"RECURRENCE-ID": true, "EXDATE": true, "RDATE": true, "COMPLETED": true,
}

// zoneProps are the properties of a time zone, whose lines stay as they are
// inside a VTIMEZONE: its rules are what time zone bugs hinge on and are not
// personal. Any other line inside one is masked like anywhere else, so an
// unterminated VTIMEZONE does not carry the rest of the document through.
var zoneProps = map[string]bool{
	"TZID": true, "LAST-MODIFIED": true, "TZURL": true, "X-LIC-LOCATION": true,
	"TZNAME": true, "TZOFFSETFROM": true, "TZOFFSETTO": true, "DTSTART": true, "RRULE": true, "RDATE": true,
}

// zoneComponents may sit inside a VTIMEZONE; a line in anything else does not
// count as a line of the zone.
var zoneComponents = map[string]bool{"VTIMEZONE": true, "STANDARD": true, "DAYLIGHT": true}

// fixed matches s, whole and in any case, against an alternation of fixed
// words or a pattern.
func fixed(alternation string) *regexp.Regexp {
	return regexp.MustCompile(`(?i)^(?:` + alternation + `)$`)
}

const (
	weekday  = `MO|TU|WE|TH|FR|SA|SU`
	integer  = `[0-9]{1,10}`
	numbers  = `[+-]?[0-9]{1,3}(?:,[+-]?[0-9]{1,3})*`
	ordinal  = `(?:[+-]?[0-9]{1,2})?(?:` + weekday + `)`
	duration = `[+-]?P[0-9WDTHMS]+`
)

// keptValues are the properties whose value stays as it is, and what the value
// has to look like to be kept. A value that does not look like it is what a
// parser rejects more often than not, and is masked: nothing in a skeleton
// depends on the word being right. PRODID is free text, but it names the
// software that wrote the document, and that is what the format bugs hinge on.
var keptValues = map[string]*regexp.Regexp{
	"PRODID":           fixed(`.*`),
	"VERSION":          fixed(`[0-9]{1,2}\.[0-9]{1,2}`),
	"CALSCALE":         fixed(`GREGORIAN`),
	"METHOD":           fixed(`PUBLISH|REQUEST|REPLY|ADD|CANCEL|REFRESH|COUNTER|DECLINECOUNTER`),
	"STATUS":           fixed(`TENTATIVE|CONFIRMED|CANCELLED|NEEDS-ACTION|COMPLETED|IN-PROCESS|DRAFT|FINAL`),
	"CLASS":            fixed(`PUBLIC|PRIVATE|CONFIDENTIAL`),
	"TRANSP":           fixed(`OPAQUE|TRANSPARENT`),
	"ACTION":           fixed(`AUDIO|DISPLAY|EMAIL`),
	"PRIORITY":         fixed(`-?` + integer),
	"SEQUENCE":         fixed(integer),
	"PERCENT-COMPLETE": fixed(`-?` + integer),
	"REPEAT":           fixed(integer),
	"DURATION":         fixed(duration),
	"TRIGGER":          fixed(duration), // a date-time TRIGGER is masked like a date
}

// keptParams are the parameters whose value stays as it is: the enumerations
// of RFC 5545. TZID is kept too, whatever it is, see renderParam.
var keptParams = map[string]*regexp.Regexp{
	"VALUE":    fixed(`BINARY|BOOLEAN|CAL-ADDRESS|DATE|DATE-TIME|DURATION|FLOAT|INTEGER|PERIOD|RECUR|TEXT|TIME|URI|UTC-OFFSET`),
	"RELATED":  fixed(`START|END`),
	"RANGE":    fixed(`THISANDFUTURE`),
	"FBTYPE":   fixed(`FREE|BUSY|BUSY-UNAVAILABLE|BUSY-TENTATIVE`),
	"ENCODING": fixed(`8BIT|BASE64`),
	"PARTSTAT": fixed(`NEEDS-ACTION|ACCEPTED|DECLINED|TENTATIVE|DELEGATED|COMPLETED|IN-PROCESS`),
	"ROLE":     fixed(`CHAIR|REQ-PARTICIPANT|OPT-PARTICIPANT|NON-PARTICIPANT`),
	"CUTYPE":   fixed(`INDIVIDUAL|GROUP|RESOURCE|ROOM|UNKNOWN`),
	"RSVP":     fixed(`TRUE|FALSE`),
}

// rruleParts are the parts of a recurrence rule and what their value has to
// look like. UNTIL is a date and handled apart.
var rruleParts = map[string]*regexp.Regexp{
	"FREQ":       fixed(`SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY`),
	"COUNT":      fixed(integer),
	"INTERVAL":   fixed(integer),
	"BYSECOND":   fixed(numbers),
	"BYMINUTE":   fixed(numbers),
	"BYHOUR":     fixed(numbers),
	"BYMONTHDAY": fixed(numbers),
	"BYYEARDAY":  fixed(numbers),
	"BYWEEKNO":   fixed(numbers),
	"BYMONTH":    fixed(numbers),
	"BYSETPOS":   fixed(numbers),
	"BYDAY":      fixed(ordinal + `(?:,` + ordinal + `)*`),
	"WKST":       fixed(weekday),
}

// ICalSkeleton returns the shape of an iCalendar document: its BEGIN/END
// structure, property and parameter names, and formats, one line per content
// line. It runs on documents a parser rejected, so it is a tokenizer that
// takes any bytes and never fails or panics; what it cannot make sense of is
// "<malformed line>".
//
// A line is unfolded (CRLF or LF, then a space or tab) and split into
// NAME;PARAM=VALUE:VALUE, quote-aware. Every value is masked as "…" (an empty
// one stays empty) except:
//
//   - BEGIN and END values that look like names, and the values of VERSION,
//     CALSCALE, METHOD, PRODID, STATUS, CLASS, TRANSP, ACTION, PRIORITY,
//     SEQUENCE, PERCENT-COMPLETE, REPEAT, DURATION and TRIGGER that look
//     like what they hold (PRODID: anything);
//   - date and time values, which keep their format only: every digit becomes
//     0, T, Z, ",", "/" and the signs and separators of the formats stay;
//   - RRULE and EXRULE, whose keys and enumerated values are kept, UNTIL
//     masked like a date;
//   - the time zone properties inside a VTIMEZONE, as they are.
//
// Parameter names stay. Parameter values are masked, except TZID and the
// enumerations VALUE, RELATED, RANGE, FBTYPE, ENCODING, PARTSTAT, ROLE, CUTYPE
// and RSVP. The text is cut on a line boundary at MaxSkeleton bytes.
func ICalSkeleton(data []byte) Skeleton {
	var (
		out   capped
		state icalState
		cur   []byte // the logical line being unfolded
		open  bool
	)
	flush := func() bool {
		if !open {
			return true
		}
		open = false
		return out.add(oneLine(state.render(string(cur))))
	}
	for len(data) > 0 {
		var line []byte
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			line, data = data[:i], data[i+1:]
		} else {
			line, data = data, nil
		}
		line = bytes.TrimSuffix(line, []byte{'\r'})
		if open && len(line) > 0 && (line[0] == ' ' || line[0] == '\t') {
			cur = append(cur, line[1:]...) // a fold: the line goes on
			continue
		}
		if !flush() {
			return out.skeleton()
		}
		if len(line) > 0 { // a blank line only ends the one before
			cur = append(cur[:0], line...)
			open = true
		}
	}
	flush()
	return out.skeleton()
}

// icalState is what the lines before one tell about it: the components it sits
// in, upper-cased; "" for one whose name is not one.
type icalState struct {
	stack []string
}

// render returns the skeleton line of an unfolded content line.
func (s *icalState) render(line string) string {
	colon := indexOutsideQuotes(line, ':')
	if colon < 0 {
		return malformedLine
	}
	head := splitOutsideQuotes(line[:colon], ';')
	name, params, value := head[0], head[1:], line[colon+1:]
	if !isToken(name) {
		return malformedLine
	}
	upper := strings.ToUpper(name)

	switch {
	case upper == "BEGIN" || upper == "END":
		s.track(upper == "BEGIN", value)
		if value != "" && !isToken(value) {
			value = mask
		}
	case zoneProps[upper] && s.inZone():
		return line
	default:
		value = propertyValue(upper, params, value)
	}
	return composeLine(name, params, value)
}

// track records a BEGIN or an END.
func (s *icalState) track(begin bool, value string) {
	name := strings.ToUpper(value)
	switch {
	case begin && isToken(value):
		s.stack = append(s.stack, name)
	case begin:
		s.stack = append(s.stack, "")
	case isToken(value):
		// An END closes the innermost component of its name, and what is
		// open inside that one.
		for i := len(s.stack) - 1; i >= 0; i-- {
			if s.stack[i] == name {
				s.stack = s.stack[:i]
				return
			}
		}
	}
}

// inZone reports whether the line sits in a VTIMEZONE, with nothing but zone
// components between it and the VTIMEZONE.
func (s *icalState) inZone() bool {
	for i := len(s.stack) - 1; i >= 0; i-- {
		if !zoneComponents[s.stack[i]] {
			return false
		}
		if s.stack[i] == "VTIMEZONE" {
			return true
		}
	}
	return false
}

// composeLine puts a skeleton line together from the name, the raw parameters
// and the value that is shown.
func composeLine(name string, params []string, value string) string {
	var b strings.Builder
	b.WriteString(name)
	for _, param := range params {
		b.WriteByte(';')
		b.WriteString(renderParam(param))
	}
	b.WriteByte(':')
	b.WriteString(value)
	return b.String()
}

// renderParam shows a parameter: its name if it is one, and its value if it is
// kept. TZID is kept as sent, and so is a TZID nobody would call a zone: it is
// what time zone bugs hinge on, and the design decides that it is not personal.
func renderParam(param string) string {
	name, value, ok := strings.Cut(param, "=")
	if !ok || !isToken(name) {
		return mask
	}
	upper := strings.ToUpper(name)
	if value != "" && upper != "TZID" && !matches(keptParams[upper], value) {
		value = mask
	}
	return name + "=" + value
}

// propertyValue shows the value of a property.
func propertyValue(upper string, params []string, value string) string {
	switch {
	case value == "":
		return ""
	case dateProps[upper] || upper == "TRIGGER" && hasDateTimeValue(params):
		return maskDate(value)
	case upper == "RRULE" || upper == "EXRULE":
		return maskRRule(value)
	case matches(keptValues[upper], value):
		return value
	}
	return mask
}

// matches reports whether re accepts s; no pattern accepts nothing.
func matches(re *regexp.Regexp, s string) bool {
	return re != nil && re.MatchString(s)
}

// hasDateTimeValue reports whether a parameter says VALUE=DATE-TIME.
func hasDateTimeValue(params []string) bool {
	for _, param := range params {
		name, value, _ := strings.Cut(param, "=")
		if strings.EqualFold(name, "VALUE") && strings.EqualFold(value, "DATE-TIME") {
			return true
		}
	}
	return false
}

// maskDate gives a date, a date-time or a list or period of them its format:
// every digit becomes 0, and T, Z, ",", "/" and the signs and separators stay.
// Anything else in the value means it is no date, and it is masked.
func maskDate(value string) string {
	out := make([]byte, len(value))
	for i := range len(value) {
		switch c := value[i]; {
		case c >= '0' && c <= '9':
			out[i] = '0'
		case strings.IndexByte(dateKept, c) >= 0:
			out[i] = c
		default:
			return mask
		}
	}
	return string(out)
}

// maskRRule keeps the keys of a recurrence rule and the values that look like
// the enumerations and numbers they should be, and shows UNTIL as a date. A
// part that is not a known key is masked whole.
func maskRRule(value string) string {
	parts := strings.Split(value, ";")
	for i, part := range parts {
		key, val, ok := strings.Cut(part, "=")
		upper := strings.ToUpper(key)
		switch {
		case part == "":
		case !ok:
			parts[i] = mask
		case upper == "UNTIL":
			parts[i] = key + "=" + maskDate(val)
		case rruleParts[upper] == nil:
			parts[i] = mask
		case val != "" && !rruleParts[upper].MatchString(val):
			parts[i] = key + "=" + mask
		}
	}
	return strings.Join(parts, ";")
}

// indexOutsideQuotes returns the index of the first sep in s that is not
// inside double quotes, or -1. A quote that never closes hides the rest.
func indexOutsideQuotes(s string, sep byte) int {
	quoted := false
	for i := range len(s) {
		switch c := s[i]; {
		case c == '"':
			quoted = !quoted
		case c == sep && !quoted:
			return i
		}
	}
	return -1
}

// splitOutsideQuotes splits s at every sep that is not inside double quotes.
func splitOutsideQuotes(s string, sep byte) []string {
	var parts []string
	for {
		i := indexOutsideQuotes(s, sep)
		if i < 0 {
			return append(parts, s)
		}
		parts = append(parts, s[:i])
		s = s[i+1:]
	}
}
