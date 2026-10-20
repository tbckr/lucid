package diag

import (
	"strings"
	"testing"
)

// crlf joins content lines the way an iCalendar object is sent, with a final
// line break.
func crlf(lines ...string) []byte {
	return []byte(strings.Join(lines, "\r\n") + "\r\n")
}

// icalText is the skeleton text of a document, for tests that care about
// nothing else.
func icalText(t *testing.T, data []byte) string {
	t.Helper()
	sk := ICalSkeleton(data)
	if sk.Truncated {
		t.Fatalf("ICalSkeleton truncated %q, want it whole", sk.Text)
	}
	return sk.Text
}

func TestICalSkeletonMasksContent(t *testing.T) {
	t.Parallel()
	data := crlf(
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"BEGIN:VEVENT",
		"UID:uid-zz-canary@zz-canary.example",
		"SUMMARY:Therapy zz-canary",
		"DESCRIPTION:Bring zz-canary",
		"LOCATION:zz-canary street 1",
		"ATTENDEE;CN=Bob zz-canary:mailto:bob@zz-canary.example",
		"ORGANIZER;CN=\"Eve: zz-canary\";SENT-BY=\"mailto:x@zz-canary.example\":mailto:eve@zz-canary.example",
		"URL:https://zz-canary.example/meeting",
		"ATTACH;FMTTYPE=application/pdf;ENCODING=BASE64;VALUE=BINARY:emotZ2FuYXJ5",
		"CATEGORIES:zz-canary",
		"X-CUSTOM;X-PARAM=zz-canary:zz-canary",
		"SUMMARY:",
		"END:VEVENT",
		"END:VCALENDAR",
	)
	got := icalText(t, data)
	if strings.Contains(strings.ToLower(got), "zz") {
		t.Errorf("skeleton leaks the canary:\n%s", got)
	}
	want := strings.Join([]string{
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"BEGIN:VEVENT",
		"UID:…",
		"SUMMARY:…",
		"DESCRIPTION:…",
		"LOCATION:…",
		"ATTENDEE;CN=…:…",
		"ORGANIZER;CN=…;SENT-BY=…:…",
		"URL:…",
		"ATTACH;FMTTYPE=…;ENCODING=BASE64;VALUE=BINARY:…",
		"CATEGORIES:…",
		"X-CUSTOM;X-PARAM=…:…",
		"SUMMARY:", // empty stays empty: it shows the value was missing
		"END:VEVENT",
		"END:VCALENDAR",
	}, "\n")
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
}

