package diag

import "testing"

func TestIcalNamesAreListedOnce(t *testing.T) {
	t.Parallel()
	seen := map[string]bool{}
	for _, name := range icalNames {
		if seen[name] {
			t.Errorf("%q is listed twice", name)
		}
		seen[name] = true
		if !xName.MatchString("X-" + name) { // a name is capitals, digits and hyphens, nothing else
			t.Errorf("%q is not made of capitals, digits and hyphens", name)
		}
	}
	if len(icalNameSet) != len(icalNames) {
		t.Errorf("icalNameSet has %d names, icalNames %d", len(icalNameSet), len(icalNames))
	}
}

func TestKnownName(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		want bool
	}{
		{"SUMMARY", true},
		{"VEVENT", true},
		{"RRULE", true},
		{"EXRULE", true},
		// RFC 7986, 6638, 9073 and 9074.
		{"COLOR", true},
		{"REFRESH-INTERVAL", true},
		{"SCHEDULE-AGENT", true},
		{"PARTICIPANT", true},
		{"PROXIMITY", true},
		// x-names, in uppercase only.
		{"X-WR-CALNAME", true},
		{"X-MOZ-LASTACK", true},
		{"X-0", true},
		{"X-", false},
		{"X-Men", false},
		{"x-wr-calname", false},
		{"X-A B", false},
		{"X_A", false},
		{"XX-A", false},
		// Anything else, or a known name in another case, is somebody's text.
		{"Summary", false},
		{"summary", false},
		{"Bob", false},
		{"Status", false},
		{"SUMMARY ", false},
		{"", false},
		{"DATE-TIME", false}, // a value type, Reason's business
	}
	for _, tc := range tests {
		if got := knownName(tc.name); got != tc.want {
			t.Errorf("knownName(%q) = %v, want %v", tc.name, got, tc.want)
		}
	}
}
