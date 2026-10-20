package diag

import (
	"encoding/xml"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strings"
	"testing"
)

var xmlTestNames = Names{
	Username:  "alice",
	Principal: "/dav/principals/users/alice/",
	Home:      "/dav/calendars/alice/",
}

// xmlText is the skeleton text of a document, for tests that care about
// nothing else.
func xmlText(t *testing.T, doc string) string {
	t.Helper()
	sk := XMLSkeleton([]byte(doc), NewPseudonymizer(testKey), xmlTestNames)
	if sk.Truncated {
		t.Fatalf("XMLSkeleton truncated %q, want it whole", sk.Text)
	}
	return sk.Text
}

func mustParse(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", raw, err)
	}
	return u
}

func TestXMLSkeletonMultistatus(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	const object = "/dav/calendars/alice/zz-canary-cal/zz-canary-obj.ics"
	doc := `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>` + object + `</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Therapy zz-canary</d:displayname>
        <c:calendar-data>BEGIN:VCALENDAR
SUMMARY:zz-canary
END:VCALENDAR</c:calendar-data>
        <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`
	got := xmlText(t, doc)
	want := strings.Join([]string{
		"d:multistatus",
		"  d:response",
		"    d:href " + p.Path(xmlTestNames, object),
		"    d:propstat",
		"      d:prop",
		"        d:displayname …",
		"        c:calendar-data …",
		"        c:supported-calendar-component-set",
		`          c:comp name="VEVENT"`,
		"      d:status HTTP/1.1 200 OK",
	}, "\n")
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
	if !strings.Contains(got, "{home}/cal-") || strings.Contains(got, "zz") || strings.Contains(got, "alice") {
		t.Errorf("skeleton leaks or lacks the pseudonymised href:\n%s", got)
	}
}

func TestXMLSkeletonSabreError(t *testing.T) {
	t.Parallel()
	got := xmlText(t, `<?xml version="1.0" encoding="utf-8"?>
<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">
  <s:sabredav-version>4.6.0</s:sabredav-version>
  <s:exception>Sabre\DAV\Exception\Forbidden</s:exception>
  <s:message>zz-canary</s:message>
</d:error>`)
	want := "d:error\n  s:sabredav-version …\n  s:exception Sabre\\DAV\\Exception\\Forbidden\n  s:message …"
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
	if strings.Contains(got, "zz") {
		t.Errorf("skeleton leaks the canary:\n%s", got)
	}
}

func TestXMLSkeletonKnownNamespaces(t *testing.T) {
	t.Parallel()
	// The prefixes are fixed, whatever the document calls them, and a default
	// namespace maps the same way.
	got := xmlText(t, `<x:a xmlns:x="DAV:" xmlns:y="urn:ietf:params:xml:ns:caldav" xmlns:z="http://calendarserver.org/ns/"
 xmlns:q="http://apple.com/ns/ical/" xmlns:r="http://sabredav.org/ns">
  <y:b/><z:c/><q:d/><r:e/>
  <f xmlns="DAV:"><g/></f>
</x:a>`)
	want := "d:a\n  c:b\n  cs:c\n  a:d\n  s:e\n  d:f\n    d:g"
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
}

func TestXMLSkeletonUnknownNamespace(t *testing.T) {
	t.Parallel()
	got := xmlText(t, `<d:prop xmlns:d="DAV:" xmlns:z="urn:zz" xmlns:o="http://owncloud.org/ns">
  <z:thing/><o:size/><z:other z:attr="x"/><o:size/>
</d:prop>`)
	want := "# x1=urn:zz\n# x2=http://owncloud.org/ns\nd:prop\n  x1:thing\n  x2:size\n  x1:other x1:attr=\"…\"\n  x2:size"
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
}