func TestICalSkeletonKeepsStructure(t *testing.T) {
	t.Parallel()
	tests := []struct{ line, want string }{
		{"PRODID:-//Apple Inc.//macOS 14.4//EN", "PRODID:-//Apple Inc.//macOS 14.4//EN"},
		{"VERSION:2.0", "VERSION:2.0"},
		{"CALSCALE:GREGORIAN", "CALSCALE:GREGORIAN"},
		{"METHOD:PUBLISH", "METHOD:PUBLISH"},
		{"STATUS:CONFIRMED", "STATUS:CONFIRMED"},
		{"CLASS:PRIVATE", "CLASS:PRIVATE"},
		{"TRANSP:TRANSPARENT", "TRANSP:TRANSPARENT"},
		{"ACTION:DISPLAY", "ACTION:DISPLAY"},
		{"PRIORITY:5", "PRIORITY:5"},
		{"SEQUENCE:3", "SEQUENCE:3"},
		{"PERCENT-COMPLETE:40", "PERCENT-COMPLETE:40"},
		{"REPEAT:2", "REPEAT:2"},
		{"DURATION:PT1H30M", "DURATION:PT1H30M"},
		{"TRIGGER;RELATED=END:-PT15M", "TRIGGER;RELATED=END:-PT15M"},
		{"TRIGGER;VALUE=DATE-TIME:20240315T090000Z", "TRIGGER;VALUE=DATE-TIME:00000000T000000Z"},
		{"DTSTART;TZID=Europe/Berlin:20240315T093000", "DTSTART;TZID=Europe/Berlin:00000000T000000"},
		{`DTSTART;TZID="(UTC+01:00) Amsterdam, Berlin":20240315T093000`, `DTSTART;TZID="(UTC+01:00) Amsterdam, Berlin":00000000T000000`},
		{"DTSTART;VALUE=DATE:20240315", "DTSTART;VALUE=DATE:00000000"},
		{"DTEND:20240315T103000Z", "DTEND:00000000T000000Z"},
		{"DUE:20240315", "DUE:00000000"},
		{"DTSTAMP:20240315T103000Z", "DTSTAMP:00000000T000000Z"},
		{"CREATED:20240315T103000Z", "CREATED:00000000T000000Z"},
		{"LAST-MODIFIED:20240315T103000Z", "LAST-MODIFIED:00000000T000000Z"},
		{"COMPLETED:20240315T103000Z", "COMPLETED:00000000T000000Z"},
		{"RECURRENCE-ID;RANGE=THISANDFUTURE:20240315T093000Z", "RECURRENCE-ID;RANGE=THISANDFUTURE:00000000T000000Z"},
		{"EXDATE:20240101T100000Z,20240108T100000Z", "EXDATE:00000000T000000Z,00000000T000000Z"},
		{"RDATE;VALUE=PERIOD:19960403T020000Z/19960403T040000Z", "RDATE;VALUE=PERIOD:00000000T000000Z/00000000T000000Z"},
		{"DTSTART:2024-03-15T09:30:00", "DTSTART:0000-00-00T00:00:00"},
		{
			"RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20241231T235959Z",
			"RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=00000000T000000Z",
		},
		{
			"RRULE:FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYMONTHDAY=-1;BYDAY=-1SU,2TU;BYSETPOS=-1;WKST=SU;BYMONTH=1,12",
			"RRULE:FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYMONTHDAY=-1;BYDAY=-1SU,2TU;BYSETPOS=-1;WKST=SU;BYMONTH=1,12",
		},
		{"EXRULE:FREQ=DAILY;UNTIL=20240315", "EXRULE:FREQ=DAILY;UNTIL=00000000"},
		{
			"ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:a@example.com",
			"ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:…",
		},
		{"FREEBUSY;FBTYPE=BUSY:20240315T090000Z/PT1H", "FREEBUSY;FBTYPE=BUSY:…"},
		{"BEGIN:VALARM", "BEGIN:VALARM"},
		{"END:X-VENDOR-THING", "END:X-VENDOR-THING"},
	}
	for _, tc := range tests {
		t.Run(tc.line, func(t *testing.T) {
			t.Parallel()
			if got := icalText(t, crlf(tc.line)); got != tc.want {
				t.Errorf("ICalSkeleton(%q) = %q, want %q", tc.line, got, tc.want)
			}
		})
	}
}

func TestICalSkeletonVTimezoneIsKeptWhole(t *testing.T) {
	t.Parallel()
	zone := []string{
		"BEGIN:VTIMEZONE",
		"TZID:Europe/Berlin",
		"X-LIC-LOCATION:Europe/Berlin",
		"BEGIN:DAYLIGHT",
		"TZOFFSETFROM:+0100",
		"TZOFFSETTO:+0200",
		"TZNAME:CEST",
		"DTSTART:19700329T020000",
		"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
		"END:DAYLIGHT",
		"BEGIN:STANDARD",
		"TZOFFSETFROM:+0200",
		"TZOFFSETTO:+0100",
		"TZNAME:CET",
		"DTSTART:19701025T030000",
		"RDATE:19701025T030000,19711031T030000",
		"END:STANDARD",
		"END:VTIMEZONE",
	}
	// One line is folded in the source: the skeleton has it unfolded.
	src := append([]string(nil), zone...)
	src[2] = "X-LIC-LOCA\r\n TION:Europe/Berlin"
	data := crlf(append(append([]string{"BEGIN:VCALENDAR"}, src...), "SUMMARY:zz-canary", "END:VCALENDAR")...)

	got := icalText(t, data)
	want := "BEGIN:VCALENDAR\n" + strings.Join(zone, "\n") + "\nSUMMARY:…\nEND:VCALENDAR"
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
}

