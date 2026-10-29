package caldav

import (
	"cmp"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-ical"
)

const (
	icalDate        = "20060102"
	icalDateTime    = "20060102T150405"
	icalDateTimeUTC = "20060102T150405Z"
)

// dateValue is a parsed DATE or DATE-TIME property value.
type dateValue struct {
	t        time.Time // in loc for TZID values, UTC otherwise
	allDay   bool
	tzid     string // IANA name if the value had a resolvable TZID
	param    string // the TZID parameter as written, "" if none
	floating bool   // a DATE-TIME without TZID or "Z", read as UTC
	// wall is the date and clock time the value is written with, read as
	// UTC, also one its zone skips, which no instant has (see zoned); zero
	// for a UTC value ("Z") and for one Lucid built from an instant, whose
	// wall clock is its instant's (see wallIn, #8, FR-18).
	wall time.Time
}

// dateForm is how a date property is written, so that a rewritten value can
// keep the form another client chose (FR-17).
type dateForm struct {
	allDay   bool   // a DATE
	floating bool   // a local DATE-TIME without TZID or "Z"
	tzid     string // IANA zone to write in when param is empty
	param    string // TZID parameter to write verbatim
}

// form returns the form d was written in.
func (d dateValue) form() dateForm {
	return dateForm{allDay: d.allDay, floating: d.floating, tzid: d.tzid, param: d.param}
}

// sentForm returns the form the zone a write names asks for (FR-18): UTC
// ("Z") for "" and "UTC", and for every other name Lucid reads as UTC but
// "Etc/UTC", which is the UTC a user picked and is written as that TZID,
// with its VTIMEZONE; else the zone's IANA name as TZID. A name Lucid cannot
// resolve, which validation turns away, is UTC too.
func sentForm(zone string) dateForm {
	if zone == "Etc/UTC" {
		return dateForm{param: zone}
	}
	loc := loadLocation(zone)
	if loc == nil || loc == time.UTC {
		return dateForm{}
	}
	return dateForm{tzid: loc.String()}
}

// formFor returns the form a timed date property is written in for the
// zone sent: kept, the form it has, where none is sent or the one sent is
// its zone (see sentIsKept), so that a zone sent back as reported is no
// change and the form stays as written; else the one the zone asks for, see
// sentForm (FR-18).
func formFor(sent *string, kept dateForm) dateForm {
	if sent == nil || sentIsKept(*sent, kept) {
		return kept
	}
	return sentForm(*sent)
}

// sentIsKept reports whether the zone sent is the zone of the form kept
// (FR-18), judged by the zone a TZID resolves to, not by how it is spelled
// (see sameZoneForm): Europe/Berlin is
// /mozilla.org/20050126_1/Europe/Berlin, and Etc/UTC any TZID that resolves
// to UTC. "UTC", the zone the API reports for UTC in any form, is also a
// TZID that resolves to it, while "" is UTC without a TZID ("Z") only, and
// Etc/UTC, UTC picked, is no "Z". A floating time and a date have no zone a
// write could name again.
func sentIsKept(sent string, kept dateForm) bool {
	f := sentForm(sent)
	if sameZoneForm(f, kept) {
		return true
	}
	return sent != "" && f == (dateForm{}) && !kept.allDay && !kept.floating &&
		loadLocation(cmp.Or(kept.param, kept.tzid)) == time.UTC
}

// endFormFor returns the form DTEND (DUE) is written in, see formFor: that
// of sentEnd, the end's zone, where sent, else that of sentStart, the
// start's, where sent, else kept, the end's own (FR-18).
func endFormFor(sentEnd, sentStart *string, kept dateForm) dateForm {
	if sentEnd != nil {
		return formFor(sentEnd, kept)
	}
	return formFor(sentStart, kept)
}

// ofType returns the form f gives a value of the type allDay (FR-18): a DATE
// for a date, whatever zone a write names, as no zone makes a date a
// date-time; f for a date-time, UTC where f is a DATE's, for a date given a
// time without a zone.
func (f dateForm) ofType(allDay bool) dateForm {
	switch {
	case allDay:
		return dateForm{allDay: true}
	case f.allDay:
		return dateForm{}
	}
	return f
}

