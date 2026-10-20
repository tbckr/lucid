package diag

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestReason(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"nil", nil, ""},
		{"quoted value", errors.New(`ical: invalid VEVENT STATUS: "zz-canary"`), `ical: invalid VEVENT STATUS: "…"`},
		{"escaped quote", errors.New(`bad value "a\"b" here`), `bad value "…" here`},
		{"several", errors.New(`got "x" want "y"`), `got "…" want "…"`},
		{"escaped backslash at the end", errors.New(`path "C:\\"`), `path "…"`},
		{"wrapped", fmt.Errorf("parse: %w", errors.New(`bad "secret"`)), `parse: bad "…"`},
		{"no quotes", errors.New("unexpected EOF"), "unexpected EOF"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := Reason(tc.err)
			if got != tc.want {
				t.Errorf("Reason(%v) = %q, want %q", tc.err, got, tc.want)
			}
			if strings.Contains(got, "canary") || strings.Contains(got, "secret") {
				t.Errorf("Reason(%v) = %q leaks quoted text", tc.err, got)
			}
		})
	}
}

func TestReasonCap(t *testing.T) {
	t.Parallel()
	got := Reason(errors.New(strings.Repeat("ö", 1000)))
	if n := utf8.RuneCountInString(got); n != 300 {
		t.Errorf("rune count = %d, want 300", n)
	}
	if !utf8.ValidString(got) {
		t.Errorf("cap split a rune: %q", got)
	}

	exact := strings.Repeat("x", 300)
	if got := Reason(errors.New(exact)); got != exact {
		t.Errorf("300-rune message changed: %q", got)
	}
}

func TestReasonCapAfterRedaction(t *testing.T) {
	t.Parallel()
	// The quoted text is long, but only the placeholder counts toward the cap.
	msg := `bad "` + strings.Repeat("z", 1000) + `" tail`
	if got, want := Reason(errors.New(msg)), `bad "…" tail`; got != want {
		t.Errorf("Reason = %q, want %q", got, want)
	}
}
