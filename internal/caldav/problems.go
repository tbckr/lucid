package caldav

import (
	"bytes"
	"cmp"
	"context"
	"crypto/sha256"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/diag"
	"github.com/tbckr/lucid/internal/domain"
)

// maxLoggedProblems bounds how many recurring problems a Provider remembers
// having logged (see problem).
const maxLoggedProblems = 1024

// loggedKeySize is the size of a key of the logged problems, in bytes: 128 bits
// of SHA-256 tell problems apart as well as the problems themselves would.
const loggedKeySize = 16

// loggedKey is the key by which the Provider remembers having logged a problem
// of an object: a hash of its kind, path and reason, of a fixed size whatever
// their length, so that the 1024 problems it remembers are bounded in bytes too
// (NFR-24). The path is the server's to choose.
func loggedKey(pr diag.Problem) string {
	sum := sha256.Sum256([]byte(string(pr.Kind) + "\x00" + pr.Path + "\x00" + pr.Reason))
	return string(sum[:loggedKeySize])
}

// recentSet is a set of the strings it was most recently given, at most limit of
// them: past that the oldest is forgotten. It is safe for concurrent use.
type recentSet struct {
	mu    sync.Mutex
	set   map[string]struct{}
	order []string // the strings in the order they came; once full, a ring
	next  int      // where the next string goes once order is full
}

func newRecentSet(limit int) *recentSet {
	limit = max(limit, 1)
	return &recentSet{set: make(map[string]struct{}, limit), order: make([]string, 0, limit)}
}

// add adds key and reports whether it was new: not in the set already.
func (s *recentSet) add(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.set[key]; ok {
		return false
	}
	if len(s.order) < cap(s.order) {
		s.order = append(s.order, key)
	} else {
		delete(s.set, s.order[s.next])
		s.order[s.next] = key
		s.next = (s.next + 1) % len(s.order)
	}
	s.set[key] = struct{}{}
	return true
}

// problem adds pr to the diagnostics buffer of the request, if ctx has a scope,
// and logs it at warn (FR-36). A problem is what a CalDAV server sent that
// Lucid cannot read or evaluate, or the answer to a write it refused: pr carries
// the skeleton of the document, never the document, a pseudonymised path and a
// reason that is fixed wording, so neither the log nor the buffer gets calendar
// contents (NFR-36). The object ID is the one thing that is no pseudonym (it
// encodes the real path, encrypted), so it stays out of the log.
//
// What is logged depends on the kind. A one-off problem, an answer of the server
// or a refused write, is logged when the buffer does not hold it yet, always
// without a buffer. A problem of an object (diag.ProblemKind.Rederivable)
// comes back on every read of its calendar, in every session, so it is logged
// once by the process, by its kind, path and reason, whatever the buffer says;
// the line carries the request ID of the first read that met it.
func (t *transport) problem(ctx context.Context, pr diag.Problem) {
	if pr.At.IsZero() {
		pr.At = t.p.now()
	}
	fresh := true
	if scope, ok := diag.ScopeFrom(ctx); ok {
		pr.RequestID = scope.RequestID
		fresh = scope.Buffer.AddProblem(pr)
	}
	if pr.Kind.Rederivable() {
		fresh = t.p.logged.add(loggedKey(pr))
	}
	if !fresh {
		return
	}
	t.p.log.WarnContext(ctx, "caldav problem",
		"kind", string(pr.Kind),
		"path", diag.Cap(pr.Path, diag.MaxFieldValue),
		"reason", diag.Cap(pr.Reason, diag.MaxFieldValue),
		"skeleton", pr.Skeleton.Text,
		"truncated", pr.Skeleton.Truncated,
	)
}

// objectProblem records a problem with the calendar object at objPath, whose
// data, as far as Lucid has them, are data: their skeleton is what it shows.
// err says what went wrong, see problemReason.
func (s *service) objectProblem(ctx context.Context, kind diag.ProblemKind, objPath string, data []byte, err error) {
	s.t.problem(ctx, s.newObjectProblem(kind, objPath, data, err))
}

// newObjectProblem is the problem objectProblem records: its path
// pseudonymised, its ObjectID that of the object, for the content the user may
// add to the report on request, its reason what err says (problemReason) and
// its skeleton that of data. It is content-free as it is (NFR-36), so a cache
// entry keeps it as it is, to replay (see calEntry.unreadable).
func (s *service) newObjectProblem(kind diag.ProblemKind, objPath string, data []byte, err error) diag.Problem {
	return diag.Problem{
		Kind:     kind,
		Path:     s.t.pseudoPath(objPath),
		ObjectID: s.p.ids.encode(objPath),
		Reason:   problemReason(err),
		Skeleton: diag.ICalSkeleton(data),
	}
}

// rejectedWrite records that the server refused the PUT of data to objPath,
// with the skeleton of data, which is what Lucid sent. A create has no object
// on the server whose content could be offered, so its problem has no object
// ID (FR-36).
func (s *service) rejectedWrite(ctx context.Context, objPath string, data []byte, err error, create bool) {
	pr := s.newObjectProblem(diag.ProblemRejectedWrite, objPath, data, err)
	if create {
		pr.ObjectID = ""
	}
	s.t.problem(ctx, pr)
}

// isRejectedWrite reports whether err, of a PUT, says that the server refused
// the write in a way worth recording: an error status, except 401 (a failed
// login), 404 (an object that is gone) and 412 (the precondition that a
// concurrent change failed), none of them a problem of the server, as for
// errorResponse (FR-36).
func isRejectedWrite(err error) bool {
	code := statusCode(err)
	return code >= http.StatusBadRequest && !notAProblem(code)
}

