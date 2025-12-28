package caldav

import (
	"fmt"
	"strings"
	"time"
)

// RRuleExpander handles RRULE parsing and expansion
type BasicRRuleExpander struct{}

// Expand expands a RRULE for a given time window
func (e *BasicRRuleExpander) Expand(rrule string, baseTime time.Time, endTime time.Time, exceptions []string) ([]time.Time, error) {
	if rrule == "" {
		return []time.Time{baseTime}, nil
	}
	
	var occurrences []time.Time
	occurrences = append(occurrences, baseTime)
	
	// Parse RRULE
	parts := strings.Split(rrule, ";")
	freq := ""
	interval := 1
	count := 0
	until := time.Time{}
	byDay := []string{}
	
	for _, part := range parts {
		kv := strings.Split(part, "=")
		if len(kv) != 2 {
			continue
		}
		
		key := strings.TrimSpace(kv[0])
		val := strings.TrimSpace(kv[1])
		
		switch key {
		case "FREQ":
			freq = val
		case "INTERVAL":
			fmt.Sscanf(val, "%d", &interval)
		case "COUNT":
			fmt.Sscanf(val, "%d", &count)
		case "UNTIL":
			until, _ = time.Parse("20060102T150405Z", val)
		case "BYDAY":
			byDay = strings.Split(val, ",")
		}
	}
	
	if freq == "" {
		return occurrences, nil
	}
	
	// Limit expansion to prevent infinite loops (max 2 years)
	maxUntil := baseTime.AddDate(2, 0, 0)
	if until.IsZero() {
		until = maxUntil
	}
	if until.After(maxUntil) {
		until = maxUntil
	}
	
	// Expand occurrences based on frequency
	current := baseTime
	occurrenceCount := 1
	
	for current.Before(until) && current.Before(endTime) {
		// Don't exceed the end date or count limit
		if count > 0 && occurrenceCount >= count {
			break
		}
		
		// Add next occurrence based on frequency
		currentOccurrence := e.nextOccurrence(current, freq, interval, baseTime)
		if currentOccurrence.After(until) || currentOccurrence.After(endTime) {
			break
		}
		
		// Check if this occurrence is in the requested time window
		if currentOccurrence.After(baseTime) || currentOccurrence.Equal(baseTime) {
			// Check if not in exceptions
			if !e.isException(currentOccurrence, exceptions) {
				occurrences = append(occurrences, currentOccurrence)
			}
		}
		
		current = currentOccurrence
		occurrenceCount++
		
		// Safety check to prevent infinite loops
		if occurrenceCount > 1000 {
			break
		}
	}
	
	return occurrences, nil
}

func (e *BasicRRuleExpander) nextOccurrence(current time.Time, freq string, interval int, baseTime time.Time) time.Time {
	switch freq {
	case "DAILY":
		return current.AddDate(0, 0, interval)
	case "WEEKLY":
		return current.AddDate(0, 0, interval*7)
	case "MONTHLY":
		return current.AddDate(0, interval, 0)
	case "YEARLY":
		return current.AddDate(interval, 0, 0)
	default:
		return current.AddDate(0, 0, 1) // Default to daily
	}
}

func (e *BasicRRuleExpander) isException(occurrence time.Time, exceptions []string) bool {
	dateStr := occurrence.Format("20060102")
	for _, exc := range exceptions {
		excDate := strings.TrimSpace(exc)
		// Handle both DATE and DATETIME formats
		if strings.HasPrefix(excDate, dateStr) {
			return true
		}
	}
	return false
}

// NewBasicRRuleExpander creates a new RRULE expander
func NewBasicRRuleExpander() *BasicRRuleExpander {
	return &BasicRRuleExpander{}
}
