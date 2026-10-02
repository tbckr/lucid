package caldav

// This file decides which moves of a recurring series' RRULE "All events"
// may perform (FR-17). See docs/RECURRING-EVENTS.md for the client survey
// and the decisions behind the three cases below.

import (
	"strconv"
	"strings"
	"time"
)

// weekdayCodes are the two-letter RRULE weekday codes, in time.Weekday
// order (Sunday first), used to rotate BYDAY values in seriesShift (FR-17).
var weekdayCodes = [...]string{"SU", "MO", "TU", "WE", "TH", "FR", "SA"}

// weekdayIndex returns the time.Weekday index (Sunday = 0) of a plain
// two-letter RRULE weekday code, or -1 if code carries an ordinal (such as
// "2MO") or is not a weekday code at all (FR-17).
func weekdayIndex(code string) int {
	for i, c := range weekdayCodes {
		if c == code {
			return i
		}
	}
	return -1
}

// floorDiv is integer division rounding towards negative infinity, unlike
// Go's "/" which truncates towards zero; seriesShift needs this for
// weekdays that wrap across a week boundary (FR-17).
func floorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

// floorMod is the modulo counterpart of floorDiv: its result always has the
// sign of b, so it keeps a weekday index in [0, 7) however far dayDelta
// shifts it (FR-17).
func floorMod(a, b int) int {
	return a - floorDiv(a, b)*b
}

// seriesShift decides how the RRULE of a series follows when its start
// moves from a wall-clock "from" to "to" (spec §3, FR-17). Only their date
// and clock fields are read; the location is ignored, since callers pass
// wall-clock values already resolved to the series' own time zone. It
// returns the rule to write, and whether the move is allowed at all: a
// rule rejected here must keep its original start.
func seriesShift(rule string, from, to time.Time) (string, bool) {
	dayDelta := dateDays(to) - dateDays(from)

	// Case 1: nothing but FREQ, INTERVAL, COUNT, UNTIL, WKST — any move is
	// allowed, the rule stays as written.
	if !ruleHasFixedDays(rule, false) {
		return rule, true
	}

	// Case 2: FREQ=WEEKLY with BYDAY as its only part beyond the case 1
	// set, every value a plain weekday — each weekday follows dayDelta.
	if weeklySimpleByDay(rule) {
		return weeklyByDayShift(rule, dayDelta)
	}

	// Case 3: everything else with a BY part (BYMONTHDAY, BYDAY with an
	// ordinal, BYSETPOS, BYMONTH, BYYEARDAY, BYWEEKNO, or a weekly rule
	// with further BY parts) — only a same-day move is allowed, and only a
	// same-clock move if the rule fixes the clock itself.
	if dayDelta != 0 {
		return "", false
	}
	if hasClockParts(rule) && clockChanged(from, to) {
		return "", false
	}
	return rule, true
}

// dateDays returns a day number for t's civil date (year, month, day),
// comparable across any two times regardless of their location, for
// computing seriesShift's dayDelta (FR-17).
func dateDays(t time.Time) int {
	y, m, d := t.Date()
	return int(time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix() / 86400)
}

// clockChanged reports whether to's hour, minute and second differ from
// from's (FR-17).
func clockChanged(from, to time.Time) bool {
	fh, fm, fs := from.Clock()
	th, tm, ts := to.Clock()
	return fh != th || fm != tm || fs != ts
}

// hasClockParts reports whether rule fixes the time of day itself, via
// BYHOUR, BYMINUTE or BYSECOND (FR-17): case 3 of seriesShift then also
// rejects a clock change, not only a day change.
func hasClockParts(rule string) bool {
	for part := range strings.SplitSeq(rule, ";") {
		switch rulePartKey(part) {
		case "BYHOUR", "BYMINUTE", "BYSECOND":
			return true
		}
	}
	return false
}

// weeklySimpleByDay reports whether rule is FREQ=WEEKLY with BYDAY as its
// only part beyond FREQ, INTERVAL, COUNT, UNTIL and WKST, and every BYDAY
// value a plain weekday without an ordinal — case 2 of seriesShift (FR-17).
func weeklySimpleByDay(rule string) bool {
	if rulePart(rule, "FREQ") != "WEEKLY" {
		return false
	}
	byday := ""
	for part := range strings.SplitSeq(rule, ";") {
		switch rulePartKey(part) {
		case "", "FREQ", "INTERVAL", "COUNT", "UNTIL", "WKST":
		case "BYDAY":
			byday = rulePart(rule, "BYDAY")
		default:
			return false
		}
	}
	if byday == "" {
		return false
	}
	for day := range strings.SplitSeq(byday, ",") {
		if weekdayIndex(strings.TrimSpace(day)) < 0 {
			return false
		}
	}
	return true
}

// weeklyByDayShift implements case 2 of seriesShift (FR-17): it rotates
// each BYDAY weekday of rule by dayDelta, mod 7, keeping their order. With
// INTERVAL > 1 it additionally requires every weekday to land in the same
// relative week (judged against WKST, MO if absent) — otherwise the
// occurrences would no longer all be offset by the same amount, and the
// move is rejected.
func weeklyByDayShift(rule string, dayDelta int) (string, bool) {
	interval := 1
	if iv := rulePart(rule, "INTERVAL"); iv != "" {
		if n, err := strconv.Atoi(iv); err == nil {
			interval = n
		}
	}

	if interval > 1 {
		wkst := weekdayIndex("MO")
		if w := weekdayIndex(rulePart(rule, "WKST")); w >= 0 {
			wkst = w
		}

		week, set := 0, false
		for day := range strings.SplitSeq(rulePart(rule, "BYDAY"), ",") {
			p := floorMod(weekdayIndex(strings.TrimSpace(day))-wkst, 7)
			w := floorDiv(p+dayDelta, 7)
			if !set {
				week, set = w, true
			} else if w != week {
				return "", false
			}
		}
	}

	return mapRulePart(rule, "BYDAY", func(v string) string {
		days := strings.Split(v, ",")
		for i, day := range days {
			days[i] = weekdayCodes[floorMod(weekdayIndex(strings.TrimSpace(day))+dayDelta, 7)]
		}
		return strings.Join(days, ",")
	}), true
}