func TestICalSkeletonVTimezoneScope(t *testing.T) {
	t.Parallel()
	// A zone line is kept whole, but only a line that belongs in a time zone: an
	// unterminated VTIMEZONE must not let what follows through verbatim, and
	// neither must a component nested in it that is not part of a time zone.
	got := icalText(t, crlf(
		"BEGIN:VCALENDAR",
		"BEGIN:VTIMEZONE",
		"TZID:Europe/Berlin",
		"garbage zz-canary",
		"BEGIN:VEVENT",
		"TZNAME:zz-canary",
		"SUMMARY:zz-canary",
		"END:VEVENT",
		"BEGIN:STANDARD",
		"TZNAME:CET",
		"END:STANDARD",
		"SUMMARY:zz-canary",
		"X-NOTE:zz-canary",
		"COMMENT:zz-canary",
	))
	want := strings.Join([]string{
		"BEGIN:VCALENDAR",
		"BEGIN:VTIMEZONE",
		"TZID:Europe/Berlin",
		"<malformed line>",
		"BEGIN:VEVENT",
		"TZNAME:…",
		"SUMMARY:…",
		"END:VEVENT",
		"BEGIN:STANDARD",
		"TZNAME:CET",
		"END:STANDARD",
		"SUMMARY:…",
		"X-NOTE:…",
		"COMMENT:…",
	}, "\n")
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
}

func TestICalSkeletonVTimezoneEnds(t *testing.T) {
	t.Parallel()
	got := icalText(t, crlf(
		"BEGIN:VTIMEZONE",
		"TZID:Europe/Berlin",
		"END:VTIMEZONE",
		"X-AFTER:zz-canary",
		"BEGIN:VEVENT",
		"TZNAME:zz-canary",
		"END:VEVENT",
	))
	want := "BEGIN:VTIMEZONE\nTZID:Europe/Berlin\nEND:VTIMEZONE\nX-AFTER:…\nBEGIN:VEVENT\nTZNAME:…\nEND:VEVENT"
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
}

func TestICalSkeletonFolding(t *testing.T) {
	t.Parallel()
	tests := []struct{ name, data, want string }{
		{"crlf and space", "SUMMARY:zz-canary one\r\n zz-canary two\r\n zz-canary three\r\n", "SUMMARY:…"},
		{"lf and tab", "SUMMARY:zz-canary one\n\tzz-canary two\n\tzz-canary three\n", "SUMMARY:…"},
		{"mixed", "SUMMARY:zz-canary one\r\n\tzz-canary two\n zz-canary three", "SUMMARY:…"},
		{"in the name", "SUMM\r\n ARY:zz-canary", "SUMMARY:…"},
		{"in the parameters", "SUMMARY;LANGUAGE=\r\n en:zz-canary", "SUMMARY;LANGUAGE=…:…"},
		{"in a kept value", "STATUS:CONF\r\n IRMED", "STATUS:CONFIRMED"},
		{"in the colon", "SUMMARY\r\n :zz-canary", "SUMMARY:…"},
		{"only the first character is the fold", "SUMMARY:a\r\n  b", "SUMMARY:…"},
		{"two lines", "SUMMARY:a\r\n b\r\nDESCRIPTION:c\r\n d", "SUMMARY:…\nDESCRIPTION:…"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := icalText(t, []byte(tc.data)); got != tc.want {
				t.Errorf("ICalSkeleton(%q) = %q, want %q", tc.data, got, tc.want)
			}
		})
	}
}

