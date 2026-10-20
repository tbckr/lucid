package diag

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// knownNamespaces are the namespaces a CalDAV exchange is made of, by the
// fixed prefix a skeleton writes them with, whatever the document calls them.
var knownNamespaces = map[string]string{
	"DAV:":                          "d",
	"urn:ietf:params:xml:ns:caldav": "c",
	"http://calendarserver.org/ns/": "cs",
	"http://apple.com/ns/ical/":     "a",
	"http://sabredav.org/ns":        "s",
}

var (
	// xmlName is what an element or attribute name has to look like to be
	// shown; anything else is masked.
	xmlName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9._-]*$`)
	// statusLine splits a DAV:status into its protocol and code and the reason
	// phrase.
	statusLine = regexp.MustCompile(`^(HTTP/\d\.\d \d{3})(?: (.*))?$`)
	// exceptionClass is a Sabre exception: a PHP class name.
	exceptionClass = regexp.MustCompile(`^[A-Za-z0-9_\\]{1,200}$`)
)

// reasonPhrases are the reason phrases of the HTTP status codes, lower-cased.
// A phrase is shown when it is one of them.
var reasonPhrases = func() map[string]bool {
	phrases := map[string]bool{}
	for _, phrase := range []string{
		"OK", "Created", "Accepted", "No Content", "Multi-Status",
		"Moved Permanently", "Found", "See Other", "Not Modified", "Temporary Redirect", "Permanent Redirect",
		"Bad Request", "Unauthorized", "Forbidden", "Not Found", "Method Not Allowed", "Not Acceptable",
		"Request Timeout", "Conflict", "Gone", "Length Required", "Precondition Failed",
		"Payload Too Large", "Request Entity Too Large", "URI Too Long", "Unsupported Media Type",
		"Unprocessable Entity", "Locked", "Failed Dependency", "Too Many Requests",
		"Internal Server Error", "Not Implemented", "Bad Gateway", "Service Unavailable", "Gateway Timeout",
		"Insufficient Storage",
	} {
		phrases[strings.ToLower(phrase)] = true
	}
	return phrases
}()

// XMLSkeleton returns the shape of a WebDAV/CalDAV XML document: one line per
// element, indented two spaces per level of depth, with the element's
// attributes after its name. The element's text follows as "…" and is shown
// only where it is a fixed word or a path: d:status (the code, and the reason
// phrase if it is a standard one), d:href (a path through p, see
// Pseudonymizer.Path, an absolute http(s) URL through Pseudonymizer.URL; any
// other href is masked) and s:exception (a Sabre class name).
//
// Namespaces get fixed prefixes: d (DAV:), c (CalDAV), cs (calendarserver.org),
// a (apple.com/ns/ical), s (sabredav.org/ns). Any other is x1, x2 and so on,
// listed in front as "# x1=<namespace>". Attribute names stay and their values
// are masked, except name on c:comp. Comments, processing instructions and
// namespace declarations are left out.
//
// A document that cannot be decoded gives its elements up to the break and a
// final line "<!-- parse error: <Reason> -->". The text is cut on a line
// boundary at MaxSkeleton bytes. It decodes leniently (Strict = false): the
// point is to see as much of the structure as possible.
func XMLSkeleton(data []byte, p *Pseudonymizer, n Names) Skeleton {
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = false
	// A declared charset must not hide the structure; text that is not UTF-8 is
	// an error of its own.
	dec.CharsetReader = func(_ string, in io.Reader) (io.Reader, error) { return in, nil }

	b := &xmlSkeleton{p: p, n: n, prefixes: map[string]string{}}
	for !b.full {
		tok, err := dec.Token()
		if err != nil {
			b.flush()
			if !errors.Is(err, io.EOF) {
				b.add("<!-- parse error: " + Reason(err) + " -->")
			}
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			b.start(t)
		case xml.EndElement:
			b.end()
		case xml.CharData:
			b.text(t)
		}
	}
	return b.skeleton()
}

// xmlSkeleton is the state of one XMLSkeleton run.
type xmlSkeleton struct {
	p *Pseudonymizer
	n Names

	prefixes map[string]string // namespace to prefix, for the unknown ones
	unknown  []string          // those namespaces, in the order of their prefixes
	body     []string          // the lines, without the namespace header
	size     int               // what body takes as text
	depth    int               // elements open
	pending  *xmlElement       // the last element started, its line not yet written
	full     bool              // a line did not fit: nothing more is read
}

// xmlElement is an element whose line waits for its text.
type xmlElement struct {
	name     string
	head     string // name and attributes
	depth    int
	special  bool   // text is kept as it is, see render
	text     []byte // of a special one, up to MaxSkeleton bytes
	hasText  bool
	overflow bool
}

func (b *xmlSkeleton) start(t xml.StartElement) {
	b.flush()
	name := b.qualify(t.Name)
	head := name
	for _, a := range t.Attr {
		if a.Name.Space == "xmlns" || (a.Name.Space == "" && a.Name.Local == "xmlns") {
			continue // a declaration: the prefixes are fixed
		}
		head += " " + b.qualify(a.Name) + `="` + attrValue(name, a) + `"`
		if len(head) > MaxSkeleton {
			b.full = true // the line can never fit, and neither can any after it
			return
		}
	}
	b.pending = &xmlElement{
		name:    name,
		head:    head,
		depth:   b.depth,
		special: name == "d:href" || name == "d:status" || name == "s:exception",
	}
	b.depth++
}

func (b *xmlSkeleton) end() {
	b.flush()
	if b.depth > 0 {
		b.depth--
	}
}

func (b *xmlSkeleton) text(t xml.CharData) {
	if len(bytes.TrimSpace(t)) == 0 {
		return
	}
	e := b.pending
	if e == nil { // text after a child, or outside any element
		b.add(strings.Repeat("  ", b.depth) + mask)
		return
	}
	e.hasText = true
	if !e.special {
		return
	}
	if len(e.text)+len(t) > MaxSkeleton {
		e.overflow = true
		return
	}
	e.text = append(e.text, t...)
}

// flush writes the line of the pending element.
func (b *xmlSkeleton) flush() {
	e := b.pending
	if e == nil {
		return
	}
	b.pending = nil
	line := strings.Repeat("  ", e.depth) + e.head
	if e.hasText {
		line += " " + b.render(e)
	}
	b.add(line)
}

// render shows the text of an element.
func (b *xmlSkeleton) render(e *xmlElement) string {
	if !e.special || e.overflow {
		return mask
	}
	text := strings.TrimSpace(string(e.text))
	switch e.name {
	case "d:href":
		return b.href(text)
	case "d:status":
		return status(text)
	}
	if exceptionClass.MatchString(text) { // s:exception
		return text
	}
	return mask
}

// href shows an href: a path through the Pseudonymizer, an absolute http(s) URL
// the same way. A relative reference or another scheme (mailto: addresses sit
// in hrefs of principals) is masked, as is everything when there is no
// Pseudonymizer to say what the names in the path are.
func (b *xmlSkeleton) href(text string) string {
	if b.p == nil {
		return mask
	}
	u, err := url.Parse(text)
	if err != nil {
		return mask
	}
	switch {
	case strings.HasPrefix(text, "/") && !strings.HasPrefix(text, "//"):
		return b.p.Path(b.n, u.EscapedPath())
	case (u.Scheme == "http" || u.Scheme == "https") && u.Host != "":
		return b.p.URL(b.n, u)
	}
	return mask
}

// status shows a DAV:status: protocol and code, and the reason phrase if it is
// a standard one.
func status(text string) string {
	m := statusLine.FindStringSubmatch(text)
	switch {
	case m == nil:
		return mask
	case m[2] == "":
		return m[1]
	case reasonPhrases[strings.ToLower(m[2])]:
		return m[1] + " " + m[2]
	}
	return m[1] + " " + mask
}

// attrValue shows the value of an attribute of the element called elem.
func attrValue(elem string, a xml.Attr) string {
	switch {
	case a.Value == "":
		return ""
	case elem == "c:comp" && a.Name.Space == "" && a.Name.Local == "name" && isToken(a.Value):
		return a.Value
	}
	return mask
}

// qualify writes a name with its fixed prefix.
func (b *xmlSkeleton) qualify(name xml.Name) string {
	local := name.Local
	if !xmlName.MatchString(local) {
		local = mask
	}
	if name.Space == "" {
		return local
	}
	return b.prefix(name.Space) + ":" + local
}

// prefix returns the prefix of a namespace, giving an unknown one the next x<n>.
func (b *xmlSkeleton) prefix(namespace string) string {
	if p, ok := knownNamespaces[namespace]; ok {
		return p
	}
	if p, ok := b.prefixes[namespace]; ok {
		return p
	}
	p := "x" + strconv.Itoa(len(b.unknown)+1)
	b.prefixes[namespace] = p
	b.unknown = append(b.unknown, namespace)
	return p
}

// add takes a line of the body if it fits, and stops the run if it does not.
func (b *xmlSkeleton) add(line string) {
	if b.full {
		return
	}
	line = oneLine(line)
	need := len(line)
	if len(b.body) > 0 {
		need++
	}
	if b.size+need > MaxSkeleton {
		b.full = true
		return
	}
	b.body = append(b.body, line)
	b.size += need
}

// skeleton puts the namespace header and the body together. The header counts
// towards the cap, so the body can be cut once more here.
func (b *xmlSkeleton) skeleton() Skeleton {
	lines := make([]string, 0, len(b.unknown)+len(b.body))
	for i, namespace := range b.unknown {
		lines = append(lines, "# x"+strconv.Itoa(i+1)+"="+oneLine(namespace))
	}
	lines = append(lines, b.body...)

	var out capped
	for _, line := range lines {
		if !out.add(line) {
			break
		}
	}
	out.truncated = out.truncated || b.full
	return out.skeleton()
}
