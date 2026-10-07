package caldav

import (
	"testing"
	"time"

	"github.com/emersion/go-ical"
)

// TestFirstOccurrence checks which RECURRENCE-ID firstOccurrence names as the
// first one ListEvents shows: the rule's, an RDATE's or an override's,
// whichever comes first, none of them an EXDATE or a cancelled override
// (FR-17).
func TestFirstOccurrence(t *testing.T) {
	t.Parallel()
	weekly := []string{
		"UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Series", "DTSTART:20250303T080000Z",
		"DTEND:20250303T090000Z", "RRULE:FREQ=WEEKLY",
	}
	with := func(base []string, extra ...string) []string {
		return append(append([]string{}, base...), extra...)
	}
	override := func(rid string, extra ...string) []string {
		return append([]string{
			"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Series",
			"RECURRENCE-ID:" + rid,
		}, append(extra, "END:VEVENT")...)
	}
	vevent := func(master []string, overrides ...[]string) []string {
		out := append([]string{"BEGIN:VEVENT"}, master...)
		out = append(out, "END:VEVENT")
		for _, o := range overrides {
			out = append(out, o...)
		}
		return out
	}

	tests := []struct {
		name  string
		lines []string
		want  time.Time // the zero time: no occurrence is shown
	}{
		{"weekly series", vevent(weekly), date(2025, 3, 3, 8, 0)},
		{"EXDATE on DTSTART", vevent(with(weekly, "EXDATE:20250303T080000Z")), date(2025, 3, 10, 8, 0)},
		{
			"EXDATEs on the first two instances",
			vevent(with(weekly, "EXDATE:20250303T080000Z,20250310T080000Z")), date(2025, 3, 17, 8, 0),
		},
		{
			"override at DTSTART moved to March 5",
			vevent(weekly, override("20250303T080000Z", "DTSTART:20250305T080000Z", "DTEND:20250305T090000Z")),
			date(2025, 3, 3, 8, 0),
		},
		{
			"cancelled override at DTSTART",
			vevent(weekly, override("20250303T080000Z", "STATUS:CANCELLED", "DTSTART:20250303T080000Z")),
			date(2025, 3, 10, 8, 0),
		},
		{
			"cancelled override, status in lower case",
			vevent(weekly, override("20250303T080000Z", "STATUS:cancelled", "DTSTART:20250303T080000Z")),
			date(2025, 3, 10, 8, 0),
		},
		{
			"confirmed override at DTSTART",
			vevent(weekly, override("20250303T080000Z", "STATUS:CONFIRMED", "DTSTART:20250303T080000Z")),
			date(2025, 3, 3, 8, 0),
		},
		{"RDATE before DTSTART", vevent(with(weekly, "RDATE:20250301T080000Z")), date(2025, 3, 1, 8, 0)},
		{"RDATE after DTSTART", vevent(with(weekly, "RDATE:20250305T080000Z")), date(2025, 3, 3, 8, 0)},
		{
			"RDATE before DTSTART, excluded by EXDATE",
			vevent(with(weekly, "RDATE:20250301T080000Z", "EXDATE:20250301T080000Z")), date(2025, 3, 3, 8, 0),
		},
		{
			"RDATE before DTSTART, cancelled by an override",
			vevent(with(weekly, "RDATE:20250301T080000Z"),
				override("20250301T080000Z", "STATUS:CANCELLED", "DTSTART:20250301T080000Z")),
			date(2025, 3, 3, 8, 0),
		},
		{
			"RDATE among several, the earliest wins",
			vevent(with(weekly, "RDATE:20250306T080000Z,20250302T080000Z")), date(2025, 3, 2, 8, 0),
		},
		{"RDATE that cannot be read", vevent(with(weekly, "RDATE:tomorrow")), date(2025, 3, 3, 8, 0)},
		{"EXDATE that cannot be read", vevent(with(weekly, "EXDATE:tomorrow")), date(2025, 3, 3, 8, 0)},
		{
			"override before DTSTART",
			vevent(weekly, override("20250228T080000Z", "DTSTART:20250228T100000Z", "DTEND:20250228T110000Z")),
			date(2025, 2, 28, 8, 0),
		},
		{
			"override before DTSTART, cancelled",
			vevent(weekly, override("20250228T080000Z", "STATUS:CANCELLED", "DTSTART:20250228T080000Z")),
			date(2025, 3, 3, 8, 0),
		},
		{
			"override before DTSTART, in EXDATE",
			vevent(with(weekly, "EXDATE:20250228T080000Z"),
				override("20250228T080000Z", "DTSTART:20250228T080000Z")),
			date(2025, 3, 3, 8, 0),
		},
		{
			"EXDATE on DTSTART, override of the second instance",
			vevent(with(weekly, "EXDATE:20250303T080000Z"),
				override("20250310T080000Z", "DTSTART:20250310T120000Z", "DTEND:20250310T130000Z")),
			date(2025, 3, 10, 8, 0),
		},
		{
			"override moved before the first instance keeps its RECURRENCE-ID",
			vevent(with(weekly, "EXDATE:20250303T080000Z"),
				override("20250310T080000Z", "DTSTART:20250301T080000Z", "DTEND:20250301T090000Z")),
			date(2025, 3, 10, 8, 0),
		},
		{
			"DTSTART off the rule",
			vevent([]string{
				"UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
				"RRULE:FREQ=WEEKLY;BYDAY=WE",
			}),
			date(2025, 3, 3, 8, 0),
		},
		{
			"DTSTART off the rule, in EXDATE",
			vevent([]string{
				"UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
				"RRULE:FREQ=WEEKLY;BYDAY=WE", "EXDATE:20250303T080000Z",
			}),
			date(2025, 3, 5, 8, 0),
		},
		{
			"rule with a COUNT, all instances excluded",
			vevent([]string{
				"UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
				"RRULE:FREQ=WEEKLY;COUNT=2", "EXDATE:20250303T080000Z,20250310T080000Z",
			}),
			time.Time{},
		},
		{
			"RDATEs only",
			vevent([]string{
				"UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
				"RDATE:20250305T080000Z", "EXDATE:20250303T080000Z",
			}),
			date(2025, 3, 5, 8, 0),
		},
		{
			"unreadable rule",
			vevent([]string{
				"UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
				"RRULE:FREQ=WEEKLY;RSCALE=GREGORIAN",
			}),
			date(2025, 3, 3, 8, 0),
		},
		{
			"unreadable rule, DTSTART in EXDATE, RDATE",
			vevent([]string{
				"UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
				"RRULE:FREQ=WEEKLY;RSCALE=GREGORIAN", "EXDATE:20250303T080000Z", "RDATE:20250306T080000Z",
			}),
			date(2025, 3, 6, 8, 0),
		},
		{
			"zone of its own, DST change after DTSTART",
			[]string{
				"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "DTSTART;TZID=Europe/Berlin:20250324T090000",
				"DTEND;TZID=Europe/Berlin:20250324T100000", "RRULE:FREQ=WEEKLY",
				"EXDATE;TZID=Europe/Berlin:20250324T090000", "END:VEVENT",
			},
			date(2025, 3, 31, 7, 0), // the first week of summer time
		},
		{
			"all-day series",
			[]string{
				"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "DTSTART;VALUE=DATE:20250303",
				"RRULE:FREQ=DAILY", "EXDATE;VALUE=DATE:20250303", "END:VEVENT",
			},
			date(2025, 3, 4, 0, 0),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			cal := mustParse(t, ics(tt.lines...))
			master := mainComponent(cal, ical.CompEvent)
			tm, err := parseTiming(master)
			mustNoErr(t, err)
			got := firstOccurrence(cal, master, tm)
			if !got.Equal(tt.want) {
				t.Errorf("firstOccurrence = %v; want %v", got, tt.want)
			}
		})
	}
}
