package domain

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
)

// Clients that predate `rrule` omit it entirely; only an explicit "" clears
// it (FR-17), mirroring TestUpdateTodoStartPresence's StartOmitted contract.
func TestTodoInputUnmarshalRRule(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name, body string
		wantErr    bool
		omitted    bool
		rrule      string
	}{
		{"omitted", `{"title":"x"}`, false, true, ""},
		{"empty", `{"title":"x","rrule":""}`, false, false, ""},
		{"value case-insensitive key", `{"title":"x","RRULE":"FREQ=DAILY"}`, false, false, "FREQ=DAILY"},
		{"unknown field", `{"title":"x","rrul":1}`, true, false, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var in TodoInput
			err := json.Unmarshal([]byte(tt.body), &in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("Unmarshal(%q) = nil error, want error", tt.body)
				}
				return
			}
			if err != nil {
				t.Fatalf("Unmarshal(%q) = %v, want nil", tt.body, err)
			}
			if in.RRuleOmitted != tt.omitted {
				t.Errorf("RRuleOmitted = %v, want %v", in.RRuleOmitted, tt.omitted)
			}
			if in.RRule != tt.rrule {
				t.Errorf("RRule = %q, want %q", in.RRule, tt.rrule)
			}
		})
	}
}

func TestTodoInputValidateRRule(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name    string
		in      TodoInput
		wantErr bool
	}{
		{"rrule too long", TodoInput{Title: "x", RRule: strings.Repeat("x", MaxRRuleLen+1)}, true},
		{"unknown timezone", TodoInput{Title: "x", Timezone: ptr("Mars/Base")}, true},
		{"known timezone", TodoInput{Title: "x", Timezone: ptr("Europe/Berlin")}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := tt.in.Validate()
			if tt.wantErr {
				if !errors.Is(err, ErrInvalidInput) {
					t.Fatalf("Validate() = %v, want ErrInvalidInput", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Validate() = %v, want nil", err)
			}
		})
	}
}

func ptr[T any](v T) *T { return &v }

// zoneFieldCases are the decoding and validation cases of a pair of zone
// fields that EventInput and OccurrenceInput share: absent is nil, "" is a
// sent empty zone, and Validate refuses what time.LoadLocation does (FR-18).
type zoneFieldCase struct {
	name, body            string
	wantTimezone, wantEnd *string
	wantInvalid           bool
}

func zoneFieldCases() []zoneFieldCase {
	const base = `"title":"a","start":"2025-03-05T10:00:00Z","end":"2025-03-05T11:00:00Z","allDay":false`
	return []zoneFieldCase{
		{name: "absent", body: `{` + base + `}`},
		{name: "empty timezone", body: `{` + base + `,"timezone":""}`, wantTimezone: ptr("")},
		{
			name: "both", body: `{` + base + `,"timezone":"Europe/Berlin","endTimezone":"America/New_York"}`,
			wantTimezone: ptr("Europe/Berlin"), wantEnd: ptr("America/New_York"),
		},
		{name: "etc utc", body: `{` + base + `,"timezone":"Etc/UTC","endTimezone":"Etc/UTC"}`, wantTimezone: ptr("Etc/UTC"), wantEnd: ptr("Etc/UTC")},
		{name: "unknown end timezone", body: `{` + base + `,"endTimezone":"Mars/Olympus"}`, wantEnd: ptr("Mars/Olympus"), wantInvalid: true},
		{name: "unknown timezone", body: `{` + base + `,"timezone":"Mars/Olympus"}`, wantTimezone: ptr("Mars/Olympus"), wantInvalid: true},
	}
}

func eqStrPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func showStrPtr(p *string) string {
	if p == nil {
		return "nil"
	}
	return strconv.Quote(*p)
}

func checkValidate(t *testing.T, err error, wantInvalid bool) {
	t.Helper()
	if wantInvalid {
		if !errors.Is(err, ErrInvalidInput) {
			t.Errorf("Validate() = %v, want ErrInvalidInput", err)
		}
		return
	}
	if err != nil {
		t.Errorf("Validate() = %v, want nil", err)
	}
}