func TestICalSkeletonMalformed(t *testing.T) {
	t.Parallel()
	tests := []struct{ name, data, want string }{
		{"no colon", "garbage zz-canary", "<malformed line>"},
		{"name is text", "garbage zz-canary: value", "<malformed line>"},
		{"empty name", ":zz-canary", "<malformed line>"},
		{"leading space on the first line", " zz-canary:x", "<malformed line>"},
		{"unterminated quote", `ATTENDEE;CN="Bob zz-canary:mailto:bob@zz-canary.example`, "<malformed line>"},
		{"quote that closes late", `ATTENDEE;CN="Bob: zz-canary":mailto:x`, "ATTENDEE;CN=…:…"},
		{"parameter without a value", "ATTENDEE;zz-canary:mailto:x", "ATTENDEE;…:…"},
		{"parameter named like text", "ATTENDEE;zz canary=1:mailto:x", "ATTENDEE;…=…:…"},
		{"no parameter at all", "ATTENDEE;:mailto:x", "ATTENDEE;…:…"},
		{"empty parameter before one", "ATTENDEE;;CN=x:mailto:x", "ATTENDEE;…;CN=…:…"},
		{"blank line first", "\nSUMMARY:x", "SUMMARY:…"},
		{"empty parameter value", "ATTENDEE;CN=:mailto:x", "ATTENDEE;CN=:…"},
		{"blank lines are dropped", "\r\n\r\nSUMMARY:x\r\n\r\n", "SUMMARY:…"},
		{"unterminated BEGIN value", "BEGIN:zz canary", "BEGIN:…"},
		{"BEGIN without a value", "BEGIN:", "BEGIN:"},
		{"END without a value", "END:", "END:"},
		{"nul and bytes that are no UTF-8", "SUMMARY:\x00\xff\xfe zz-canary\x00", "SUMMARY:…"},
		{"lone carriage return", "SUMMARY:zz\rcanary", "SUMMARY:…"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := icalText(t, []byte(tc.data))
			if got != tc.want {
				t.Errorf("ICalSkeleton(%q) = %q, want %q", tc.data, got, tc.want)
			}
			if strings.Contains(got, "zz") {
				t.Errorf("ICalSkeleton(%q) = %q leaks the canary", tc.data, got)
			}
		})
	}
	if got := ICalSkeleton(nil); got != (Skeleton{}) {
		t.Errorf("ICalSkeleton(nil) = %+v, want the zero Skeleton", got)
	}
	if got := ICalSkeleton([]byte{}); got != (Skeleton{}) {
		t.Errorf("ICalSkeleton(empty) = %+v, want the zero Skeleton", got)
	}
	if got := ICalSkeleton([]byte("\r\n\r\n")); got != (Skeleton{}) {
		t.Errorf("ICalSkeleton(blank lines) = %+v, want the zero Skeleton", got)
	}
}

// TestICalSkeletonMasksWhatDoesNotLookRight: a value kept verbatim has to look
// like what its property can hold. The documents this runs on are the ones a
// parser rejected, and a rejected value is often the one that carries text.
func TestICalSkeletonMasksWhatDoesNotLookRight(t *testing.T) {
	t.Parallel()
	tests := []struct{ line, want string }{
		{"VERSION:zz-canary", "VERSION:…"},
		{"CALSCALE:zz-canary", "CALSCALE:…"},
		{"METHOD:zz-canary", "METHOD:…"},
		{"STATUS:zz-canary", "STATUS:…"},
		{"CLASS:zz-canary", "CLASS:…"},
		{"TRANSP:zz-canary", "TRANSP:…"},
		{"ACTION:zz-canary", "ACTION:…"},
		{"PRIORITY:zz-canary", "PRIORITY:…"},
		{"SEQUENCE:zz-canary", "SEQUENCE:…"},
		{"PERCENT-COMPLETE:zz-canary", "PERCENT-COMPLETE:…"},
		{"REPEAT:zz-canary", "REPEAT:…"},
		{"DURATION:zz-canary", "DURATION:…"},
		{"TRIGGER:zz-canary", "TRIGGER:…"},
		{"DTSTART:zz-canary", "DTSTART:…"},
		{"DTSTART;TZID=Europe/Berlin:next Tuesday zz-canary", "DTSTART;TZID=Europe/Berlin:…"},
		{"EXDATE:20240101T100000Z,zz-canary", "EXDATE:…"},
		{"TRIGGER;VALUE=DATE-TIME:zz-canary", "TRIGGER;VALUE=DATE-TIME:…"},
		{"RRULE:zz-canary", "RRULE:…"},
		{"RRULE:FREQ=zz-canary;COUNT=zz-canary;BYDAY=zz-canary;WKST=zz-canary", "RRULE:FREQ=…;COUNT=…;BYDAY=…;WKST=…"},
		{"RRULE:FREQ=DAILY;zz-canary=1;X-ZZ=2;UNTIL=zz-canary", "RRULE:FREQ=DAILY;…;…;UNTIL=…"},
		{"RRULE:FREQ=DAILY;;COUNT=3;", "RRULE:FREQ=DAILY;;COUNT=3;"},
		{
			"ATTENDEE;VALUE=zz-canary;PARTSTAT=zz-canary;ROLE=zz-canary;CUTYPE=zz-canary;RSVP=zz-canary:x",
			"ATTENDEE;VALUE=…;PARTSTAT=…;ROLE=…;CUTYPE=…;RSVP=…:…",
		},
		{"DTSTART;RELATED=zz-canary;RANGE=zz-canary;ENCODING=zz-canary:20240101", "DTSTART;RELATED=…;RANGE=…;ENCODING=…:00000000"},
		{"FREEBUSY;FBTYPE=zz-canary:x", "FREEBUSY;FBTYPE=…:…"},
		{"ATTENDEE;ROLE=CHAIR,zz-canary:x", "ATTENDEE;ROLE=…:…"},
	}
	for _, tc := range tests {
		t.Run(tc.line, func(t *testing.T) {
			t.Parallel()
			got := icalText(t, crlf(tc.line))
			if got != tc.want {
				t.Errorf("ICalSkeleton(%q) = %q, want %q", tc.line, got, tc.want)
			}
			if strings.Contains(got, "zz") || strings.Contains(got, "canary") {
				t.Errorf("ICalSkeleton(%q) = %q leaks the canary", tc.line, got)
			}
		})
	}
}