func TestXMLSkeletonMasksNamesOfNoDeclaredNamespace(t *testing.T) {
	t.Parallel()
	// A name is shown if its namespace is declared in the document. An element
	// in no namespace and a prefix that was never declared (encoding/xml leaves
	// it as the namespace) are not, and neither are their attributes.
	got := xmlText(t, `<html lang="en"><nope:b nope:c="x" d="y"/><d:c xmlns:d="DAV:" nope:e="z" f="g"><d:h/></d:c></html>`)
	want := strings.Join([]string{
		`… …="…"`,
		`  … …="…" …="…"`,
		`  d:c …="…" f="…"`,
		`    d:h`,
	}, "\n")
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
	if got := xmlText(t, `<z:a xmlns:z="urn:zz canary"><z:b/></z:a>`); got != "…\n  …" {
		t.Errorf("a namespace with a blank in it is no URI: %q", got)
	}
	// A declaration inside a text-only element is part of its text.
	got = xmlText(t, `<d:a xmlns:d="DAV:"><d:displayname><q:x xmlns:q="urn:q"/></d:displayname><q:y/></d:a>`)
	if want := "d:a\n  d:displayname\n    …\n  …"; got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
}

func TestXMLSkeletonHeaderListsTheNamespacesOfTheLinesKept(t *testing.T) {
	t.Parallel()
	// The last line that fits ends the text, and a namespace that only the line
	// after it uses is not listed.
	name := strings.Repeat("c", MaxSkeleton-len("d:a\n  d:"))
	sk := XMLSkeleton([]byte(`<d:a xmlns:d="DAV:" xmlns:z="urn:z"><d:`+name+`/><z:b/></d:a>`), NewPseudonymizer(testKey), xmlTestNames)
	if sk.Text != "d:a\n  d:"+name || !sk.Truncated {
		t.Errorf("XMLSkeleton = {%d bytes %q, %v}, want the two lines and Truncated, no header", len(sk.Text), sk.Text[:min(len(sk.Text), 30)], sk.Truncated)
	}
	// And the header takes its bytes from the lines: with it, this one is the
	// line that no longer fits.
	sk = XMLSkeleton([]byte(`<z:a xmlns:z="urn:z"><z:`+name+`/></z:a>`), NewPseudonymizer(testKey), xmlTestNames)
	if want := "# x1=urn:z\nx1:a"; sk.Text != want || !sk.Truncated {
		t.Errorf("XMLSkeleton = {%q, %v}, want {%q, true}", sk.Text[:min(len(sk.Text), 30)], sk.Truncated, want)
	}
}

func TestXMLSkeletonAttributes(t *testing.T) {
	t.Parallel()
	got := xmlText(t, `<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:" version="zz-canary" empty="">
  <d:prop><c:supported-calendar-component-set><c:comp name="VCALENDAR"><c:comp name="VEVENT"/><c:prop name="UID"/></c:comp></c:supported-calendar-component-set></d:prop>
  <c:time-range start="20240101T000000Z" end="20240201T000000Z"/>
  <c:comp name="X-VENDOR-THING"/>
  <d:other name="VEVENT"/>
  <c:comp name="V zz-canary"/>
  <c:comp name="zz:canary"/>
</c:calendar-query>`)
	want := strings.Join([]string{
		`c:calendar-query version="…" empty=""`,
		"  d:prop",
		"    c:supported-calendar-component-set",
		`      c:comp name="VCALENDAR"`,
		`        c:comp name="VEVENT"`,
		`        c:prop name="…"`,
		`  c:time-range start="…" end="…"`,
		// The name of a component is kept when it is shaped like one.
		`  c:comp name="X-VENDOR-THING"`,
		`  d:other name="…"`,
		`  c:comp name="…"`,
		`  c:comp name="…"`,
	}, "\n")
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
	if strings.Contains(got, "zz") {
		t.Errorf("skeleton leaks the canary:\n%s", got)
	}
}

