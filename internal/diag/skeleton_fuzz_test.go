package diag

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// checkSkeletonShape holds for every skeleton of any input: within the cap, no
// control characters but the line breaks, no empty line.
func checkSkeletonShape(t *testing.T, sk Skeleton) {
	t.Helper()
	if len(sk.Text) > MaxSkeleton {
		t.Fatalf("Text is %d bytes, over MaxSkeleton", len(sk.Text))
	}
	for i := range len(sk.Text) {
		if c := sk.Text[i]; (c < ' ' && c != '\n') || c == 0x7f {
			t.Fatalf("control character %#x in %q", c, sk.Text)
		}
	}
	if sk.Text != "" && (strings.HasSuffix(sk.Text, "\n") || strings.Contains(sk.Text, "\n\n")) {
		t.Fatalf("empty line in %q", sk.Text)
	}
}

// longestPrefix is what a skeleton of these lines is: as many of them as fit
// in MaxSkeleton bytes, from the first on.
func longestPrefix(lines []string) Skeleton {
	var text string
	for i, line := range lines {
		next := line
		if i > 0 {
			next = text + "\n" + line
		}
		if len(next) > MaxSkeleton {
			return Skeleton{Text: text, Truncated: true}
		}
		text = next
	}
	return Skeleton{Text: text}
}

func FuzzICalSkeleton(f *testing.F) {
	for _, seed := range []string{
		"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:zz-canary\r\n zz\r\nDTSTART;TZID=Europe/Berlin:20240315T093000\r\n" +
			"RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20241231T235959Z\r\nATTENDEE;CN=\"Bob: zz\";PARTSTAT=ACCEPTED:mailto:b@zz\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
		"BEGIN:VTIMEZONE\nTZID:Europe/Berlin\nBEGIN:STANDARD\nTZOFFSETFROM:+0200\nEND:STANDARD\nEND:VTIMEZONE\n",
		"Bob: bring the files\nDiagnose;Depression=x:y\nX-Men:zz\nX-MOZ-LASTACK:zz\nBEGIN:Bob\nEND:\n",
		"\"", ";;;:", "x:\"", "\r\n \r\n\t", "BEGIN:VTIMEZONE\nBEGIN:VEVENT\nSUMMARY:zz\n",
		"DTSTART;VALUE=DATE-TIME:1\nTRIGGER;VALUE=DATE-TIME:2\nRRULE:FREQ=zz;;BYDAY=-1SU,zz;UNTIL=zz\n",
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		sk := ICalSkeleton(data)
		checkSkeletonShape(t, sk)

		var lines []string
		for line := range icalLines(data) {
			lines = append(lines, line)
			// What a line names is a name or it is masked, whatever the input.
			if line == malformedLine {
				continue
			}
			name, _, _ := strings.Cut(line, ":")
			name, _, _ = strings.Cut(name, ";")
			if name != mask && !knownName(name) {
				t.Fatalf("line %q shows %q as a name", line, name)
			}
		}
		// The text is whole lines, as many as fit.
		if want := longestPrefix(lines); sk != want {
			t.Fatalf("ICalSkeleton = {%q, %v}, want {%q, %v}", sk.Text, sk.Truncated, want.Text, want.Truncated)
		}
	})
}

var xmlLineShape = regexp.MustCompile(`^(?:# x[0-9]+=.*|<!-- parse error: .* -->|(?:  )*(?:…|(?:d|c|cs|a|s|x[0-9]+):[A-Za-z_][A-Za-z0-9._-]*)(?: .*)?)$`)

func FuzzXMLSkeleton(f *testing.F) {
	for _, seed := range []string{
		`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/calendars/alice/c/o.ics</d:href>` +
			`<d:propstat><d:prop><c:calendar-data>BEGIN:VCALENDAR zz</c:calendar-data><c:comp name="VEVENT"/></d:prop>` +
			`<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
		`<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:exception>Sabre\DAV\Exception\Forbidden</s:exception><s:message>zz</s:message></d:error>`,
		`<z:a xmlns:z="urn:zz" xmlns:y="urn:yy"><y:b y:c="d"/><z:e/></z:a>`,
		`<d:a xmlns:d="DAV:"><d:b attr=bare>text<d:c>more</d:a>`,
		`<d:displayname xmlns:d="DAV:">a <Bob Smith>b</Bob></d:displayname>`,
		"<", "<a", "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><a>\xe9</a>", "zz plain text", "<!-- zz -->",
		`<d:a xmlns:d="DAV:" xmlns="DAV:"><b c="d"/>x</d:a>tail`,
	} {
		f.Add([]byte(seed))
	}
	names := Names{Username: "alice", Principal: "/dav/principals/users/alice/", Home: "/dav/calendars/alice/"}
	p := NewPseudonymizer(testKey)
	f.Fuzz(func(t *testing.T, data []byte) {
		sk := XMLSkeleton(data, p, names)
		checkSkeletonShape(t, sk)
		for _, line := range strings.Split(sk.Text, "\n") {
			if sk.Text != "" && !xmlLineShape.MatchString(line) {
				t.Fatalf("line %q is no line of a skeleton", line)
			}
		}

		// The text is whole lines, as many as fit with the header they need.
		b := &xmlSkeleton{p: p, n: names, prefixes: map[string]string{}, declared: map[string]bool{}}
		var lines []xmlLine
		for line := range b.lines(data) {
			lines = append(lines, line)
		}
		var want Skeleton
		for k := 1; k <= len(lines); k++ {
			var text []string
			for i := range lines[k-1].namespaces {
				text = append(text, "# x"+strconv.Itoa(i+1)+"="+oneLine(b.unknown[i]))
			}
			for _, line := range lines[:k] {
				text = append(text, line.text)
			}
			if joined := strings.Join(text, "\n"); len(joined) <= MaxSkeleton {
				want = Skeleton{Text: joined}
				continue
			}
			want.Truncated = true
			break
		}
		if sk != want {
			t.Fatalf("XMLSkeleton = {%q, %v}, want {%q, %v}", sk.Text, sk.Truncated, want.Text, want.Truncated)
		}
	})
}