// TestICalSkeletonMasksNamesThatAreNotNames: names are judged by what they are,
// not by how they are spelled. A line that lost its fold or an unescaped line
// break in a text has text where a name should be ("Bob: bring the files"), and
// a document that a parser rejected is where that happens.
func TestICalSkeletonMasksNamesThatAreNotNames(t *testing.T) {
	t.Parallel()
	tests := []struct{ line, want string }{
		{"Bob: bring the files", "…:…"},
		{"Diagnose;Depression=x:y", "…;…=…:…"},
		{"Bob;Smith:zz-canary", "…;…:…"},
		{"Bob;Smith=:zz-canary", "…;…=:…"},
		{"Bob:", "…:"},
		{"ATTENDEE;Bob=x;CN=y;Smith:z", "ATTENDEE;…=…;CN=…;…:…"},
		{"ATTENDEE;PARTSTAT=ACCEPTED;Bob=ACCEPTED:z", "ATTENDEE;PARTSTAT=ACCEPTED;…=…:…"},
		// Only uppercase names are the names.
		{"Status:CONFIRMED", "…:…"},
		{"status:confirmed", "…:…"},
		{"dtstart;tzid=Europe/Berlin;value=date:20240315", "…;…=…;…=…:…"},
		{"rrule:freq=daily", "…:…"},
		{"ATTENDEE;Cn=Bob;partstat=ACCEPTED:z", "ATTENDEE;…=…;…=…:…"},
		{"begin:VEVENT", "…:…"},
		// X-names are the vendors', in uppercase.
		{"X-MOZ-LASTACK:20240101T000000Z", "X-MOZ-LASTACK:…"},
		{"X-WR-CALNAME;X-LANG=de:zz-canary", "X-WR-CALNAME;X-LANG=…:…"},
		{"X-Men:zz-canary", "…:…"},
		{"X-:zz-canary", "…:…"},
		{"X-A_B:zz-canary", "<malformed line>"}, // an underscore is no part of a name
		{"x-wr-calname:zz-canary", "…:…"},
		// BEGIN and END show a name or nothing.
		{"BEGIN:VEVENT", "BEGIN:VEVENT"},
		{"BEGIN:X-VENDOR-THING", "BEGIN:X-VENDOR-THING"},
		{"BEGIN:Bob", "BEGIN:…"},
		{"END:Bob", "END:…"},
		{"BEGIN:vevent", "BEGIN:…"},
		{"BEGIN:X-Men", "BEGIN:…"},
		{"END:zz-canary", "END:…"},
		// The names of RFC 6638, 7986, 9073 and 9074.
		{"COLOR:turquoise", "COLOR:…"},
		{"NAME:zz-canary", "NAME:…"},
		{"REFRESH-INTERVAL;VALUE=DURATION:P1D", "REFRESH-INTERVAL;VALUE=DURATION:…"},
		{"IMAGE;VALUE=URI;DISPLAY=BADGE:https://zz-canary.example/i.png", "IMAGE;VALUE=URI;DISPLAY=…:…"},
		{"CONFERENCE;VALUE=URI;FEATURE=AUDIO;LABEL=zz-canary:https://zz-canary.example", "CONFERENCE;VALUE=URI;FEATURE=…;LABEL=…:…"},
		{"ATTENDEE;SCHEDULE-AGENT=CLIENT;SCHEDULE-STATUS=\"1.2\";SCHEDULE-FORCE-SEND=REQUEST:x", "ATTENDEE;SCHEDULE-AGENT=…;SCHEDULE-STATUS=…;SCHEDULE-FORCE-SEND=…:…"},
		{"PARTICIPANT-TYPE:ACTIVE", "PARTICIPANT-TYPE:…"},
		{"CALENDAR-ADDRESS:mailto:zz-canary@example.com", "CALENDAR-ADDRESS:…"},
		{"STYLED-DESCRIPTION;VALUE=TEXT:zz-canary", "STYLED-DESCRIPTION;VALUE=TEXT:…"},
		{"STRUCTURED-DATA;VALUE=TEXT:zz-canary", "STRUCTURED-DATA;VALUE=TEXT:…"},
		{"ACKNOWLEDGED:20240101T000000Z", "ACKNOWLEDGED:…"},
		{"PROXIMITY:ARRIVE", "PROXIMITY:…"},
		{"BEGIN:VLOCATION", "BEGIN:VLOCATION"},
		{"END:PARTICIPANT", "END:PARTICIPANT"},
	}
	for _, tc := range tests {
		t.Run(tc.line, func(t *testing.T) {
			t.Parallel()
			got := icalText(t, crlf(tc.line))
			if got != tc.want {
				t.Errorf("ICalSkeleton(%q) = %q, want %q", tc.line, got, tc.want)
			}
			for _, leak := range []string{"Bob", "Smith", "Diagnose", "Depression", "bring", "canary", "turquoise"} {
				if strings.Contains(got, leak) {
					t.Errorf("ICalSkeleton(%q) = %q leaks %q", tc.line, got, leak)
				}
			}
		})
	}
}

