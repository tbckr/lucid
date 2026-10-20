package diag

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"iter"
	"net/http"
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

// textOnly are the elements whose content is text: a name or a value, a
// calendar object. A document that is not well-formed inside one (an
// unescaped "<Bob Smith>" in the text of a calendar-data) shows elements that
// are text, so what is nested in them is masked, names included.
var textOnly = map[string]bool{
	"c:calendar-data": true, "d:displayname": true, "c:calendar-description": true,
	"c:calendar-timezone": true, "a:calendar-color": true, "s:message": true, "d:href": true,
	"d:status": true, "d:getetag": true, "cs:getctag": true, "d:sync-token": true,
	"d:responsedescription": true, "s:exception": true,
}

var (
	// xmlName is what the local name of an element or attribute has to look
	// like to be shown; anything else is masked.
	xmlName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9._-]*$`)
	// statusLine splits a DAV:status into protocol, code and reason phrase.
	statusLine = regexp.MustCompile(`^(HTTP/\d\.\d) (\d{3})(?: (.*))?$`)
	// exceptionClass is a Sabre exception: a PHP class name.
	exceptionClass = regexp.MustCompile(`^[A-Za-z0-9_\\]{1,200}$`)
)

// XMLSkeleton returns the shape of a WebDAV/CalDAV XML document: one line per
// element, indented two spaces per level of depth, with the element's
// attributes after its name. The element's text follows as "…" and is shown
// only where it is a fixed word or a path: d:status (the code, and the reason
// phrase if it is the standard one), d:href (a path through p, see
// Pseudonymizer.Path, an absolute http(s) URL through Pseudonymizer.URL; any
// other href is masked) and s:exception (a Sabre class name).
//
// An element or attribute name is shown only if its namespace was declared in
// the document, and not inside a text-only element (textOnly) or after text in
// the same element (mixed content); otherwise it is "…". An attribute without a prefix has the namespace of its element. A
// namespace gets a fixed prefix: d (DAV:), c (CalDAV), cs (calendarserver.org),
// a (apple.com/ns/ical), s (sabredav.org/ns); any other is x1, x2 and so on,
// listed in front as "# x1=<namespace>", for the lines shown only. Attribute
// values are masked, except name on c:comp, if it is a component name.
// Comments, processing instructions and namespace declarations are left out.
//
// A document that cannot be decoded gives its elements up to the break and a
// final line "<!-- parse error: <Reason> -->". The text is cut on a line
// boundary at MaxSkeleton bytes. It decodes leniently (Strict = false): the
// point is to see as much of the structure as possible.
func XMLSkeleton(data []byte, p *Pseudonymizer, n Names) Skeleton {
	b := &xmlSkeleton{p: p, n: n, prefixes: map[string]string{}, declared: map[string]bool{}}
	var out capped
	shown := 0 // namespaces the lines kept so far have in the header
	for line := range b.lines(data) {
		var header []string
		for i := shown; i < line.namespaces; i++ {
			header = append(header, "# x"+strconv.Itoa(i+1)+"="+oneLine(b.unknown[i]))
		}
		if !out.add(line.text, header...) {
			break
		}
		shown = line.namespaces
	}
	return out.skeleton()
}

// xmlLine is a line of an XML skeleton, and how many of the unknown namespaces
// it and the lines before it use: the first of them, x1 to x<namespaces>.
type xmlLine struct {
	text       string
	namespaces int
}

// xmlSkeleton is the state of one XMLSkeleton run.
type xmlSkeleton struct {
	p *Pseudonymizer
	n Names

	declared map[string]bool   // the namespaces the document declares
	prefixes map[string]string // namespace to prefix, for the unknown ones
	unknown  []string          // those namespaces, in the order of their prefixes
	frames   []xmlFrame        // the open elements
	pending  *xmlElement       // the last element started, its line not yet written
	yield    func(xmlLine) bool
	stopped  bool // the consumer wants no more lines
}

// xmlFrame is an open element, for what is nested in it.
type xmlFrame struct {
	masked bool // what is nested in it has masked names
	text   bool // it has had text, and elements in mixed content are text too
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

// lines decodes data and yields the lines of the skeleton, whole, in order,
// until the document ends or the consumer stops.
func (b *xmlSkeleton) lines(data []byte) iter.Seq[xmlLine] {
	return func(yield func(xmlLine) bool) {
		b.yield = yield
		dec := xml.NewDecoder(bytes.NewReader(data))
		dec.Strict = false
		// A declared charset must not hide the structure; text that is not UTF-8
		// is an error of its own.
		dec.CharsetReader = func(_ string, in io.Reader) (io.Reader, error) { return in, nil }

		for !b.stopped {
			tok, err := dec.Token()
			if err != nil {
				b.flush()
				if !errors.Is(err, io.EOF) {
					b.emit("<!-- parse error: " + Reason(err) + " -->")
				}
				return
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
	}
}

// emit hands a line to the consumer.
func (b *xmlSkeleton) emit(text string) {
	if !b.stopped && !b.yield(xmlLine{text: oneLine(text), namespaces: len(b.unknown)}) {
		b.stopped = true
	}
}

func (b *xmlSkeleton) start(t xml.StartElement) {
	b.flush()
	// Text-only elements and mixed content: a well-formed WebDAV response has no
	// element after text in the same element, so what is there is the text's.
	masked := len(b.frames) > 0 && (b.frames[len(b.frames)-1].masked || b.frames[len(b.frames)-1].text)
	if !masked {
		b.declare(t.Attr)
	}
	name := b.elementName(t.Name, masked)
	head := name
	for _, a := range t.Attr {
		if isNamespaceDecl(a.Name) {
			continue // a declaration: the prefixes are fixed
		}
		head += " " + b.attrName(a.Name, t.Name.Space, masked) + `="` + attrValue(name, a) + `"`
		if len(head) > MaxSkeleton {
			break // the line cannot fit, and more of it is of no use
		}
	}
	b.pending = &xmlElement{
		name:    name,
		head:    head,
		depth:   len(b.frames),
		special: name == "d:href" || name == "d:status" || name == "s:exception",
	}
	b.frames = append(b.frames, xmlFrame{masked: masked || textOnly[name]})
}

func (b *xmlSkeleton) end() {
	b.flush()
	if len(b.frames) > 0 {
		b.frames = b.frames[:len(b.frames)-1]
	}
}

func (b *xmlSkeleton) text(t xml.CharData) {
	if len(bytes.TrimSpace(t)) == 0 {
		return
	}
	if len(b.frames) > 0 {
		b.frames[len(b.frames)-1].text = true
	}
	e := b.pending
	if e == nil { // text after a child, or outside any element
		b.emit(strings.Repeat("  ", len(b.frames)) + mask)
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
	b.emit(line)
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
// the standard one of the code.
func status(text string) string {
	m := statusLine.FindStringSubmatch(text)
	if m == nil {
		return mask
	}
	line := m[1] + " " + m[2]
	switch code, _ := strconv.Atoi(m[2]); {
	case m[3] == "":
		return line
	case m[3] == http.StatusText(code):
		return line + " " + m[3]
	}
	return line + " " + mask
}

// attrValue shows the value of an attribute of the element called elem.
func attrValue(elem string, a xml.Attr) string {
	switch {
	case a.Value == "":
		return ""
	case elem == "c:comp" && a.Name.Space == "" && a.Name.Local == "name" && knownName(a.Value):
		return a.Value
	}
	return mask
}

// isNamespaceDecl reports whether an attribute name is that of an xmlns
// declaration.
func isNamespaceDecl(name xml.Name) bool {
	return name.Space == "xmlns" || (name.Space == "" && name.Local == "xmlns")
}

// declare records the namespaces an element declares. A namespace with
// whitespace in it is no URI and is not one the document declares.
func (b *xmlSkeleton) declare(attrs []xml.Attr) {
	for _, a := range attrs {
		if isNamespaceDecl(a.Name) && a.Value != "" && !strings.ContainsAny(a.Value, " \t\r\n") {
			b.declared[a.Value] = true
		}
	}
}

// shown reports whether a name is one to show: in a namespace the document
// declared (encoding/xml leaves a prefix that is not declared as the
// namespace), and shaped like a name.
func (b *xmlSkeleton) shown(space, local string) bool {
	return b.declared[space] && xmlName.MatchString(local)
}

// elementName writes the name of an element with its fixed prefix, or masks it.
func (b *xmlSkeleton) elementName(name xml.Name, masked bool) string {
	if masked || !b.shown(name.Space, name.Local) {
		return mask
	}
	return b.prefix(name.Space) + ":" + name.Local
}

// attrName writes the name of an attribute, or masks it. An attribute without a
// prefix belongs to the namespace of its element, and is written without one.
func (b *xmlSkeleton) attrName(name xml.Name, elementSpace string, masked bool) string {
	space := name.Space
	if space == "" {
		space = elementSpace
	}
	switch {
	case masked || !b.shown(space, name.Local):
		return mask
	case name.Space == "":
		return name.Local
	}
	return b.prefix(name.Space) + ":" + name.Local
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