func TestXMLSkeletonText(t *testing.T) {
	t.Parallel()
	got := xmlText(t, `<d:a xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:b>zz-canary</d:b>
  <d:c><![CDATA[zz-canary]]></d:c>
  <d:d>&amp;zz-canary&#x41;</d:d>
  <d:e>   </d:e>
  <d:f/>
  <d:g><d:h/>zz-canary tail</d:g>
  <d:i>head zz-canary<d:j/></d:i>
  <!-- zz-canary -->
  <?pi zz-canary?>
  <d:k>a<!-- zz-canary -->b</d:k>
</d:a>`)
	want := strings.Join([]string{
		"d:a",
		"  d:b …",
		"  d:c …",
		"  d:d …",
		"  d:e",
		"  d:f",
		"  d:g",
		"    d:h",
		"    …",
		"  d:i …",
		"    …", // text came first: the element after it is the text's
		"  d:k …",
	}, "\n")
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
	if strings.Contains(got, "zz") {
		t.Errorf("skeleton leaks the canary:\n%s", got)
	}
	// Text outside any element is text too.
	if got := xmlText(t, "Service zz-canary unavailable"); got != "…" {
		t.Errorf("XMLSkeleton(plain text) = %q, want …", got)
	}
}

func TestXMLSkeletonHref(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	tests := []struct {
		name, href, want string
	}{
		{"home", "/dav/calendars/alice/", "{home}/"},
		{"object", "/dav/calendars/alice/cal/obj.ics", p.Path(xmlTestNames, "/dav/calendars/alice/cal/obj.ics")},
		{"principal", "/dav/principals/users/alice/", "{principal}/"},
		{"object outside both", "/other/zz-canary.ics", "/seg-" + p.hash("other") + "/obj-" + p.hash("zz-canary.ics") + ".ics"},
		{"behind a prefix", "/nextcloud/dav/calendars/alice/c/o.ics", "/nextcloud/" + p.Path(xmlTestNames, "/dav/calendars/alice/c/o.ics")},
		{"user name outside", "/other/alice/x", "/seg-" + p.hash("other") + "/{user}/seg-" + p.hash("x")},
		{"escaped", "/dav/calendars/alice/zz%20canary/", p.Path(xmlTestNames, "/dav/calendars/alice/zz%20canary/")},
		{"whitespace around", " \n /dav/calendars/alice/c/ \n ", p.Path(xmlTestNames, "/dav/calendars/alice/c/")},
		{
			"absolute URL", "https://alice:pw@dav.example/dav/calendars/alice/c/?token=zz-canary#zz-canary",
			p.URL(xmlTestNames, mustParse(t, "https://dav.example/dav/calendars/alice/c/")),
		},
		{"mail address", "mailto:alice@zz-canary.example", "…"},
		{"relative reference", "calendars/alice/zz-canary/", "…"},
		{"network path reference", "//zz-canary.example/x", "…"},
		{"invalid escape", "/dav/calendars/alice/%zz-canary", "…"},
		{"not a URL", "zz canary: x", "…"},
		{"too long", "/dav/" + strings.Repeat("a", 2*MaxSkeleton), "…"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := xmlText(t, `<d:href xmlns:d="DAV:">`+tc.href+`</d:href>`)
			if want := "d:href " + tc.want; got != want {
				t.Errorf("href %q: skeleton %q, want %q", tc.href, got, want)
			}
			if strings.Contains(got, "zz-canary") || strings.Contains(got, "alice:") {
				t.Errorf("href %q: skeleton %q leaks", tc.href, got)
			}
		})
	}
	// Without a pseudonymiser an href is masked, never passed through.
	sk := XMLSkeleton([]byte(`<d:href xmlns:d="DAV:">/dav/calendars/alice/zz-canary/</d:href>`), nil, xmlTestNames)
	if sk.Text != "d:href …" {
		t.Errorf("XMLSkeleton without a Pseudonymizer = %q, want d:href …", sk.Text)
	}
}