func TestICalSkeletonLowercaseZoneIsNoZone(t *testing.T) {
	t.Parallel()
	// A component whose name is not shown is not a time zone either.
	got := icalText(t, crlf("BEGIN:vtimezone", "TZID:Europe/Berlin", "END:vtimezone", "TZID:Europe/Berlin"))
	want := "BEGIN:…\nTZID:…\nEND:…\nTZID:…"
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
}

func TestICalSkeletonCap(t *testing.T) {
	t.Parallel()
	data := []byte(strings.Repeat("SUMMARY:zz-canary zz-canary zz-canary\r\n", 100<<10/36))
	if len(data) < 100<<10 {
		t.Fatalf("test input is only %d bytes", len(data))
	}
	sk := ICalSkeleton(data)
	if !sk.Truncated {
		t.Error("Truncated = false, want true")
	}
	if len(sk.Text) > MaxSkeleton || len(sk.Text) < MaxSkeleton-len("SUMMARY:…\n") {
		t.Errorf("len(Text) = %d, want at most %d and at most one line short", len(sk.Text), MaxSkeleton)
	}
	// The cut lies on a line boundary: every line is whole.
	for _, line := range strings.Split(sk.Text, "\n") {
		if line != "SUMMARY:…" {
			t.Fatalf("line %q is not whole", line)
		}
	}
}

func TestICalSkeletonCapLineThatNeverFits(t *testing.T) {
	t.Parallel()
	// A zone line is kept whole, and when one alone is over the cap it is
	// dropped, not cut: the cap lies on a line boundary.
	data := crlf("BEGIN:VTIMEZONE", "TZID:"+strings.Repeat("a", 2*MaxSkeleton), "END:VTIMEZONE")
	sk := ICalSkeleton(data)
	if sk.Text != "BEGIN:VTIMEZONE" || !sk.Truncated {
		t.Errorf("ICalSkeleton = %+v, want only the first line and Truncated", sk)
	}
}

