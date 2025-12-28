package caldav

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// ParseEvent parses an iCal VEVENT component into an Event struct.
// It handles timezones, all-day events, and extracts all standard fields.
func ParseEvent(icalData string) (*Event, error) {
	dec := ical.NewDecoder(strings.NewReader(icalData))
	cal, err := dec.Decode()
	if err != nil {
		return nil, fmt.Errorf("failed to decode iCal: %w", err)
	}

	// Find VEVENT component
	for _, comp := range cal.Children {
		if comp.Name == ical.CompEvent {
			return parseVEvent(comp, cal)
		}
	}

	return nil, errors.New("no VEVENT component found")
}

// ParseEvents parses multiple VEVENT components from an iCal calendar.
func ParseEvents(icalData string) ([]*Event, error) {
	dec := ical.NewDecoder(strings.NewReader(icalData))
	cal, err := dec.Decode()
	if err != nil {
		return nil, fmt.Errorf("failed to decode iCal: %w", err)
	}

	var events []*Event
	for _, comp := range cal.Children {
		if comp.Name == ical.CompEvent {
			event, err := parseVEvent(comp, cal)
			if err != nil {
				// Log but continue parsing other events
				continue
			}
			events = append(events, event)
		}
	}

	if len(events) == 0 {
		return nil, errors.New("no valid VEVENT components found")
	}

	return events, nil
}

// parseVEvent converts an ical.Component to an Event.
func parseVEvent(comp *ical.Component, cal *ical.Calendar) (*Event, error) {
	event := &Event{}

	// Extract UID (required)
	if uid := comp.Props.Get(ical.PropUID); uid != nil {
		event.ID = uid.Value
	} else {
		return nil, errors.New("VEVENT missing required UID")
	}

	// Extract SUMMARY
	if summary := comp.Props.Get(ical.PropSummary); summary != nil {
		event.Summary = summary.Value
	}

	// Extract DESCRIPTION
	if desc := comp.Props.Get(ical.PropDescription); desc != nil {
		event.Description = desc.Value
	}

	// Extract LOCATION
	if loc := comp.Props.Get(ical.PropLocation); loc != nil {
		event.Location = loc.Value
	}

	// Extract DTSTART (required)
	dtstart := comp.Props.Get(ical.PropDateTimeStart)
	if dtstart == nil {
		return nil, errors.New("VEVENT missing required DTSTART")
	}
	start, allDayStart, err := parseDateTime(dtstart, cal)
	if err != nil {
		return nil, fmt.Errorf("failed to parse DTSTART: %w", err)
	}
	event.Start = start
	event.AllDay = allDayStart

	// Extract DTEND or DURATION
	if dtend := comp.Props.Get(ical.PropDateTimeEnd); dtend != nil {
		end, _, err := parseDateTime(dtend, cal)
		if err != nil {
			return nil, fmt.Errorf("failed to parse DTEND: %w", err)
		}
		event.End = end
	} else if duration := comp.Props.Get(ical.PropDuration); duration != nil {
		// Parse duration and add to start time
		dur, err := parseDuration(duration.Value)
		if err != nil {
			return nil, fmt.Errorf("failed to parse DURATION: %w", err)
		}
		event.End = event.Start.Add(dur)
	} else {
		// Default for all-day events: end = start + 1 day
		if event.AllDay {
			event.End = event.Start.Add(24 * time.Hour)
		} else {
			// For timed events without DTEND, end = start
			event.End = event.Start
		}
	}

	// Extract RRULE (recurrence rule)
	if rrule := comp.Props.Get(ical.PropRecurrenceRule); rrule != nil {
		event.RRule = rrule.Value
	}

	// Extract EXDATE (exception dates)
	var exdates []time.Time
	for _, exdate := range comp.Props.Values(ical.PropExceptionDateTime) {
		// EXDATE can be a comma-separated list
		for _, dateStr := range strings.Split(exdate, ",") {
			t, err := parseTimeValue(strings.TrimSpace(dateStr), nil)
			if err != nil {
				continue // Skip invalid EXDATEs
			}
			exdates = append(exdates, t)
		}
	}
	event.ExDates = exdates

	// Extract STATUS
	if status := comp.Props.Get(ical.PropStatus); status != nil {
		event.Status = status.Value
	}

	// Extract organizer
	if organizer := comp.Props.Get(ical.PropOrganizer); organizer != nil {
		event.Organizer = strings.TrimPrefix(organizer.Value, "mailto:")
	}

	// Extract attendees
	for _, attendee := range comp.Props.Values(ical.PropAttendee) {
		event.Attendees = append(event.Attendees, strings.TrimPrefix(attendee, "mailto:"))
	}

	// Convert times to UTC for storage
	event.Start = event.Start.UTC()
	event.End = event.End.UTC()
	for i := range event.ExDates {
		event.ExDates[i] = event.ExDates[i].UTC()
	}

	return event, nil
}