func TestXMLSkeletonVerbatimText(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, doc, want string
	}{
		{"status", `<d:status xmlns:d="DAV:"> HTTP/1.1 404 Not Found </d:status>`, "d:status HTTP/1.1 404 Not Found"},
		{"status without phrase", `<d:status xmlns:d="DAV:">HTTP/1.1 207</d:status>`, "d:status HTTP/1.1 207"},
		{"status that is text", `<d:status xmlns:d="DAV:">HTTP/1.1 200 zz-canary</d:status>`, "d:status HTTP/1.1 200 …"},
		{"status that is no status", `<d:status xmlns:d="DAV:">zz-canary</d:status>`, "d:status …"},
		{"status with more than a phrase", `<d:status xmlns:d="DAV:">HTTP/1.1 200 OK zz-canary: 1</d:status>`, "d:status HTTP/1.1 200 …"},
		{"exception", `<s:exception xmlns:s="http://sabredav.org/ns">OCA\DAV\Connector\Sabre\Exception\Forbidden</s:exception>`, `s:exception OCA\DAV\Connector\Sabre\Exception\Forbidden`},
		{"exception that is text", `<s:exception xmlns:s="http://sabredav.org/ns">Mr. zz-canary says no</s:exception>`, "s:exception …"},
		{"status of another namespace", `<x:status xmlns:x="urn:zz">HTTP/1.1 200 OK</x:status>`, "# x1=urn:zz\nx1:status …"},
		{"exception of another namespace", `<d:exception xmlns:d="DAV:">Sabre\DAV\Exception\Forbidden</d:exception>`, "d:exception …"},
		{"status with children", `<d:status xmlns:d="DAV:">HTTP/1.1 200 OK<d:x/></d:status>`, "d:status HTTP/1.1 200 OK\n  …"},
		{"too long", `<s:exception xmlns:s="http://sabredav.org/ns">` + strings.Repeat("A", 2*MaxSkeleton) + `</s:exception>`, "s:exception …"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := xmlText(t, tc.doc); got != tc.want {
				t.Errorf("skeleton:\n%s\nwant:\n%s", got, tc.want)
			}
		})
	}
}

func TestXMLSkeletonBroken(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, doc, want string
	}{
		{
			"truncated",
			`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/calendars/alice/</d:href><d:prop><d:displayname>zz-canary`,
			"d:multistatus\n  d:response\n    d:href {home}/\n    d:prop\n      d:displayname …\n<!-- parse error: XML syntax error on line 1: unexpected EOF -->",
		},
		{
			"attribute never closes",
			`<d:a xmlns:d="DAV:"><d:b zz="zz-canary`,
			"d:a\n<!-- parse error: XML syntax error on line 1: unexpected EOF -->",
		},
		{
			"error that quotes the content",
			"<d:a xmlns:d=\"DAV:\">\n<d:b>zz-canary</>\n</d:a>",
			"d:a\n  d:b …\n<!-- parse error: XML syntax error on line 2 -->",
		},
		{
			"illegal character",
			"<d:a xmlns:d=\"DAV:\"><d:b>zz-canary\x01</d:b></d:a>",
			"d:a\n  d:b\n<!-- parse error: XML syntax error on line 1 -->",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			sk := XMLSkeleton([]byte(tc.doc), NewPseudonymizer(testKey), xmlTestNames)
			if strings.Contains(sk.Text, "zz") {
				t.Errorf("skeleton leaks the canary:\n%s", sk.Text)
			}
			if !strings.Contains(sk.Text, "<!-- parse error: ") || !strings.HasSuffix(sk.Text, " -->") {
				t.Errorf("skeleton lacks the parse error note:\n%s", sk.Text)
			}
			if sk.Text != tc.want {
				t.Errorf("skeleton:\n%s\nwant:\n%s", sk.Text, tc.want)
			}
		})
	}
}

func TestXMLSkeletonNoteOnly(t *testing.T) {
	t.Parallel()
	// A document with nothing readable still says where it broke.
	sk := XMLSkeleton([]byte("<"), NewPseudonymizer(testKey), xmlTestNames)
	if !strings.HasPrefix(sk.Text, "<!-- parse error: ") || sk.Truncated {
		t.Errorf("XMLSkeleton(\"<\") = %+v, want only a parse error note", sk)
	}
}