func TestICalSkeletonCapBoundary(t *testing.T) {
	t.Parallel()
	// 100 masked lines of 11 bytes and a PRODID line of the padding that makes
	// the whole text exactly MaxSkeleton bytes, line breaks included.
	const lines = 100
	head := strings.Repeat("SUMMARY:x\r\n", lines)
	pad := MaxSkeleton - (lines*(len("SUMMARY:…")+1) + len("PRODID:"))
	data := head + "PRODID:" + strings.Repeat("a", pad)

	sk := ICalSkeleton([]byte(data))
	if len(sk.Text) != MaxSkeleton || sk.Truncated {
		t.Errorf("text that fills the cap exactly: len = %d, Truncated = %v, want %d, false", len(sk.Text), sk.Truncated, MaxSkeleton)
	}
	// One byte more and the PRODID line, the last, no longer fits.
	sk = ICalSkeleton([]byte(data + "a"))
	if !sk.Truncated || len(sk.Text) != lines*(len("SUMMARY:…")+1)-1 {
		t.Errorf("one byte over: len = %d, Truncated = %v, want %d, true", len(sk.Text), sk.Truncated, lines*(len("SUMMARY:…")+1)-1)
	}
}

func TestICalSkeletonCapAtBlankLine(t *testing.T) {
	t.Parallel()
	// The line that does not fit is flushed by whatever ends it, a blank line too.
	data := crlf("BEGIN:VTIMEZONE", "TZID:"+strings.Repeat("a", 2*MaxSkeleton), "", "END:VTIMEZONE")
	sk := ICalSkeleton(data)
	if sk.Text != "BEGIN:VTIMEZONE" || !sk.Truncated {
		t.Errorf("ICalSkeleton = %+v, want only the first line and Truncated", sk)
	}
}

func TestCappedStopsAtTheFirstMiss(t *testing.T) {
	t.Parallel()
	var c capped
	if !c.add("first") || !c.add("second") {
		t.Fatal("lines that fit were refused")
	}
	if c.add(strings.Repeat("x", MaxSkeleton)) {
		t.Fatal("a line over the cap was taken")
	}
	// A short line after one that did not fit would leave a hole in the shape.
	if c.add("short") {
		t.Error("a line was taken after the cap was hit")
	}
	if got, want := c.skeleton(), (Skeleton{Text: "first\nsecond", Truncated: true}); got != want {
		t.Errorf("skeleton = %+v, want %+v", got, want)
	}
}

func TestCappedTakesALineThatFillsTheCap(t *testing.T) {
	t.Parallel()
	var c capped
	line := strings.Repeat("x", MaxSkeleton)
	if !c.add(line) || c.truncated {
		t.Fatalf("a first line of exactly MaxSkeleton bytes was refused")
	}
	if c.add("") {
		t.Error("a line after a full one was taken")
	}
	if got := c.skeleton(); got.Text != line || !got.Truncated {
		t.Errorf("skeleton = {%d bytes, %v}, want the line and Truncated", len(got.Text), got.Truncated)
	}
}

func TestIsToken(t *testing.T) {
	t.Parallel()
	for _, s := range []string{"A", "Z", "a", "z", "0", "9", "-", "X-ZZ-0", "BEGIN"} {
		if !isToken(s) {
			t.Errorf("isToken(%q) = false, want true", s)
		}
	}
	// The characters next to the ranges, and what no name has.
	for _, s := range []string{"", "@", "[", "`", "{", "/", ":", "_", " ", "a b", "é", "a\x00", "\"", ";"} {
		if isToken(s) {
			t.Errorf("isToken(%q) = true, want false", s)
		}
	}
}

