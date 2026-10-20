package diag

import (
	"encoding/xml"
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
		{"unknown capitals", errors.New("undefined frequency: ZZCANARY"), "undefined frequency"},
		{
			"iCalendar names are kept",
			errors.New(`ical: invalid VEVENT STATUS: "zz-canary"`),
			`ical: invalid VEVENT STATUS: "…"`,
		},
		{"hyphenated name", errors.New("ical: unexpected DATE-TIME here"), "ical: unexpected DATE-TIME here"},
		{"name with a suffix", errors.New("ical: unexpected DATE-canary here"), "ical"},
		{"name glued to letters", errors.New("ical: VEVENTzz or zzVEVENT"), "ical"},
		{"name followed by a digit", errors.New("ical: VEVENT5"), "ical"},
		{"lowercase name", errors.New("ical: vevent"), "ical: vevent"},
		{"xml line", errors.New("XML syntax error on line 5: unexpected EOF"), "XML syntax error on line 5: unexpected EOF"},
		{"xml column", errors.New("XML syntax error on column 12: unexpected EOF"), "XML syntax error on column 12: unexpected EOF"},
		{"eof", errors.New("unexpected EOF"), "unexpected EOF"},
		{"utf-8", errors.New("XML syntax error on line 2: invalid UTF-8"), "XML syntax error on line 2: invalid UTF-8"},
		{"utf-8 with a suffix", errors.New("invalid UTF-8x or UTF-9"), "…"},
		{"digits after a name", errors.New("invalid UTF-9"), "…"},
		{"first segment unknown", errors.New("ZZCANARY failed: unexpected EOF"), "…"},
		{"digits drop the segment", errors.New("timeout after 30s"), "…"},
		{"digits after a longer word", errors.New("xml: baseline 5"), "xml"},
		{"digits after lines", errors.New("xml: lines 5"), "xml"},
		{"digits after line and a word", errors.New("xml: line 5 and 6"), "xml"},
		{"digits glued to letters", errors.New("xml: line 5zz"), "xml"},
		{"line without digits", errors.New("xml: on line"), "xml: on line"},
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
		{"hyphen drops the segment", errors.New("json: after top-level value"), "json"},
		{"nothing kept", errors.New("strconv.Atoi: parsing"), "…"},
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

func TestReasonKeepsEveryName(t *testing.T) {
	t.Parallel()
	// Typed out again rather than taken from fixedNames, to catch a typo in it.
	names := strings.Fields(`EOF XML UTF UTF-8
		VCALENDAR VEVENT VTODO VJOURNAL VFREEBUSY VTIMEZONE VALARM STANDARD DAYLIGHT
		CALSCALE METHOD PRODID VERSION ATTACH CATEGORIES CLASS COMMENT DESCRIPTION GEO LOCATION PERCENT-COMPLETE
		PRIORITY RESOURCES STATUS SUMMARY COMPLETED DTEND DUE DTSTART DURATION FREEBUSY TRANSP TZID TZNAME
		TZOFFSETFROM TZOFFSETTO TZURL ATTENDEE CONTACT ORGANIZER RECURRENCE-ID RELATED-TO URL UID EXDATE RDATE RRULE
		ACTION REPEAT TRIGGER CREATED DTSTAMP LAST-MODIFIED SEQUENCE REQUEST-STATUS BEGIN END
		ALTREP CN CUTYPE DELEGATED-FROM DELEGATED-TO DIR ENCODING FMTTYPE FBTYPE LANGUAGE MEMBER PARTSTAT RANGE
		RELATED RELTYPE ROLE RSVP SENT-BY VALUE
		BINARY BOOLEAN CAL-ADDRESS DATE DATE-TIME FLOAT INTEGER PERIOD RECUR TEXT TIME URI UTC-OFFSET
		EXRULE VLOCATION VRESOURCE PARTICIPANT NAME REFRESH-INTERVAL SOURCE COLOR IMAGE CONFERENCE
		STRUCTURED-DATA STYLED-DESCRIPTION LOCATION-TYPE PARTICIPANT-TYPE RESOURCE-TYPE CALENDAR-ADDRESS
		ACKNOWLEDGED PROXIMITY DISPLAY EMAIL FEATURE LABEL SCHEDULE-AGENT SCHEDULE-FORCE-SEND SCHEDULE-STATUS`)
	for _, name := range names {
		msg := "bad " + name + " here"
		if got := Reason(errors.New(msg)); got != msg {
			t.Errorf("Reason(%q) = %q, want it unchanged", msg, got)
		}
	}
	if len(names) != len(fixedNames) {
		t.Errorf("fixedNames has %d names, the vocabulary has %d", len(fixedNames), len(names))
	}
}

func TestReasonJSONStrayQuote(t *testing.T) {
	t.Parallel()
	err := errors.New(`invalid character '"' after top-level value (field "secret")`)
	if got := Reason(err); got != "…" {
		t.Errorf("Reason(%v) = %q, want …", err, got)
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
	for name, doc := range map[string]string{
		"xml mismatched tag": "<a><" + canary + "></a>",
		"xml closing tag":    "<a></" + canary + ">",
		"xml attribute":      "<a " + canary + ">",
		"xml entity":         "<a>&" + canary + ";</a>",
		"xml unclosed":       "<a>" + canary,
		"xml number":         "<a><n>" + canary + "</n></a>",
	} {
		var v struct {
			N int `xml:"n"`
		}
		add(name, xml.Unmarshal([]byte(doc), &v))
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