func TestEventInputZoneFields(t *testing.T) {
	t.Parallel()
	for _, tt := range zoneFieldCases() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var in EventInput
			if err := json.Unmarshal([]byte(tt.body), &in); err != nil {
				t.Fatalf("Unmarshal(%s) = %v", tt.body, err)
			}
			if !eqStrPtr(in.Timezone, tt.wantTimezone) {
				t.Errorf("Timezone = %s, want %s", showStrPtr(in.Timezone), showStrPtr(tt.wantTimezone))
			}
			if !eqStrPtr(in.EndTimezone, tt.wantEnd) {
				t.Errorf("EndTimezone = %s, want %s", showStrPtr(in.EndTimezone), showStrPtr(tt.wantEnd))
			}
			checkValidate(t, in.Validate(), tt.wantInvalid)
		})
	}
}

func TestOccurrenceInputZoneFields(t *testing.T) {
	t.Parallel()
	for _, tt := range zoneFieldCases() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var in OccurrenceInput
			if err := json.Unmarshal([]byte(tt.body), &in); err != nil {
				t.Fatalf("Unmarshal(%s) = %v", tt.body, err)
			}
			if !eqStrPtr(in.Timezone, tt.wantTimezone) {
				t.Errorf("Timezone = %s, want %s", showStrPtr(in.Timezone), showStrPtr(tt.wantTimezone))
			}
			if !eqStrPtr(in.EndTimezone, tt.wantEnd) {
				t.Errorf("EndTimezone = %s, want %s", showStrPtr(in.EndTimezone), showStrPtr(tt.wantEnd))
			}
			checkValidate(t, in.Validate(), tt.wantInvalid)
		})
	}
}

func TestTodoInputZoneFields(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name, body               string
		wantTimezone, wantDue    *string
		startOmitted, rruleOmitt bool
		wantInvalid              bool
	}{
		{name: "absent", body: `{"title":"x"}`, startOmitted: true, rruleOmitt: true},
		{name: "empty timezone", body: `{"title":"x","timezone":""}`, wantTimezone: ptr(""), startOmitted: true, rruleOmitt: true},
		{name: "due timezone", body: `{"title":"x","dueTimezone":"Asia/Tokyo"}`, wantDue: ptr("Asia/Tokyo"), startOmitted: true, rruleOmitt: true},
		{
			name: "both with start and rrule", body: `{"title":"x","start":null,"rrule":"","timezone":"Europe/Berlin","dueTimezone":"Asia/Tokyo"}`,
			wantTimezone: ptr("Europe/Berlin"), wantDue: ptr("Asia/Tokyo"),
		},
		{name: "unknown due timezone", body: `{"title":"x","dueTimezone":"Mars/Olympus"}`, wantDue: ptr("Mars/Olympus"), startOmitted: true, rruleOmitt: true, wantInvalid: true},
		{name: "unknown timezone", body: `{"title":"x","timezone":"Mars/Olympus"}`, wantTimezone: ptr("Mars/Olympus"), startOmitted: true, rruleOmitt: true, wantInvalid: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var in TodoInput
			if err := json.Unmarshal([]byte(tt.body), &in); err != nil {
				t.Fatalf("Unmarshal(%s) = %v", tt.body, err)
			}
			if !eqStrPtr(in.Timezone, tt.wantTimezone) {
				t.Errorf("Timezone = %s, want %s", showStrPtr(in.Timezone), showStrPtr(tt.wantTimezone))
			}
			if !eqStrPtr(in.DueTimezone, tt.wantDue) {
				t.Errorf("DueTimezone = %s, want %s", showStrPtr(in.DueTimezone), showStrPtr(tt.wantDue))
			}
			if in.StartOmitted != tt.startOmitted || in.RRuleOmitted != tt.rruleOmitt {
				t.Errorf("StartOmitted, RRuleOmitted = %v, %v, want %v, %v", in.StartOmitted, in.RRuleOmitted, tt.startOmitted, tt.rruleOmitt)
			}
			checkValidate(t, in.Validate(), tt.wantInvalid)
		})
	}
}

func TestValidZone(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name string
		zone *string
		ok   bool
	}{
		{"nil", nil, true},
		{"empty", ptr(""), true},
		{"UTC", ptr("UTC"), true},
		{"Etc/UTC", ptr("Etc/UTC"), true},
		{"Europe/Berlin", ptr("Europe/Berlin"), true},
		{"unknown", ptr("Mars/Olympus"), false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := validZone(tt.zone)
			if tt.ok && err != nil {
				t.Errorf("validZone() = %v, want nil", err)
			}
			if !tt.ok && !errors.Is(err, ErrInvalidInput) {
				t.Errorf("validZone() = %v, want ErrInvalidInput", err)
			}
		})
	}
}