// parseDateTime parses a DATE or DATE-TIME property.
// Returns the time, whether it's an all-day event, and any error.
func parseDateTime(prop *ical.Prop, cal *ical.Calendar) (time.Time, bool, error) {
	// Check if it's a DATE (all-day event)
	if valueType := prop.Params.Get(ical.ParamValue); valueType == "DATE" {
		t, err := parseTimeValue(prop.Value, nil)
		return t, true, err
	}

	// It's a DATE-TIME
	// Check for TZID parameter
	tzid := prop.Params.Get(ical.ParamTZID)
	var loc *time.Location
	if tzid != "" {
		// Try to find VTIMEZONE in calendar
		loc = findTimezone(cal, tzid)
	}

	t, err := parseTimeValue(prop.Value, loc)
	return t, false, err
}

// findTimezone finds a VTIMEZONE component in the calendar by TZID.
// Falls back to IANA timezone database if available.
func findTimezone(cal *ical.Calendar, tzid string) *time.Location {
	// Try IANA timezone database first
	if loc, err := time.LoadLocation(tzid); err == nil {
		return loc
	}

	// Try to parse VTIMEZONE component
	for _, comp := range cal.Children {
		if comp.Name == ical.CompTimezone {
			if id := comp.Props.Get(ical.PropTimezoneID); id != nil && id.Value == tzid {
				// Parse VTIMEZONE (simplified - just try IANA fallback)
				// Full VTIMEZONE parsing is complex, so we rely on IANA names
				if loc, err := time.LoadLocation(id.Value); err == nil {
					return loc
				}
			}
		}
	}

	// Fallback to UTC
	return time.UTC
}

// parseTimeValue parses an iCal date or datetime value.
func parseTimeValue(value string, loc *time.Location) (time.Time, error) {
	value = strings.TrimSpace(value)

	// DATE format: YYYYMMDD
	if len(value) == 8 {
		t, err := time.Parse("20060102", value)
		if err != nil {
			return time.Time{}, err
		}
		if loc != nil {
			t = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
		}
		return t, nil
	}

	// DATE-TIME format: YYYYMMDDTHHmmss or YYYYMMDDTHHmmssZ
	if strings.HasSuffix(value, "Z") {
		// UTC time
		return time.Parse("20060102T150405Z", value)
	}

	// Local or TZID time
	t, err := time.Parse("20060102T150405", value)
	if err != nil {
		return time.Time{}, err
	}

	if loc != nil {
		t = time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), 0, loc)
	}

	return t, nil
}

// parseDuration parses an iCal DURATION value (RFC 5545 format).
// Format: [+-]P[nW][nD][T[nH][nM][nS]]
func parseDuration(value string) (time.Duration, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, errors.New("empty duration")
	}

	// Handle sign
	sign := time.Duration(1)
	if value[0] == '-' {
		sign = -1
		value = value[1:]
	} else if value[0] == '+' {
		value = value[1:]
	}

	// Must start with P
	if !strings.HasPrefix(value, "P") {
		return 0, errors.New("duration must start with P")
	}
	value = value[1:]

	var total time.Duration

	// Parse weeks (nW)
	if idx := strings.Index(value, "W"); idx != -1 {
		var weeks int
		if _, err := fmt.Sscanf(value[:idx], "%d", &weeks); err == nil {
			total += time.Duration(weeks) * 7 * 24 * time.Hour
		}
		value = value[idx+1:]
		return sign * total, nil // Weeks cannot combine with other units
	}

	// Parse days (nD)
	if idx := strings.Index(value, "D"); idx != -1 {
		var days int
		if _, err := fmt.Sscanf(value[:idx], "%d", &days); err == nil {
			total += time.Duration(days) * 24 * time.Hour
		}
		value = value[idx+1:]
	}

	// Parse time component (after T)
	if strings.HasPrefix(value, "T") {
		value = value[1:]

		// Hours
		if idx := strings.Index(value, "H"); idx != -1 {
			var hours int
			if _, err := fmt.Sscanf(value[:idx], "%d", &hours); err == nil {
				total += time.Duration(hours) * time.Hour
			}
			value = value[idx+1:]
		}

		// Minutes
		if idx := strings.Index(value, "M"); idx != -1 {
			var minutes int
			if _, err := fmt.Sscanf(value[:idx], "%d", &minutes); err == nil {
				total += time.Duration(minutes) * time.Minute
			}
			value = value[idx+1:]
		}

		// Seconds
		if idx := strings.Index(value, "S"); idx != -1 {
			var seconds int
			if _, err := fmt.Sscanf(value[:idx], "%d", &seconds); err == nil {
				total += time.Duration(seconds) * time.Second
			}
		}
	}

	return sign * total, nil
}