// sameZoneForm reports whether a and b name the same zone (FR-18): both
// DATEs, both floating, both UTC without a TZID ("Z"), or both with a TZID,
// judged by the zone it resolves to, not by its spelling: two TZIDs Lucid
// resolves to the zone of one name, such as Europe/Berlin and
// /mozilla.org/20050126_1/Europe/Berlin, or two it cannot resolve, written
// alike. A TZID that resolves to UTC, such as Etc/UTC, is no "Z", and equal
// instants in two zones are no same zone.
func sameZoneForm(a, b dateForm) bool {
	ta, tb := cmp.Or(a.param, a.tzid), cmp.Or(b.param, b.tzid)
	switch {
	case a.allDay || b.allDay:
		return a.allDay == b.allDay
	case a.floating || b.floating:
		return a.floating == b.floating
	case ta == "" || tb == "":
		return ta == tb
	}
	la, lb := loadLocation(ta), loadLocation(tb)
	if la == nil || lb == nil {
		return la == nil && lb == nil && ta == tb
	}
	return la.String() == lb.String()
}

// rezones reports whether a date-time written in the form kept and then in
// the form f changes its zone, see sameZoneForm (FR-18): a date, and one
// that gets or loses a time, changes its value type instead.
func rezones(f, kept dateForm) bool {
	return !f.allDay && !kept.allDay && !sameZoneForm(f, kept)
}

// zone returns the zone a DATE-TIME of the form f is read in: the one its
// TZID names, else UTC, also for a floating value and a TZID Lucid cannot
// resolve, as parseDateValue reads them (FR-18).
func (f dateForm) zone() *time.Location {
	if loc := loadLocation(cmp.Or(f.tzid, f.param)); loc != nil {
		return loc
	}
	return time.UTC
}

// loc returns the location recurrences of this value are computed in.
func (d dateValue) loc() *time.Location {
	if d.allDay {
		return time.UTC
	}
	return d.t.Location()
}

// parseDateProp parses the first value of a DATE/DATE-TIME property.
func parseDateProp(p *ical.Prop) (dateValue, error) {
	if p == nil {
		return dateValue{}, errors.New("missing date property")
	}
	v, _, _ := strings.Cut(p.Value, ",")
	return parseDateValue(v, p.Params)
}

