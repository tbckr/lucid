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
