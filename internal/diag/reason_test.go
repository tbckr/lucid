package diag

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/emersion/go-ical"
	"github.com/teambition/rrule-go"
)

func TestReason(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"nil", nil, ""},
		{"fixed wording", errors.New("ical: malformed content line: missing colon"), "ical: malformed content line: missing colon"},
		{
			"unquoted value after the type",
			errors.New(`ical: cannot process: ("DATE-TIME") 2024zz-canary`),
			"ical: cannot process",
		},
		{
			"unquoted value after the last colon",
			errors.New("ical: error parsing recurrence: undefined frequency: ZZCANARY"),
			"ical: error parsing recurrence: undefined frequency",
		},
		{
			"capitals drop the segment",
			errors.New(`ical: invalid VEVENT STATUS: "zz-canary"`),
			"ical",
		},
		{"quoted value", errors.New(`bad value "zz-canary"`), `bad value "…"`},
		{"escaped quote", errors.New(`bad value "a\"b" here`), `bad value "…" here`},
		{"several", errors.New(`got "x" want "y"`), `got "…" want "…"`},
		{"escaped backslash at the end", errors.New(`path "C:\\"`), `path "…"`},
		{"wrapped", fmt.Errorf("parse: %w", errors.New(`bad "secret"`)), `parse: bad "…"`},
		{
			"rune literal",
			errors.New(`ical: malformed text: invalid escape sequence '\Z'`),
			"ical: malformed text: invalid escape sequence '…'",
		},
		{
			"quote as a rune literal does not pair with a later quote",
			errors.New(`json: invalid character '"' after the value: "secret"`),
			`json: invalid character '…' after the value: "…"`,
		},
		{"stray quote ends the wording", errors.New(`ical: bad " here: secret`), "ical"},
		{"lowercase wording", errors.New("context deadline exceeded"), "context deadline exceeded"},
		{"digits drop the segment", errors.New("timeout after 30s"), ""},
		{"hyphen drops the segment", errors.New("json: after top-level value"), "json"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := Reason(tc.err); got != tc.want {
				t.Errorf("Reason(%v) = %q, want %q", tc.err, got, tc.want)
			}
		})
	}
}

func TestReasonJSONStrayQuote(t *testing.T) {
	t.Parallel()
	err := errors.New(`invalid character '"' after top-level value (field "secret")`)
	if got := Reason(err); strings.Contains(got, "secret") {
		t.Errorf("Reason(%v) = %q leaks the field name", err, got)
	}
}

func TestReasonCap(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("abcdefghij", 100)
	got := Reason(errors.New(long))
	if n := utf8.RuneCountInString(got); n != 300 || got != long[:300] {
		t.Errorf("rune count = %d, want the first 300 runes", n)
	}

	exact := strings.Repeat("x", 300)
	if got := Reason(errors.New(exact)); got != exact {
		t.Errorf("300-rune message changed: %q", got)
	}
}

func TestReasonCapCountsRunes(t *testing.T) {
	t.Parallel()
	// Masked text is multi-byte: a cap by bytes would cut it, one by runes keeps 300.
	got := Reason(errors.New(strings.Repeat(`a "x" `, 100)))
	if n := utf8.RuneCountInString(got); n != 300 {
		t.Errorf("rune count = %d, want 300", n)
	}
	if !utf8.ValidString(got) {
		t.Errorf("cap split a rune: %q", got)
	}
}

func TestReasonCapAfterMasking(t *testing.T) {
	t.Parallel()
	// The quoted text is long, but only the placeholder counts toward the cap.
	msg := `bad "` + strings.Repeat("z", 1000) + `" tail`
	if got, want := Reason(errors.New(msg)), `bad "…" tail`; got != want {
		t.Errorf("Reason = %q, want %q", got, want)
	}
}