// parseDateList parses all (comma separated) values of an EXDATE/RDATE
// property. PERIOD values contribute their start.
func parseDateList(p *ical.Prop) ([]dateValue, error) {
	var out []dateValue
	for v := range strings.SplitSeq(p.Value, ",") {
		v, _, _ = strings.Cut(strings.TrimSpace(v), "/")
		if v == "" {
			continue
		}
		d, err := parseDateValue(v, p.Params)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, nil
}

// parseDateValue parses a single value. Floating times are treated as UTC,
// unknown TZIDs fall back to UTC. A TZID value is the instant zoned reads
// its wall clock as, and every value but a UTC one keeps the wall clock it is
// written with (#8, FR-18).
func parseDateValue(v string, params ical.Params) (dateValue, error) {
	v = strings.TrimSpace(v)
	if strings.EqualFold(params.Get(ical.ParamValue), string(ical.ValueDate)) || len(v) == len(icalDate) {
		t, err := time.ParseInLocation(icalDate, v, time.UTC)
		if err != nil {
			return dateValue{}, fmt.Errorf("invalid date %q: %w", v, err)
		}
		return dateValue{t: t, allDay: true, wall: t}, nil
	}
	if strings.HasSuffix(v, "Z") {
		t, err := time.ParseInLocation(icalDateTimeUTC, v, time.UTC)
		if err != nil {
			return dateValue{}, fmt.Errorf("invalid date-time %q: %w", v, err)
		}
		return dateValue{t: t}, nil
	}
	loc, tzid := time.UTC, ""
	raw := params.Get(ical.ParamTimezoneID)
	if raw != "" {
		if l := loadLocation(raw); l != nil {
			loc, tzid = l, l.String()
		}
	}
	w, err := time.ParseInLocation(icalDateTime, v, time.UTC)
	if err != nil {
		return dateValue{}, fmt.Errorf("invalid date-time %q: %w", v, err)
	}
	return dateValue{t: zoned(w, loc), wall: w, tzid: tzid, param: raw, floating: raw == ""}, nil
}

// zoned returns the instant of the wall clock w, its date and clock time
// whatever its location, in loc, as RFC 5545 section 3.3.5 reads a
// DATE-TIME with a TZID: a time a change of loc's UTC offset skips takes the
// offset before the change, so 02:30 on the night Berlin changes to summer
// time is 03:30 CEST, and a time a change back repeats is the first of the
// two. Section 3.3.10, as erratum 4271 corrects it, reads an event of a rule
// at such a time the same way. time.Date leaves both choices open and takes
// them one way east of UTC and the other west of it (#8, FR-18).
func zoned(w time.Time, loc *time.Location) time.Time {
	u := time.Date(w.Year(), w.Month(), w.Day(), w.Hour(), w.Minute(), w.Second(), w.Nanosecond(), time.UTC)
	offAt := func(t time.Time) int {
		_, off := t.In(loc).Zone()
		return off
	}
	// The offsets a day before and after, which no zone changes twice in
	// between: the instant at each, and whether loc has that offset there.
	at := func(off int) (time.Time, bool) {
		t := u.Add(-time.Duration(off) * time.Second)
		return t, offAt(t) == off
	}
	before, beforeOK := at(offAt(u.Add(-24 * time.Hour)))
	after, afterOK := at(offAt(u.Add(24 * time.Hour)))
	if afterOK && (!beforeOK || after.Before(before)) {
		return after.In(loc)
	}
	return before.In(loc) // the time itself, the first of two, or a skipped one
}

// wallClock returns the date and clock time of t in loc, read as UTC (#8,
// FR-18).
func wallClock(t time.Time, loc *time.Location) time.Time {
	w := t.In(loc)
	return time.Date(w.Year(), w.Month(), w.Day(), w.Hour(), w.Minute(), w.Second(), w.Nanosecond(), time.UTC)
}

// atWall returns the value at the wall clock w, its date and clock time read
// as UTC, in loc: its instant there, see zoned, and w itself as the wall
// clock it is written with, also one loc skips (#8, FR-18).
func atWall(w time.Time, loc *time.Location) dateValue {
	w = time.Date(w.Year(), w.Month(), w.Day(), w.Hour(), w.Minute(), w.Second(), w.Nanosecond(), time.UTC)
	return dateValue{t: zoned(w, loc), wall: w}
}

// wallIn returns the wall clock of d in loc, read as UTC: the one d is
// written with where it is written on loc's wall clock (a TZID that
// resolves to loc, or a DATE, a floating value or one with a TZID Lucid
// cannot resolve, for UTC), which can be one loc skips, else its instant's
// there (#8, FR-18).
func (d dateValue) wallIn(loc *time.Location) time.Time {
	if !d.wall.IsZero() && d.t.Location().String() == loc.String() {
		return d.wall
	}
	return wallClock(d.t, loc)
}

var locCache sync.Map // TZID -> *time.Location (nil if unknown)

// loadLocation resolves a TZID to an IANA location. Besides plain IANA names
// it understands prefixed IDs such as "/mozilla.org/20050126_1/Europe/Berlin".
func loadLocation(tzid string) *time.Location {
	if v, ok := locCache.Load(tzid); ok {
		l, _ := v.(*time.Location)
		return l
	}
	l := resolveLocation(tzid)
	locCache.Store(tzid, l)
	return l
}

func resolveLocation(tzid string) *time.Location {
	name := strings.Trim(strings.TrimSpace(tzid), `"`)
	if name == "" || name == "Local" || len(name) > 128 {
		return nil
	}
	if strings.EqualFold(name, "UTC") || strings.EqualFold(name, "GMT") || name == "Etc/UTC" {
		return time.UTC
	}
	segs := strings.Split(strings.Trim(name, "/"), "/")
	// Try the full name first, then shorter suffixes ("Europe/Berlin").
	for i := range segs {
		cand := strings.Join(segs[i:], "/")
		if cand == "" || cand == "Local" {
			continue
		}
		if l, err := time.LoadLocation(cand); err == nil {
			return l
		}
	}
	return nil
}

// span is an iCalendar duration: nominal days plus an exact duration.
type span struct {
	days  int
	exact time.Duration
}

// addTo returns t plus the span: its days on t's wall clock, read as zoned
// reads a time the zone skips or repeats, then its exact duration (#8,
// FR-18).
func (s span) addTo(t time.Time) time.Time {
	loc := t.Location()
	return zoned(wallClock(t, loc).AddDate(0, 0, s.days), loc).Add(s.exact)
}

// approx returns an upper bound of the span as a time.Duration.
func (s span) approx() time.Duration {
	return time.Duration(s.days)*25*time.Hour + s.exact
}

// parseDuration parses an RFC 5545 DURATION value such as "PT1H30M",
// "P1D" or "-P1W".
func parseDuration(v string) (span, error) {
	s := strings.ToUpper(strings.TrimSpace(v))
	neg := false
	switch {
	case strings.HasPrefix(s, "-"):
		neg, s = true, s[1:]
	case strings.HasPrefix(s, "+"):
		s = s[1:]
	}
	if !strings.HasPrefix(s, "P") || len(s) < 3 {
		return span{}, fmt.Errorf("invalid duration %q", v)
	}
	s = s[1:]
	var out span
	inTime := false
	for s != "" {
		if s[0] == 'T' {
			inTime, s = true, s[1:]
			continue
		}
		i := strings.IndexFunc(s, func(r rune) bool { return r < '0' || r > '9' })
		if i <= 0 {
			return span{}, fmt.Errorf("invalid duration %q", v)
		}
		n, err := strconv.Atoi(s[:i])
		if err != nil || n > 1_000_000 {
			return span{}, fmt.Errorf("invalid duration %q", v)
		}
		unit := s[i]
		s = s[i+1:]
		switch {
		case unit == 'W' && !inTime:
			out.days += 7 * n
		case unit == 'D' && !inTime:
			out.days += n
		case unit == 'H' && inTime:
			out.exact += time.Duration(n) * time.Hour
		case unit == 'M' && inTime:
			out.exact += time.Duration(n) * time.Minute
		case unit == 'S' && inTime:
			out.exact += time.Duration(n) * time.Second
		default:
			return span{}, fmt.Errorf("invalid duration %q", v)
		}
	}
	if neg {
		out.days, out.exact = -out.days, -out.exact
	}
	return out, nil
}

// dateOnly returns midnight UTC of t's UTC date.
func dateOnly(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// newDateProp creates a DATE (allDay) or DATE-TIME property. Times in UTC
// (or with a nil location) are written with a "Z" suffix, others with TZID.
func newDateProp(name string, t time.Time, allDay bool, loc *time.Location) *ical.Prop {
	p := ical.NewProp(name)
	switch {
	case allDay:
		p.SetDate(dateOnly(t))
	case loc == nil || loc == time.UTC:
		p.SetDateTime(t.UTC().Truncate(time.Second))
	default:
		p.SetDateTime(t.In(loc).Truncate(time.Second))
	}
	return p
}

// setUTCNow sets a UTC timestamp property such as DTSTAMP.
func setUTCNow(props ical.Props, name string, now time.Time) {
	props.Set(newDateProp(name, now, false, time.UTC))
}

// text returns the unescaped text value of a property ("" if absent).
func text(props ical.Props, name string) string {
	p := props.Get(name)
	if p == nil {
		return ""
	}
	s, err := p.Text()
	if err != nil {
		return p.Value
	}
	return s
}

// textOr returns the unescaped text value of a property, or fallback if the
// property is absent. A present but empty property returns "": an override
// can deliberately clear a field without falling back to the master's value
// (spec section 2 "Leere Felder", FR-17).
func textOr(props ical.Props, name, fallback string) string {
	if props.Get(name) == nil {
		return fallback
	}
	return text(props, name)
}

// setText sets a text property, removing it when value is empty.
func setText(props ical.Props, name, value string) {
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
	if value == "" {
		props.Del(name)
		return
	}
	props.SetText(name, value)
}
