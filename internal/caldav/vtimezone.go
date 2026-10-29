package caldav

import (
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/emersion/go-ical"
)

// ensureVTimezoneAs adds a VTIMEZONE for loc to cal under the TZID tzid,
// loc's IANA name or another, such as
// "/mozilla.org/20050126_1/Europe/Berlin", unless one with that TZID exists
// (FR-17). VTIMEZONE components are placed before other components.
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
		if c.Name == ical.CompTimezone && vtimezoneID(c) == tzid {
			return c
		}
	}
	return nil
}

// pruneVTimezones removes the VTIMEZONEs of cal that no TZID parameter of
// another component's properties refers to, its subcomponents' (VALARMs)
// included, such as that of the zone an event was in before a write put it
// into another (FR-18): RFC 5545 section 3.2.19 asks for a VTIMEZONE for
// each TZID used, and one left over would still be read by other clients.
func pruneVTimezones(cal *ical.Calendar) {
	used := map[string]bool{}
	var refer func(c *ical.Component)
	refer = func(c *ical.Component) {
		for _, props := range c.Props {
			for _, p := range props {
				for _, tzid := range p.Params.Values(ical.ParamTimezoneID) {
					used[tzid] = true
				}
			}
		}
		for _, child := range c.Children {
			refer(child)
		}
	}
	for _, c := range cal.Children {
		if c.Name != ical.CompTimezone {
			refer(c)
		}
	}
	cal.Children = slices.DeleteFunc(cal.Children, func(c *ical.Component) bool {
		return c.Name == ical.CompTimezone && !used[vtimezoneID(c)]
	})
}

// tzidUnescaper undoes the escapes of a TEXT value, see vtimezoneID.
var tzidUnescaper = strings.NewReplacer(`\\`, `\`, `\;`, ";", `\,`, ",", `\n`, "\n", `\N`, "\n")

// vtimezoneID returns the TZID of the VTIMEZONE c as a TZID parameter names
// it: its TEXT value unescaped, but not split at commas, as text would. A
// display name such as Outlook's "(UTC+01:00) Amsterdam, Berlin, …" is
// written there without escaping its commas, while the parameter quotes it;
// cut at the first comma it would match no TZID parameter (FR-18).
func vtimezoneID(c *ical.Component) string {
	p := c.Props.Get(ical.PropTimezoneID)
	if p == nil {
		return ""
	}
	return tzidUnescaper.Replace(p.Value)
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

// transitions returns the offset changes of loc during year. It compares the
// offset from day to day and bisects each change to the second, assuming at
// most one change per day. Time.ZoneBounds cannot be used: for instants that
// only the zone's POSIX TZ rule describes, which in slim tzdata such as Go's
// embedded copy (the only one on Windows) includes the current years, Go
// returns the start and end of the UTC year as bounds, in leap years with an
// end a day early that the next call returns again.
func transitions(loc *time.Location, year int) []transition {
	const day = 24 * time.Hour
	endOfYear := time.Date(year+1, time.January, 1, 0, 0, 0, 0, loc)
	var out []transition
	for t := time.Date(year, time.January, 1, 0, 0, 0, 0, loc); t.Before(endOfYear); t = t.Add(day) {
		_, from := t.Zone()
		if _, to := t.Add(day).Zone(); to == from {
			continue
		}
		i := sort.Search(int(day/time.Second), func(i int) bool {
			_, off := t.Add(time.Duration(i+1) * time.Second).Zone()
			return off != from
		})
		at := t.Add(time.Duration(i+1) * time.Second)
		if at.Before(endOfYear) {
			name, to := at.Zone()
			out = append(out, transition{at: at, from: from, to: to, name: name, dst: at.IsDST()})
		}
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
