package caldav

import (
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
	t      time.Time // in loc for TZID values, UTC otherwise
	allDay bool
	tzid   string // IANA name if the value had a resolvable TZID
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
// unknown TZIDs fall back to UTC.
func parseDateValue(v string, params ical.Params) (dateValue, error) {
	v = strings.TrimSpace(v)
	if strings.EqualFold(params.Get(ical.ParamValue), string(ical.ValueDate)) || len(v) == len(icalDate) {
		t, err := time.ParseInLocation(icalDate, v, time.UTC)
		if err != nil {
			return dateValue{}, fmt.Errorf("invalid date %q: %w", v, err)
		}
		return dateValue{t: t, allDay: true}, nil
	}
	if strings.HasSuffix(v, "Z") {
		t, err := time.ParseInLocation(icalDateTimeUTC, v, time.UTC)
		if err != nil {
			return dateValue{}, fmt.Errorf("invalid date-time %q: %w", v, err)
		}
		return dateValue{t: t}, nil
	}
	loc, tzid := time.UTC, ""
	if raw := params.Get(ical.ParamTimezoneID); raw != "" {
		if l := loadLocation(raw); l != nil {
			loc, tzid = l, l.String()
		}
	}
	t, err := time.ParseInLocation(icalDateTime, v, loc)
	if err != nil {
		return dateValue{}, fmt.Errorf("invalid date-time %q: %w", v, err)
	}
	return dateValue{t: t, tzid: tzid}, nil
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

func (s span) addTo(t time.Time) time.Time {
	return t.AddDate(0, 0, s.days).Add(s.exact)
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

// setText sets a text property, removing it when value is empty.
func setText(props ical.Props, name, value string) {
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
	if value == "" {
		props.Del(name)
		return
	}
	props.SetText(name, value)
}