// FormatEvent converts an Event to iCal VEVENT format.
// This is used for creating/updating events on the CalDAV server.
func FormatEvent(event *Event) (string, error) {
	var buf strings.Builder

	buf.WriteString("BEGIN:VCALENDAR\r\n")
	buf.WriteString("VERSION:2.0\r\n")
	buf.WriteString("PRODID:-//Lucid//CalDAV Client//EN\r\n")
	buf.WriteString("BEGIN:VEVENT\r\n")

	// UID (required)
	if event.ID == "" {
		return "", errors.New("event ID is required")
	}
	fmt.Fprintf(&buf, "UID:%s\r\n", event.ID)

	// SUMMARY
	if event.Summary != "" {
		fmt.Fprintf(&buf, "SUMMARY:%s\r\n", escapeText(event.Summary))
	}

	// DESCRIPTION
	if event.Description != "" {
		fmt.Fprintf(&buf, "DESCRIPTION:%s\r\n", escapeText(event.Description))
	}

	// LOCATION
	if event.Location != "" {
		fmt.Fprintf(&buf, "LOCATION:%s\r\n", escapeText(event.Location))
	}

	// DTSTART (required)
	if event.Start.IsZero() {
		return "", errors.New("event start time is required")
	}
	if event.AllDay {
		fmt.Fprintf(&buf, "DTSTART;VALUE=DATE:%s\r\n", event.Start.Format("20060102"))
	} else {
		fmt.Fprintf(&buf, "DTSTART:%s\r\n", event.Start.UTC().Format("20060102T150405Z"))
	}

	// DTEND
	if !event.End.IsZero() {
		if event.AllDay {
			fmt.Fprintf(&buf, "DTEND;VALUE=DATE:%s\r\n", event.End.Format("20060102"))
		} else {
			fmt.Fprintf(&buf, "DTEND:%s\r\n", event.End.UTC().Format("20060102T150405Z"))
		}
	}

	// RRULE
	if event.RRule != "" {
		fmt.Fprintf(&buf, "RRULE:%s\r\n", event.RRule)
	}

	// EXDATE
	if len(event.ExDates) > 0 {
		buf.WriteString("EXDATE:")
		for i, exdate := range event.ExDates {
			if i > 0 {
				buf.WriteString(",")
			}
			buf.WriteString(exdate.UTC().Format("20060102T150405Z"))
		}
		buf.WriteString("\r\n")
	}

	// STATUS
	if event.Status != "" {
		fmt.Fprintf(&buf, "STATUS:%s\r\n", event.Status)
	}

	// ORGANIZER
	if event.Organizer != "" {
		fmt.Fprintf(&buf, "ORGANIZER:mailto:%s\r\n", event.Organizer)
	}

	// ATTENDEES
	for _, attendee := range event.Attendees {
		fmt.Fprintf(&buf, "ATTENDEE:mailto:%s\r\n", attendee)
	}

	// DTSTAMP (current time)
	fmt.Fprintf(&buf, "DTSTAMP:%s\r\n", time.Now().UTC().Format("20060102T150405Z"))

	buf.WriteString("END:VEVENT\r\n")
	buf.WriteString("END:VCALENDAR\r\n")

	return buf.String(), nil
}

// escapeText escapes special characters in iCal text values.
func escapeText(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "\n", "\\n")
	s = strings.ReplaceAll(s, ",", "\\,")
	s = strings.ReplaceAll(s, ";", "\\;")
	return s
}

// ParseEventsFromReader parses VEVENT components from an io.Reader.
// Useful for parsing REPORT responses.
func ParseEventsFromReader(r io.Reader) ([]*Event, error) {
	dec := ical.NewDecoder(r)
	
	var events []*Event
	for {
		cal, err := dec.Decode()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("failed to decode iCal: %w", err)
		}

		for _, comp := range cal.Children {
			if comp.Name == ical.CompEvent {
				event, err := parseVEvent(comp, cal)
				if err != nil {
					// Log but continue parsing other events
					continue
				}
				events = append(events, event)
			}
		}
	}

	return events, nil
}
