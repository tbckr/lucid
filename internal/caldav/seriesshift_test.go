package caldav

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// seriesShiftCase is one row of testdata/series-shift.json (FR-17): a rule
// and a move it is tried against, and the rule seriesShift should return,
// or null if the move is not allowed.
type seriesShiftCase struct {
	Name string  `json:"name"`
	Rule string  `json:"rule"`
	From string  `json:"from"`
	To   string  `json:"to"`
	Want *string `json:"want"`
}

func readSeriesShiftCases(t *testing.T) []seriesShiftCase {
	t.Helper()
	data, err := os.ReadFile("testdata/series-shift.json")
	if err != nil {
		t.Fatalf("read testdata: %v", err)
	}
	var cases []seriesShiftCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("unmarshal testdata: %v", err)
	}
	return cases
}

// TestSeriesShift checks seriesShift against the shared case table (spec §3,
// FR-17), also read by the frontend's equivalent test.
func TestSeriesShift(t *testing.T) {
	t.Parallel()
	for _, c := range readSeriesShiftCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			t.Parallel()
			from, err := time.Parse("2006-01-02T15:04", c.From)
			if err != nil {
				t.Fatalf("parse from: %v", err)
			}
			to, err := time.Parse("2006-01-02T15:04", c.To)
			if err != nil {
				t.Fatalf("parse to: %v", err)
			}

			got, ok := seriesShift(c.Rule, from, to)

			if want := c.Want != nil; ok != want {
				t.Fatalf("seriesShift(%q, %v, %v) ok = %v, want %v", c.Rule, from, to, ok, want)
			}
			if ok && got != *c.Want {
				t.Errorf("seriesShift(%q, %v, %v) = %q, want %q", c.Rule, from, to, got, *c.Want)
			}
		})
	}
}

// TestSeriesShiftStartOffByDay checks an INTERVAL > 1 rule whose DTSTART
// lies on none of its BYDAY days (FR-17): DTSTART's week anchors the
// rule's weeks, so it must land in the same relative week as the days, or
// the rule's events would move by another distance than DTSTART. Only the
// server knows DTSTART, so these cases are not in the table shared with the
// browser, which passes the moved event's start.
func TestSeriesShiftStartOffByDay(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		rule     string
		from, to time.Time
		want     string // "" for a move that is not allowed
	}{
		{
			// Sunday DTSTART, +1 day: it enters the next week while MO,TU
			// stay in theirs, so the events would move by -6 days.
			name: "start leaves the days' week",
			rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU",
			from: time.Date(2026, 3, 8, 9, 0, 0, 0, time.UTC),
			to:   time.Date(2026, 3, 9, 9, 0, 0, 0, time.UTC),
		},
		{
			name: "start stays in the days' week",
			rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,WE",
			from: time.Date(2026, 3, 9, 9, 0, 0, 0, time.UTC),
			to:   time.Date(2026, 3, 10, 9, 0, 0, 0, time.UTC),
			want: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,TH",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, ok := seriesShift(tt.rule, tt.from, tt.to)
			if want := tt.want != ""; ok != want || got != tt.want {
				t.Errorf("seriesShift(%q, %v, %v) = %q, %v; want %q, %v", tt.rule, tt.from, tt.to, got, ok, tt.want, want)
			}
		})
	}
}