func TestXMLSkeletonOtherCharset(t *testing.T) {
	t.Parallel()
	// A declared charset the decoder has no reader for must not hide the
	// structure.
	got := xmlText(t, "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><d:a xmlns:d=\"DAV:\"><d:b>cafe</d:b></d:a>")
	if want := "d:a\n  d:b …"; got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
	// Bytes that are not UTF-8 are an error all the same, after what came before.
	sk := XMLSkeleton([]byte("<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><d:a xmlns:d=\"DAV:\"><d:b>caf\xe9</d:b></d:a>"), NewPseudonymizer(testKey), xmlTestNames)
	if !strings.HasPrefix(sk.Text, "d:a\n  d:b\n<!-- parse error: ") {
		t.Errorf("skeleton:\n%s", sk.Text)
	}
}

func TestXMLSkeletonEmpty(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	for name, doc := range map[string]string{"nil": "", "blank": " \r\n\t ", "prolog only": `<?xml version="1.0"?>`, "comment only": "<!-- zz-canary -->"} {
		if got := XMLSkeleton([]byte(doc), p, xmlTestNames); got != (Skeleton{}) {
			t.Errorf("%s: XMLSkeleton = %+v, want the zero Skeleton", name, got)
		}
	}
	if got := XMLSkeleton(nil, p, xmlTestNames); got != (Skeleton{}) {
		t.Errorf("XMLSkeleton(nil) = %+v, want the zero Skeleton", got)
	}
}

func TestXMLSkeletonOneLinePerElement(t *testing.T) {
	t.Parallel()
	// A namespace with a control character in it does not break the line
	// structure of the header.
	got := xmlText(t, "<z:a xmlns:z=\"urn:z\x7f\"><z:b/><z:c/></z:a>")
	want := "# x1=urn:z?\nx1:a\n  x1:b\n  x1:c"
	if got != want {
		t.Errorf("skeleton:\n%q\nwant:\n%q", got, want)
	}
	// An element name that is no name is masked.
	got = xmlText(t, `<d:a xmlns:d="DAV:"><d:é/><d:b-c.d/></d:a>`)
	if want := "d:a\n  …\n  d:b-c.d"; got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
}

func TestXMLSkeletonCap(t *testing.T) {
	t.Parallel()
	var b strings.Builder
	b.WriteString(`<d:multistatus xmlns:d="DAV:" xmlns:z="urn:zz">`)
	for b.Len() < 1<<20 {
		b.WriteString(`<d:response><d:href>/dav/calendars/alice/zz-canary/zz-canary.ics</d:href><z:x z:a="zz-canary">zz-canary</z:x></d:response>`)
	}
	b.WriteString(`</d:multistatus>`)

	sk := XMLSkeleton([]byte(b.String()), NewPseudonymizer(testKey), xmlTestNames)
	if !sk.Truncated {
		t.Error("Truncated = false, want true")
	}
	if len(sk.Text) > MaxSkeleton || len(sk.Text) < MaxSkeleton-100 {
		t.Errorf("len(Text) = %d, want at most %d and at most a line short", len(sk.Text), MaxSkeleton)
	}
	if strings.Contains(sk.Text, "zz-canary") {
		t.Error("skeleton leaks the canary")
	}
	// The cut lies on a line boundary: every line is whole.
	whole := regexp.MustCompile(`^(# x1=urn:zz|d:multistatus|  d:response|    d:href \{home\}/cal-[0-9a-f]{8}/obj-[0-9a-f]{8}\.ics|    x1:x x1:a="…" …)$`)
	for _, line := range strings.Split(sk.Text, "\n") {
		if !whole.MatchString(line) {
			t.Fatalf("line %q is not whole", line)
		}
	}
}

