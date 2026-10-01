package caldav

import (
	"fmt"
	"time"

	"github.com/emersion/go-ical"
)

// ensureVTimezone adds a VTIMEZONE for loc to cal unless one with the same
// TZID exists. VTIMEZONE components are placed before other components.
func ensureVTimezone(cal *ical.Calendar, loc *time.Location, year int) {
	ensureVTimezoneAs(cal, loc.String(), loc, year)
}

// ensureVTimezoneAs is ensureVTimezone for a TZID other than loc's IANA
// name, such as "/mozilla.org/20050126_1/Europe/Berlin" (FR-17).
func ensureVTimezoneAs(cal *ical.Calendar, tzid string, loc *time.Location, year int) {
	if findVTimezone(cal, tzid) != nil {
		return
	}
	tz := vtimezone(loc, year)
	tz.Props.SetText(ical.PropTimezoneID, tzid)
	cal.Children = append([]*ical.Component{tz}, cal.Children...)
}

// findVTimezone returns the VTIMEZONE of cal with the given TZID, or nil.
func findVTimezone(cal *ical.Calendar, tzid string) *ical.Component {
	for _, c := range cal.Children {
		if c.Name == ical.CompTimezone && text(c.Props, ical.PropTimezoneID) == tzid {
			return c
		}
	}
	return nil
}

type transition struct {
	at       time.Time // instant of the change
	from, to int       // UTC offsets in seconds
	name     string    // abbreviation after the change
	dst      bool
}

// vtimezone builds a VTIMEZONE from Go's zoneinfo, derived from the
// transitions around the given year. If the zone has exactly two transitions
// per year (the common DST pattern), each observance gets a yearly RRULE
// (e.g. BYMONTH=3;BYDAY=-1SU) with its onset in the previous year, so the
// definition covers the whole year and later ones. Other zones are described
// by their state on January 1st plus each transition of the year. Most
// clients resolve well-known TZIDs themselves; the component keeps the object
// self-contained and valid.
func vtimezone(loc *time.Location, year int) *ical.Component {
	tz := ical.NewComponent(ical.CompTimezone)
	tz.Props.SetText(ical.PropTimezoneID, loc.String())

	if prev := transitions(loc, year-1); len(prev) == 2 && len(transitions(loc, year)) == 2 {
		for _, tr := range prev {
			local := tr.at.UTC().Add(time.Duration(tr.from) * time.Second)
			tz.Children = append(tz.Children, observance(tr.dst, local, tr.from, tr.to, tr.name, yearlyRule(local)))
		}
		return tz
	}

	jan1 := time.Date(year, time.January, 1, 0, 0, 0, 0, loc)
	name, off := jan1.Zone()
	tz.Children = append(tz.Children, observance(jan1.IsDST(), time.Date(year, time.January, 1, 0, 0, 0, 0, time.UTC), off, off, name, ""))
	for _, tr := range transitions(loc, year) {
		local := tr.at.UTC().Add(time.Duration(tr.from) * time.Second)
		tz.Children = append(tz.Children, observance(tr.dst, local, tr.from, tr.to, tr.name, ""))
	}
	return tz
}

// transitions returns the offset changes of loc during year.
func transitions(loc *time.Location, year int) []transition {
	t := time.Date(year, time.January, 1, 0, 0, 0, 0, loc)
	endOfYear := time.Date(year+1, time.January, 1, 0, 0, 0, 0, loc)
	var out []transition
	for range 16 {
		_, end := t.ZoneBounds()
		if end.IsZero() || !end.Before(endOfYear) {
			break
		}
		_, from := t.Zone()
		name, to := end.Zone()
		if from != to {
			out = append(out, transition{at: end, from: from, to: to, name: name, dst: end.IsDST()})
		}
		t = end
	}
	return out
}

// observance builds a STANDARD or DAYLIGHT sub-component. local is the wall
// clock time (in the old offset) at which the observance starts.
func observance(dst bool, local time.Time, from, to int, name, rule string) *ical.Component {
	kind := ical.CompTimezoneStandard
	if dst {
		kind = ical.CompTimezoneDaylight
	}
	c := ical.NewComponent(kind)
	start := ical.NewProp(ical.PropDateTimeStart)
	start.Value = local.Format(icalDateTime)
	c.Props.Set(start)
	c.Props.Set(rawProp(ical.PropTimezoneOffsetFrom, formatOffset(from)))
	c.Props.Set(rawProp(ical.PropTimezoneOffsetTo, formatOffset(to)))
	if name != "" {
		c.Props.SetText(ical.PropTimezoneName, name)
	}
	if rule != "" {
		c.Props.Set(rawProp(ical.PropRecurrenceRule, rule))
	}
	return c
}

// yearlyRule returns an RRULE matching the weekday-in-month of local, using
// -1 for the last occurrence of the weekday in the month.
func yearlyRule(local time.Time) string {
	day := local.Day()
	daysInMonth := time.Date(local.Year(), local.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	n := (day-1)/7 + 1
	if day+7 > daysInMonth {
		n = -1
	}
	wd := [...]string{"SU", "MO", "TU", "WE", "TH", "FR", "SA"}[local.Weekday()]
	return fmt.Sprintf("FREQ=YEARLY;BYMONTH=%d;BYDAY=%d%s", int(local.Month()), n, wd)
}

// formatOffset formats a UTC offset in seconds as "+hhmm" or "+hhmmss".
func formatOffset(sec int) string {
	sign := '+'
	if sec < 0 {
		sign, sec = '-', -sec
	}
	h, m, s := sec/3600, sec%3600/60, sec%60
	if s != 0 {
		return fmt.Sprintf("%c%02d%02d%02d", sign, h, m, s)
	}
	return fmt.Sprintf("%c%02d%02d", sign, h, m)
}

func rawProp(name, value string) *ical.Prop {
	p := ical.NewProp(name)
	p.Value = value
	return p
}