func TestOneLine(t *testing.T) {
	t.Parallel()
	tests := []struct{ in, want string }{
		{"", ""},
		{"a b ~", "a b ~"},
		{"é…", "é…"},
		{"a\nb", "a?b"},
		{"a\tb\rc\x00d", "a?b?c?d"},
		{"\x1f \x7f", "? ?"},
		{" ", " "},
		{"\x7f", "?"},
		{"é a\x01", "é a?"},
	}
	for _, tc := range tests {
		if got := oneLine(tc.in); got != tc.want {
			t.Errorf("oneLine(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestICalSkeletonScopeFollowsTheStructureInAnyCase: what the lines show is by
// their exact names, but a BEGIN or END in another case, or one that is hardly
// a line at all, still opens or closes a component. Otherwise an unclosed
// VTIMEZONE stays innermost, and the dates, rules and names of what follows
// pass through as a time zone's.
func TestICalSkeletonScopeFollowsTheStructureInAnyCase(t *testing.T) {
	t.Parallel()
	event := []string{
		"DTSTART:20240315T093000",
		"RRULE:FREQ=WEEKLY;UNTIL=20241231T000000Z",
		"RDATE:20240101T000000Z",
		"LAST-MODIFIED:20240101T000000Z",
		"TZNAME:zz-canary",
	}
	maskedEvent := []string{
		"DTSTART:00000000T000000",
		"RRULE:FREQ=WEEKLY;UNTIL=00000000T000000Z",
		"RDATE:00000000T000000Z",
		"LAST-MODIFIED:00000000T000000Z",
		"TZNAME:…",
	}
	tests := []struct {
		name         string
		before, want []string
	}{
		{
			"begin in lowercase after an unclosed zone",
			[]string{"BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "begin:VEVENT"},
			[]string{"BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "…:…"},
		},
		{
			"begin in mixed case, value in lowercase",
			[]string{"BEGIN:VTIMEZONE", "Begin:vevent"},
			[]string{"BEGIN:VTIMEZONE", "…:…"},
		},
		{
			"begin without a colon",
			[]string{"BEGIN:VTIMEZONE", "BEGIN VEVENT"},
			[]string{"BEGIN:VTIMEZONE", "<malformed line>"},
		},
		{
			"begin with a blank in the name",
			[]string{"BEGIN:VTIMEZONE", "BEGIN VEVENT:x"},
			[]string{"BEGIN:VTIMEZONE", "<malformed line>"},
		},
		{
			"begin of a component that is no name",
			[]string{"BEGIN:VTIMEZONE", "BEGIN:Bob"},
			[]string{"BEGIN:VTIMEZONE", "BEGIN:…"},
		},
		{
			"end without a colon leaves the zone",
			[]string{"BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "END VTIMEZONE"},
			[]string{"BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "<malformed line>"},
		},
		{
			"end in lowercase closes the zone",
			[]string{"BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "end:VTIMEZONE"},
			[]string{"BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "…:…"},
		},
		{
			"end with a value in lowercase closes the zone",
			[]string{"BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "END:vtimezone"},
			[]string{"BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "END:…"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := icalText(t, crlf(append(append([]string(nil), tc.before...), event...)...))
			want := strings.Join(append(append([]string(nil), tc.want...), maskedEvent...), "\n")
			if got != want {
				t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
			}
		})
	}

	// The zone still is one when the lines in front of it are only odd.
	got := icalText(t, crlf("BEGINNING OF TEXT", "BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "TZNAME:CET", "END:VTIMEZONE", "TZNAME:zz-canary"))
	want := "<malformed line>\nBEGIN:VTIMEZONE\nTZID:Europe/Berlin\nTZNAME:CET\nEND:VTIMEZONE\nTZNAME:…"
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
}

func TestICalSkeletonMasksTheParametersOfAMaskedName(t *testing.T) {
	t.Parallel()
	tests := []struct{ line, want string }{
		{"Diagnose;TZID=Depression:y", "…;…=…:…"},
		{"Diagnose;VALUE=DATE;Depression:y", "…;…=…;…:…"},
		{"x-men;PARTSTAT=ACCEPTED;ROLE=CHAIR:y", "…;…=…;…=…:…"},
		{"X-Men;TZID=:y", "…;…=:…"},
		{`Diagnose;CN="zz: canary";TZID=zz-canary:y`, "…;…=…;…=…:…"},
	}
	for _, tc := range tests {
		got := icalText(t, crlf(tc.line))
		if got != tc.want {
			t.Errorf("ICalSkeleton(%q) = %q, want %q", tc.line, got, tc.want)
		}
		if strings.Contains(got, "Depression") || strings.Contains(got, "canary") {
			t.Errorf("ICalSkeleton(%q) = %q leaks", tc.line, got)
		}
	}
	// A name that is shown has its parameters shown.
	if got, want := icalText(t, crlf("X-DIAGNOSE;TZID=Depression:y")), "X-DIAGNOSE;TZID=Depression:…"; got != want {
		t.Errorf("skeleton = %q, want %q", got, want)
	}
}