func TestXMLSkeletonCapBoundary(t *testing.T) {
	t.Parallel()
	// The namespace header counts towards the cap: a skeleton of exactly
	// MaxSkeleton bytes is whole, and one byte more drops the last line.
	const base = "# x1=urn:z\nx1:a\n  x1:b …"
	doc := func(nameLen int) []byte {
		return []byte(`<z:a xmlns:z="urn:z"><z:b>t</z:b><z:` + strings.Repeat("c", nameLen) + `/></z:a>`)
	}
	nameLen := MaxSkeleton - len(base+"\n  x1:")
	sk := XMLSkeleton(doc(nameLen), NewPseudonymizer(testKey), xmlTestNames)
	if len(sk.Text) != MaxSkeleton || sk.Truncated {
		t.Errorf("exact fit: len = %d, Truncated = %v, want %d, false", len(sk.Text), sk.Truncated, MaxSkeleton)
	}
	sk = XMLSkeleton(doc(nameLen+1), NewPseudonymizer(testKey), xmlTestNames)
	if sk.Text != base || !sk.Truncated {
		t.Errorf("one byte over: %q, Truncated = %v, want %q, true", sk.Text, sk.Truncated, base)
	}
}

func TestXMLSkeletonDeepNesting(t *testing.T) {
	t.Parallel()
	doc := `<d:a xmlns:d="DAV:">` + strings.Repeat("<d:a>", 1<<18)
	sk := XMLSkeleton([]byte(doc), NewPseudonymizer(testKey), xmlTestNames)
	if !sk.Truncated || len(sk.Text) > MaxSkeleton {
		t.Errorf("deep nesting: len = %d, Truncated = %v", len(sk.Text), sk.Truncated)
	}
}

func TestXMLSkeletonManyAttributes(t *testing.T) {
	t.Parallel()
	var b strings.Builder
	b.WriteString(`<d:a xmlns:d="DAV:"`)
	for i := 0; b.Len() < 1<<20; i++ {
		b.WriteString(` x` + strings.Repeat("y", i%7) + `="zz-canary"`)
	}
	b.WriteString("/>")
	sk := XMLSkeleton([]byte(b.String()), NewPseudonymizer(testKey), xmlTestNames)
	if sk.Text != "" || !sk.Truncated {
		t.Errorf("element line over the cap: %d bytes, Truncated = %v, want nothing and Truncated", len(sk.Text), sk.Truncated)
	}
}

func TestXMLSkeletonCapAtTheNote(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	// The element that is cut off by the break does not fit: no note either,
	// the skeleton is truncated and ends before it.
	sk := XMLSkeleton([]byte(`<d:a xmlns:d="DAV:"><d:`+strings.Repeat("b", 2*MaxSkeleton)+">"), p, xmlTestNames)
	if sk.Text != "d:a" || !sk.Truncated {
		t.Errorf("XMLSkeleton = {%d bytes, %v}, want d:a and Truncated", len(sk.Text), sk.Truncated)
	}
	// It fits, and the note after it does not.
	name := strings.Repeat("b", MaxSkeleton-len("d:a\n  d:"))
	sk = XMLSkeleton([]byte(`<d:a xmlns:d="DAV:"><d:`+name+">"), p, xmlTestNames)
	if sk.Text != "d:a\n  d:"+name || !sk.Truncated {
		t.Errorf("XMLSkeleton = {%d bytes, %v}, want the element and Truncated, without the note", len(sk.Text), sk.Truncated)
	}
}

func TestXMLSkeletonHeaderTooLong(t *testing.T) {
	t.Parallel()
	// The header is part of the text, and when it alone is over the cap the
	// elements after it are not shown either.
	sk := XMLSkeleton([]byte(`<z:a xmlns:z="`+strings.Repeat("n", 2*MaxSkeleton)+`"/>`), NewPseudonymizer(testKey), xmlTestNames)
	if sk.Text != "" || !sk.Truncated {
		t.Errorf("XMLSkeleton = {%d bytes, %v}, want nothing and Truncated", len(sk.Text), sk.Truncated)
	}
}

