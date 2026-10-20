package diag

import "regexp"

// icalNames is the vocabulary of iCalendar names that carry no calendar
// content (NFR-36): the components, properties and parameters of RFC 5545 and
// of the extensions a CalDAV server meets, RFC 6638 (scheduling), RFC 7986
// (new properties), and RFC 9073 and 9074 (events, participants, alarms). Both
// users decide by it what is fixed wording and what is somebody's text:
//
//   - Reason keeps these uppercase words in a parser message;
//   - ICalSkeleton shows a property, parameter or component name only if it is
//     one of them or an x-name (see isXName).
//
// The match is exact: a name in any other case is not one. A name that is
// missing here is masked, which costs a diagnostic, never a leak. The names are
// listed once, and the three kinds share the list: a skeleton does not care
// which role a name is in. Value types and the parsers' own words are Reason's
// business and sit in fixedNames.
var icalNames = []string{
	// Components: RFC 5545 3.6, RFC 9073 (VLOCATION, VRESOURCE, PARTICIPANT).
	"VCALENDAR", "VEVENT", "VTODO", "VJOURNAL", "VFREEBUSY", "VTIMEZONE", "VALARM", "STANDARD", "DAYLIGHT",
	"VLOCATION", "VRESOURCE", "PARTICIPANT",
	// Properties: RFC 5545 3.7, 3.8 and EXRULE of RFC 2445, which servers still send.
	"CALSCALE", "METHOD", "PRODID", "VERSION",
	"ATTACH", "CATEGORIES", "CLASS", "COMMENT", "DESCRIPTION", "GEO", "LOCATION", "PERCENT-COMPLETE",
	"PRIORITY", "RESOURCES", "STATUS", "SUMMARY",
	"COMPLETED", "DTEND", "DUE", "DTSTART", "DURATION", "FREEBUSY", "TRANSP",
	"TZID", "TZNAME", "TZOFFSETFROM", "TZOFFSETTO", "TZURL",
	"ATTENDEE", "CONTACT", "ORGANIZER", "RECURRENCE-ID", "RELATED-TO", "URL", "UID",
	"EXDATE", "RDATE", "RRULE", "EXRULE",
	"ACTION", "REPEAT", "TRIGGER",
	"CREATED", "DTSTAMP", "LAST-MODIFIED", "SEQUENCE",
	"REQUEST-STATUS", "BEGIN", "END",
	// Properties: RFC 7986 (NAME, REFRESH-INTERVAL, SOURCE, COLOR, IMAGE, CONFERENCE),
	// RFC 9073 and RFC 9074 (ACKNOWLEDGED, PROXIMITY).
	"NAME", "REFRESH-INTERVAL", "SOURCE", "COLOR", "IMAGE", "CONFERENCE",
	"STRUCTURED-DATA", "STYLED-DESCRIPTION", "LOCATION-TYPE", "PARTICIPANT-TYPE", "RESOURCE-TYPE", "CALENDAR-ADDRESS",
	"ACKNOWLEDGED", "PROXIMITY",
	// Parameters: RFC 5545 3.2 (TZID is a property as well), RFC 7986 (DISPLAY, EMAIL,
	// FEATURE, LABEL), RFC 6638 (SCHEDULE-AGENT, SCHEDULE-FORCE-SEND, SCHEDULE-STATUS).
	"ALTREP", "CN", "CUTYPE", "DELEGATED-FROM", "DELEGATED-TO", "DIR", "ENCODING", "FMTTYPE", "FBTYPE",
	"LANGUAGE", "MEMBER", "PARTSTAT", "RANGE", "RELATED", "RELTYPE", "ROLE", "RSVP", "SENT-BY", "VALUE",
	"DISPLAY", "EMAIL", "FEATURE", "LABEL",
	"SCHEDULE-AGENT", "SCHEDULE-FORCE-SEND", "SCHEDULE-STATUS",
}

// icalNameSet is icalNames for lookup.
var icalNameSet = func() map[string]bool {
	set := make(map[string]bool, len(icalNames))
	for _, name := range icalNames {
		set[name] = true
	}
	return set
}()

// xName matches an x-name in uppercase, the extension names of RFC 5545 3.8.8.2
// (X-WR-CALNAME, X-APPLE-STRUCTURED-LOCATION): vendor names, not text. One in
// any other case is not shown.
var xName = regexp.MustCompile(`^X-[A-Z0-9-]+$`)

// knownName reports whether name is one a skeleton shows: one of icalNames or
// an x-name.
func knownName(name string) bool {
	return icalNameSet[name] || xName.MatchString(name)
}