// parserErrors returns real errors from go-ical and rrule-go for input that
// carries canary where a calendar's content would be.
func parserErrors(canary string) map[string]error {
	errs := map[string]error{}
	add := func(name string, err error) { errs[name] = err }

	prop := func(name, value string, params ...string) *ical.Prop {
		p := ical.NewProp(name)
		p.Value = value
		for i := 0; i+1 < len(params); i += 2 {
			p.Params.Set(params[i], params[i+1])
		}
		return p
	}
	_, err := prop(ical.PropDateTimeStart, canary).DateTime(nil)
	add("ical DateTime without type", err)
	_, err = prop(ical.PropDateTimeStart, "20240101T000000", ical.PropTimezoneID, canary).DateTime(nil)
	add("ical DateTime with TZID", err)
	_, err = prop(ical.PropDateTimeStart, canary, ical.ParamValue, string(ical.ValueDateTime)).DateTime(nil)
	add("ical DateTime with type", err)
	_, err = prop(ical.PropDateTimeStart, canary, ical.ParamValue, string(ical.ValueDate)).DateTime(nil)
	add("ical Date", err)
	_, err = prop(ical.PropDuration, canary, ical.ParamValue, string(ical.ValueDuration)).Duration()
	add("ical Duration", err)
	_, err = prop("X-FLAG", canary, ical.ParamValue, string(ical.ValueBool)).Bool()
	add("ical Bool", err)
	_, err = prop("X-FLAG", "TRUE", ical.ParamValue, canary).Bool()
	add("ical value type", err)
	_, err = prop(ical.PropSummary, `\`+canary).Text()
	add("ical Text escape", err)
	_, err = prop(ical.PropURL, canary, ical.ParamValue, canary).URI()
	add("ical URI", err)

	ev := ical.NewEvent()
	ev.Props.SetText(ical.PropStatus, canary)
	_, err = ev.Status()
	add("ical Status", err)

	ev = ical.NewEvent()
	ev.Props.Set(prop(ical.PropRecurrenceRule, "FREQ="+canary))
	_, err = ev.RecurrenceSet(time.UTC)
	add("ical RecurrenceSet", err)
	_, err = ev.Props.RecurrenceRule()
	add("ical RecurrenceRule", err)

	for name, doc := range map[string]string{
		"ical END":      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:" + canary + "\r\nEND:VCALENDAR\r\n",
		"ical toplevel": "BEGIN:" + canary + "\r\nEND:" + canary + "\r\n",
		"ical no colon": "BEGIN:VCALENDAR\r\n" + canary + "\r\nEND:VCALENDAR\r\n",
		"ical param":    "BEGIN:VCALENDAR\r\nX;" + canary + ":v\r\nEND:VCALENDAR\r\n",
	} {
		_, err := ical.NewDecoder(strings.NewReader(doc)).Decode()
		add(name, err)
	}

	for name, rule := range map[string]string{
		"rrule FREQ":            "FREQ=" + canary,
		"rrule other part":      "FREQ=DAILY;BYDAY=" + canary,
		"rrule unknown part":    "FREQ=DAILY;" + canary + "=1",
		"rrule no value":        "FREQ=DAILY;" + canary + "=",
		"rrule COUNT":           "FREQ=DAILY;COUNT=" + canary,
		"rrule UNTIL":           "FREQ=DAILY;UNTIL=" + canary,
		"rrule BYMONTH":         "FREQ=DAILY;BYMONTH=" + canary,
		"rrule WKST":            "FREQ=DAILY;WKST=" + canary,
		"rrule DTSTART":         "DTSTART:" + canary + "\nRRULE:FREQ=DAILY",
		"rrule first line name": canary + ";X=1\nRRULE:FREQ=DAILY",
	} {
		_, err := rrule.StrToRRule(rule)
		add(name, err)
	}
	_, err = rrule.StrToRRuleSet(canary)
	add("rrule set", err)
	_, err = rrule.StrToRRuleSet("RRULE:FREQ=DAILY\nEXDATE:" + canary)
	add("rrule EXDATE", err)
	return errs
}

func TestReasonOfParserErrors(t *testing.T) {
	t.Parallel()
	for _, canary := range []string{"ZZ-canary-123", "ZZCANARY"} {
		for name, err := range parserErrors(canary) {
			t.Run(name+"/"+canary, func(t *testing.T) {
				t.Parallel()
				if err == nil {
					t.Fatal("the parser accepted the input, so the case tests nothing")
				}
				got := Reason(err)
				if strings.Contains(strings.ToLower(got), strings.ToLower(canary)) {
					t.Errorf("Reason(%q) = %q leaks %q", err.Error(), got, canary)
				}
			})
		}
	}
}