func TestXMLSkeletonTextOnlyElements(t *testing.T) {
	t.Parallel()
	const root = `<d:root xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" ` +
		`xmlns:a="http://apple.com/ns/ical/" xmlns:s="http://sabredav.org/ns">`
	// What an unescaped "<Bob Smith>" in the text of these elements parses as.
	const inner = `Meet <Bob Smith zz="zz-canary">bring the files</Bob>`
	for _, name := range []string{
		"c:calendar-data", "d:displayname", "c:calendar-description", "c:calendar-timezone", "a:calendar-color",
		"s:message", "d:href", "d:status", "d:getetag", "cs:getctag", "d:sync-token", "d:responsedescription",
		"s:exception",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			got := xmlText(t, root+"<"+name+">"+inner+"</"+name+"></d:root>")
			// The element is shown, the elements in its text are not.
			lines := strings.Split(got, "\n")
			if len(lines) < 3 || lines[0] != "d:root" || !strings.HasPrefix(lines[1], "  "+name) {
				t.Fatalf("skeleton:\n%s", got)
			}
			for _, line := range lines[2:] {
				if !strings.HasPrefix(line, "    …") {
					t.Errorf("line %q below %s is not masked", line, name)
				}
			}
			for _, leak := range []string{"Bob", "Smith", "zz", "canary", "bring"} {
				if strings.Contains(got, leak) {
					t.Errorf("skeleton leaks %q:\n%s", leak, got)
				}
			}
		})
	}

	// The same markup in an element that is not text-only, without text before
	// it, is structure, and when the default namespace is declared its names are
	// in it.
	got := xmlText(t, `<d:prop xmlns:d="DAV:" xmlns="DAV:"><Bob Smith zz="zz-canary">bring the files</Bob></d:prop>`)
	if want := "d:prop\n  d:Bob Smith=\"…\" zz=\"…\" …"; got != want {
		t.Errorf("control: skeleton:\n%s\nwant:\n%s", got, want)
	}
	// And inside a text-only one it is not, with or without the default namespace.
	for _, doc := range []string{
		`<c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav">` + inner + `</c:calendar-data>`,
		`<c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns="DAV:">` + inner + `</c:calendar-data>`,
	} {
		got := xmlText(t, doc)
		if want := "c:calendar-data …\n  … …=\"…\" …=\"…\" …"; got != want {
			t.Errorf("skeleton of %q:\n%s\nwant:\n%s", doc, got, want)
		}
	}
}

func TestXMLSkeletonDecodesLeniently(t *testing.T) {
	t.Parallel()
	// Neither the missing end tags nor the bare attribute value are well-formed.
	const doc = `<d:a xmlns:d="DAV:"><d:b attr=bare><d:c>more</d:a>`
	dec := xml.NewDecoder(strings.NewReader(doc))
	var strictErr error
	for strictErr == nil {
		_, strictErr = dec.Token()
	}
	if errors.Is(strictErr, io.EOF) {
		t.Fatal("the input is well-formed: it does not test the lenient decoding")
	}

	got := xmlText(t, doc)
	want := "d:a\n  d:b attr=\"…\"\n    d:c …"
	if got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
}

func TestXMLSkeletonStatusPhrase(t *testing.T) {
	t.Parallel()
	tests := []struct{ status, want string }{
		{"HTTP/1.1 200 OK", "HTTP/1.1 200 OK"},
		{"HTTP/1.1 207 Multi-Status", "HTTP/1.1 207 Multi-Status"},
		{"HTTP/1.1 404 Not Found", "HTTP/1.1 404 Not Found"},
		{"HTTP/1.1 424 Failed Dependency", "HTTP/1.1 424 Failed Dependency"},
		{"HTTP/1.1 418 I'm a teapot", "HTTP/1.1 418 I'm a teapot"}, // RFC 9110 names come from net/http
		{"HTTP/1.0 200 OK", "HTTP/1.0 200 OK"},
		{"HTTP/1.1 200", "HTTP/1.1 200"},
		// The phrase of another code, another case, or none that exists.
		{"HTTP/1.1 200 Not Found", "HTTP/1.1 200 …"},
		{"HTTP/1.1 200 ok", "HTTP/1.1 200 …"},
		{"HTTP/1.1 200 OK ", "HTTP/1.1 200 OK"}, // the text is trimmed
		{"HTTP/1.1 999 Whatever", "HTTP/1.1 999 …"},
		{"HTTP/1.1 200 zz-canary", "HTTP/1.1 200 …"},
		{"HTTP/1.1 200 OK zz-canary: 1", "HTTP/1.1 200 …"},
		{"HTTP/1.1 200  OK", "HTTP/1.1 200 …"},
		// Not a status.
		{"HTTP/1.1 20 OK", "…"},
		{"HTTP/2 200 OK", "…"},
		{"zz-canary", "…"},
	}
	for _, tc := range tests {
		got := xmlText(t, `<d:status xmlns:d="DAV:">`+tc.status+`</d:status>`)
		if want := "d:status " + tc.want; got != want {
			t.Errorf("status %q: skeleton %q, want %q", tc.status, got, want)
		}
	}
}

