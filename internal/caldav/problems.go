package caldav

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/diag"
	"github.com/tbckr/lucid/internal/domain"
)

// problem logs pr at warn and adds it to the diagnostics buffer of the request,
// if ctx has a scope (FR-36). A problem is what a CalDAV server sent that Lucid
// cannot read or evaluate, or the answer to a write it refused: pr carries the
// skeleton of the document, never the document, a pseudonymised path and a
// reason that is fixed wording, so neither the log nor the buffer gets calendar
// contents (NFR-36). The object ID is the one thing that is no pseudonym (it
// encodes the real path, encrypted), so it stays out of the log.
func (t *transport) problem(ctx context.Context, pr diag.Problem) {
	if pr.At.IsZero() {
		pr.At = t.p.now()
	}
	t.p.log.WarnContext(ctx, "caldav problem",
		"kind", string(pr.Kind),
		"path", diag.Cap(pr.Path, diag.MaxFieldValue),
		"reason", diag.Cap(pr.Reason, diag.MaxFieldValue),
		"skeleton", pr.Skeleton.Text,
		"truncated", pr.Skeleton.Truncated,
	)
	if scope, ok := diag.ScopeFrom(ctx); ok {
		pr.RequestID = scope.RequestID
		scope.Buffer.AddProblem(pr)
	}
}

// objectProblem records a problem with the calendar object at objPath, whose
// data, as far as Lucid has them, are data: their skeleton is what it shows.
// err says what went wrong, see problemReason.
func (s *service) objectProblem(ctx context.Context, kind diag.ProblemKind, objPath string, data []byte, err error) {
	s.t.problem(ctx, s.newObjectProblem(kind, objPath, data, err))
}

// newObjectProblem is the problem objectProblem records. Its ObjectID is that
// of objPath, for the content the user may add to the report on request.
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
// the write in a way worth recording: an error status, except 412, the
// precondition that a concurrent change failed, which is no problem of the
// server (FR-36).
func isRejectedWrite(err error) bool {
	code := statusCode(err)
	return code >= http.StatusBadRequest && code != http.StatusPreconditionFailed
}

// errorResponse records the body of an error response as a problem, for the
// exception the server names in it (FR-36). Not every error answer is one: 401
// is a failed login, 404 an object that is gone and 412 a lost race, none of
// them the server's fault, and a body that is not XML or is empty has no
// structure to show. u is the URL asked.
func (t *transport) errorResponse(ctx context.Context, u *url.URL, resp *response) {
	switch resp.code {
	case http.StatusUnauthorized, http.StatusNotFound, http.StatusPreconditionFailed:
		return
	}
	if resp.code < http.StatusBadRequest || len(resp.body) == 0 || !isXMLType(resp.header.Get("Content-Type")) {
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

// encodeForSkeleton encodes cal, an object Lucid parsed, as iCalendar data, so
// that diag.ICalSkeleton can show its shape: a parsed object has no text of its
// own any more. It returns nil if cal does not encode.
func encodeForSkeleton(cal *ical.Calendar) []byte {
	var buf bytes.Buffer
	if err := ical.NewEncoder(&buf).Encode(cal); err != nil {
		return nil
	}
	return buf.Bytes()
}
