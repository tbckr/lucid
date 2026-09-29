package domain

import (
	"encoding/json"
	"errors"
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
		{"unknown timezone", TodoInput{Title: "x", Timezone: "Mars/Base"}, true},
		{"known timezone", TodoInput{Title: "x", Timezone: "Europe/Berlin"}, false},
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