func TestXMLSkeletonHrefBehindAPrefix(t *testing.T) {
	t.Parallel()
	// The probe of the review: the server sits below /nextcloud, so the home is
	// not a prefix of the href.
	names := Names{Username: "alice", Home: "/remote.php/dav/calendars/alice/"}
	const href = "/nextcloud/remote.php/dav/calendars/alice/therapy/6f1c-uid-0042.ics"
	sk := XMLSkeleton([]byte(`<d:href xmlns:d="DAV:">`+href+`</d:href>`), NewPseudonymizer(testKey), names)
	if !regexp.MustCompile(`^d:href /nextcloud/\{home\}/cal-[0-9a-f]{8}/obj-[0-9a-f]{8}\.ics$`).MatchString(sk.Text) {
		t.Errorf("skeleton = %q, want d:href /nextcloud/{home}/cal-<h>/obj-<h>.ics", sk.Text)
	}
	for _, leak := range []string{"therapy", "6f1c", "0042", "alice"} {
		if strings.Contains(sk.Text, leak) {
			t.Errorf("skeleton %q leaks %q", sk.Text, leak)
		}
	}
}

func TestXMLSkeletonMixedContent(t *testing.T) {
	t.Parallel()
	// A well-formed WebDAV response has no element after text in the same
	// element: what is there is somebody's text with markup in it, and its
	// names are masked, however deep and whatever namespace is the default.
	got := xmlText(t, `<d:prop xmlns:d="DAV:" xmlns="DAV:"><owner-displayname>Dr. <Smith-Therapy/></owner-displayname></d:prop>`)
	if want := "d:prop\n  d:owner-displayname …\n    …"; got != want {
		t.Errorf("skeleton:\n%s\nwant:\n%s", got, want)
	}
	if strings.Contains(got, "Smith") {
		t.Errorf("skeleton leaks the name:\n%s", got)
	}

	tests := []struct{ name, doc, want string }{
		{
			"children before the text are structure",
			`<d:a xmlns:d="DAV:"><d:b/><d:c/>text</d:a>`,
			"d:a\n  d:b\n  d:c\n  …",
		},
		{
			"the second child after text, and what is nested in a masked one",
			`<d:a xmlns:d="DAV:">text<d:b><d:c d:e="f"/></d:b>more<d:g/></d:a>`,
			"d:a …\n  …\n    … …=\"…\"\n  …\n  …",
		},
		{
			"a sibling of the element with text is structure",
			`<d:a xmlns:d="DAV:"><d:b>text</d:b><d:c/></d:a>`,
			"d:a\n  d:b …\n  d:c",
		},
		{
			"text only in a comment or white space is none",
			"<d:a xmlns:d=\"DAV:\">\n <!-- zz -->\n <d:b/></d:a>",
			"d:a\n  d:b",
		},
	}
	for _, tc := range tests {
		got := xmlText(t, tc.doc)
		if got != tc.want {
			t.Errorf("%s: skeleton:\n%s\nwant:\n%s", tc.name, got, tc.want)
		}
	}
}