// notAProblem reports whether an error status is one a healthy server answers:
// 401 for credentials that are wrong, 404 for an object that is gone, 412 for a
// change made since the object was read.
func notAProblem(code int) bool {
	return code == http.StatusUnauthorized || code == http.StatusNotFound || code == http.StatusPreconditionFailed
}

// errorResponse records the body of an error response as a problem, for the
// exception the server names in it (FR-36). Not every error answer is one: 401
// is a failed login, 404 an object that is gone and 412 a lost race, none of
// them the server's fault, and a body that is not XML or is empty has no
// structure to show. u is the URL asked.
func (t *transport) errorResponse(ctx context.Context, u *url.URL, resp *response) {
	if resp.code < http.StatusBadRequest || notAProblem(resp.code) || len(resp.body) == 0 || !isXMLType(resp.header.Get("Content-Type")) {
		return
	}
	t.problem(ctx, diag.Problem{
		Kind:     diag.ProblemErrorResponse,
		Path:     t.pseudoPath(u.Path),
		Reason:   "HTTP " + strconv.Itoa(resp.code),
		Skeleton: diag.XMLSkeleton(resp.body, t.p.pseudo, t.names),
	})
}

// isXMLType reports whether a Content-Type header value is an XML media type.
func isXMLType(contentType string) bool {
	mediaType, _, _ := strings.Cut(contentType, ";")
	mediaType = strings.ToLower(strings.TrimSpace(mediaType))
	return mediaType == "application/xml" || mediaType == "text/xml" || strings.HasSuffix(mediaType, "+xml")
}

// problemReason is the reason of a problem that err describes: the HTTP status
// of a refusal, else the fixed wording of a parser's error (diag.Reason). The
// text of err itself can carry values of the document, so it never goes in
// (NFR-36).
func problemReason(err error) string {
	if code := statusCode(err); code != 0 {
		return "HTTP " + strconv.Itoa(code)
	}
	return diag.Reason(err)
}

// failureReason is what a log line says of a failed request, a write or a read
// of a resource, in place of the text of its error, which can carry what the
// server sent (NFR-36): the HTTP status of a refusal, else the class of a
// transport failure (errorClass), else the fixed wording of diag.Reason. It is
// for errors of requests: the class of a parser's error, an EOF, would be wrong.
func failureReason(err error) string {
	if err == nil {
		return ""
	}
	if code := statusCode(err); code != 0 {
		return "HTTP " + strconv.Itoa(code)
	}
	if class := errorClass(err); class != "other" {
		return class
	}
	return diag.Reason(err)
}

// invalidData is the error for data a server sent that Lucid cannot read: an
// ErrUpstream that says what it was and, in the fixed wording of diag.Reason,
// what the parser objected to. It does not wrap the parser's error: its text
// can carry values of the document, and the error text reaches the logs
// (NFR-36).
func invalidData(what string, cause error) error {
	return fmt.Errorf("%w: %s: %s", domain.ErrUpstream, what, diag.Reason(cause))
}

// encodeForSkeleton writes cal, an object Lucid parsed, as iCalendar data, so
// that diag.ICalSkeleton can show its shape: a parsed object has no text of its
// own any more. It does not validate: go-ical's Encoder refuses an object that
// does not conform to RFC 5545 (no PRODID, two SUMMARYs, a quote in a
// parameter), and those are the objects with a problem. The properties come
// sorted by name, so the same object always gives the same data, as a repeated
// problem is told by its skeleton. It returns nil for no calendar.
func encodeForSkeleton(cal *ical.Calendar) []byte {
	if cal == nil || cal.Component == nil {
		return nil
	}
	var b bytes.Buffer
	writeComponent(&b, cal.Component)
	return b.Bytes()
}

// lineBreaks keeps what is written from breaking into content lines of its own.
var lineBreaks = strings.NewReplacer("\r", " ", "\n", " ")

// writeComponent writes c, its properties and its components, one content line
// each, without folding.
func writeComponent(b *bytes.Buffer, c *ical.Component) {
	name := lineBreaks.Replace(c.Name)
	b.WriteString("BEGIN:" + name + "\r\n")
	for _, key := range slices.Sorted(maps.Keys(c.Props)) {
		for i := range c.Props[key] {
			writeProp(b, key, &c.Props[key][i])
		}
	}
	for _, child := range c.Children {
		if child != nil {
			writeComponent(b, child)
		}
	}
	b.WriteString("END:" + name + "\r\n")
}

// writeProp writes p as a content line, its parameters sorted by name. key is
// the name it is stored under, for a property without a name of its own.
func writeProp(b *bytes.Buffer, key string, p *ical.Prop) {
	b.WriteString(lineBreaks.Replace(cmp.Or(p.Name, key)))
	for _, name := range slices.Sorted(maps.Keys(p.Params)) {
		values := make([]string, len(p.Params[name]))
		for i, v := range p.Params[name] {
			// A parameter value has no way to hold a quote, and one that has
			// ":", ";" or "," is quoted.
			v = lineBreaks.Replace(strings.ReplaceAll(v, `"`, "'"))
			if strings.ContainsAny(v, ":;,") {
				v = `"` + v + `"`
			}
			values[i] = v
		}
		b.WriteString(";" + lineBreaks.Replace(name) + "=" + strings.Join(values, ","))
	}
	b.WriteString(":" + lineBreaks.Replace(p.Value) + "\r\n")
}
