package caldav

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/tbckr/lucid/internal/diag"
	"github.com/tbckr/lucid/internal/domain"
)

// maxBodySize bounds every response body read from a CalDAV server (NFR-24).
const maxBodySize = 32 << 20

// maxRedirects bounds the number of redirects followed per request.
const maxRedirects = 5

// errBodyTooLarge, errTooManyRedirects and errInvalidLocation say why a request
// failed, for errorClass. They are wrapped together with domain.ErrUpstream.
var (
	errBodyTooLarge     = errors.New("response body exceeds the size limit")
	errTooManyRedirects = errors.New("too many redirects")
	errInvalidLocation  = errors.New("invalid redirect location")
)

// XML namespaces used in requests and responses.
const (
	nsDAV    = "DAV:"
	nsCalDAV = "urn:ietf:params:xml:ns:caldav"
	nsCS     = "http://calendarserver.org/ns/"
	nsApple  = "http://apple.com/ns/ical/"
)

// statusError is a non-success HTTP status returned by the server. URL is
// pseudonymised (transport.pseudoURL): the error text reaches the logs, which
// must not carry the names of calendars (NFR-36).
type statusError struct {
	Method string
	URL    string
	Code   int
}

func (e *statusError) Error() string {
	return fmt.Sprintf("caldav: %s %s: HTTP %d", e.Method, e.URL, e.Code)
}

// statusCode returns the HTTP status of err, or 0 if err is no statusError.
func statusCode(err error) int {
	var se *statusError
	if errors.As(err, &se) {
		return se.Code
	}
	return 0
}

// mapError converts low-level errors into domain sentinel errors. Status codes
// that need operation-specific handling (403 on writes, 412) are mapped by the
// callers before falling back to this function.
func mapError(err error) error {
	if err == nil {
		return nil
	}
	switch code := statusCode(err); {
	case code == http.StatusUnauthorized:
		return fmt.Errorf("%w: %w", domain.ErrUnauthorized, err)
	case code == http.StatusForbidden:
		return fmt.Errorf("%w: %w", domain.ErrUnauthorized, err)
	case code == http.StatusNotFound || code == http.StatusGone:
		return fmt.Errorf("%w: %w", domain.ErrNotFound, err)
	case code == http.StatusPreconditionFailed:
		return fmt.Errorf("%w: %w", domain.ErrConflict, err)
	case code != 0:
		return fmt.Errorf("%w: %w", domain.ErrUpstream, err)
	}
	for _, sentinel := range []error{
		domain.ErrForbiddenTarget, domain.ErrUnauthorized, domain.ErrNotFound,
		domain.ErrConflict, domain.ErrInvalidInput, domain.ErrReadOnly,
		domain.ErrDiscovery, domain.ErrUpstream,
	} {
		if errors.Is(err, sentinel) {
			return err
		}
	}
	return fmt.Errorf("%w: %w", domain.ErrUpstream, err)
}

// transport performs authenticated WebDAV requests.
type transport struct {
	p        *Provider
	client   *http.Client // redirects are handled by transport itself
	username string
	password string
	// names are what the pseudonymiser needs to know the account's own names
	// in a path. Discovery adds the principal once it has found it.
	names diag.Names
}

func (p *Provider) newTransport(username, password string, names diag.Names) *transport {
	nc := *p.opts.HTTPClient
	// Follow redirects manually so that the method and body are preserved and
	// credentials are only forwarded where allowed.
	nc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &transport{p: p, client: &nc, username: username, password: password, names: names}
}

// pseudoPath pseudonymises the URL path path, as in url.URL.Path (NFR-36).
func (t *transport) pseudoPath(path string) string {
	return t.p.pseudo.Path(t.names, (&url.URL{Path: path}).EscapedPath())
}

// pseudoURL pseudonymises u: its origin, then its path (NFR-36).
func (t *transport) pseudoURL(u *url.URL) string {
	return t.p.pseudo.URL(t.names, u)
}

// request describes an outgoing request.
type request struct {
	method  string
	url     *url.URL
	body    []byte
	ctype   string
	headers map[string]string
	// crossOrigin allows redirects to subdomains of the original host
	// (discovery only, see checkRedirect).
	crossOrigin bool
}

// response is a fully read response.
type response struct {
	code   int
	header http.Header
	body   []byte
	url    *url.URL // final URL after redirects
}

// classRedirect is the Exchange.Error of the hop where a chain of redirects
// stops: the redirect was refused, had no usable target, or was one too many.
const classRedirect = "redirect"

// do sends req, following redirects, and returns the response. Non-2xx
// statuses are returned as *statusError together with the response. Every hop
// is recorded as an exchange (FR-36).
func (t *transport) do(ctx context.Context, req request) (*response, error) {
	u := req.url
	for hop := 0; ; hop++ {
		hr, err := t.newHTTPRequest(ctx, req, u)
		if err != nil {
			return nil, err
		}
		resp, ex, err := t.roundTrip(hr, u)
		if err != nil {
			t.record(ctx, ex)
			return nil, err
		}
		if !isRedirect(resp.code) {
			t.record(ctx, ex)
			if resp.code < 200 || resp.code > 299 {
				return resp, &statusError{Method: req.method, URL: t.pseudoURL(u), Code: resp.code}
			}
			return resp, nil
		}
		// The chain stops at this hop unless it can be followed.
		loc := resp.header.Get("Location")
		if loc == "" {
			ex.Error = classRedirect
			t.record(ctx, ex)
			return resp, &statusError{Method: req.method, URL: t.pseudoURL(u), Code: resp.code}
		}
		next, err := redirectTarget(req, u, loc, hop)
		if err != nil {
			ex.Error = classRedirect
			t.record(ctx, ex)
			return nil, err
		}
		t.record(ctx, ex)
		u = next
	}
}

// redirectTarget is where the redirect to loc, the hop-th one, from u leads, if
// it may be followed. The errors do not carry loc: it is the server's, and
// may hold the names of the user's calendars (NFR-36).
func redirectTarget(req request, u *url.URL, loc string, hop int) (*url.URL, error) {
	next, err := u.Parse(loc)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", domain.ErrUpstream, errInvalidLocation)
	}
	if err := checkRedirect(req.url, u, next, req.crossOrigin); err != nil {
		return nil, err
	}
	if hop >= maxRedirects {
		return nil, fmt.Errorf("%w: %w", domain.ErrUpstream, errTooManyRedirects)
	}
	return next, nil
}

// newHTTPRequest builds the request that sends req to u.
func (t *transport) newHTTPRequest(ctx context.Context, req request, u *url.URL) (*http.Request, error) {
	var body io.Reader
	if req.body != nil {
		body = bytes.NewReader(req.body)
	}
	hr, err := http.NewRequestWithContext(ctx, req.method, u.String(), body)
	if err != nil {
		return nil, fmt.Errorf("caldav: building request: %w", err)
	}
	hr.SetBasicAuth(t.username, t.password)
	if req.ctype != "" {
		hr.Header.Set("Content-Type", req.ctype)
	}
	for k, v := range req.headers {
		hr.Header.Set(k, v)
	}
	return hr, nil
}

// roundTrip sends hr, a request to u, without following a redirect. It returns
// the exchange it was, which the caller records (FR-36), and which says by its
// Error that the request failed.
func (t *transport) roundTrip(hr *http.Request, u *url.URL) (*response, diag.Exchange, error) {
	ex := diag.Exchange{
		At:     t.p.now(),
		Method: hr.Method,
		Host:   u.Host,
		Path:   t.p.pseudo.Path(t.names, u.EscapedPath()),
	}
	start := time.Now()
	resp, err := t.send(hr, u, &ex)
	ex.DurationMS = time.Since(start).Milliseconds()
	if err != nil {
		ex.Error = errorClass(err)
		return nil, ex, mapError(err)
	}
	resp.url = u
	return resp, ex, nil
}

// send performs hr and reads the whole response, noting in ex what came back.
func (t *transport) send(hr *http.Request, u *url.URL, ex *diag.Exchange) (*response, error) {
	resp, err := t.client.Do(hr)
	if err != nil {
		return nil, t.scrub(err, u)
	}
	defer resp.Body.Close()
	ex.Status = resp.StatusCode
	ex.ContentType = resp.Header.Get("Content-Type")
	ex.Server = resp.Header.Get("Server")
	ex.DAV = resp.Header.Get("DAV")
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBodySize+1))
	ex.Bytes = int64(len(data))
	if err != nil {
		return nil, err
	}
	if len(data) > maxBodySize {
		return nil, fmt.Errorf("%w: %w (limit %d bytes)", domain.ErrUpstream, errBodyTooLarge, maxBodySize)
	}
	return &response{code: resp.StatusCode, header: resp.Header, body: data}, nil
}

// scrub takes the names out of the error of http.Client.Do, a *url.Error that
// carries the URL of the request, which has the real path in it, and, when the
// server sent a Location the client could not parse, that value (NFR-36).
// What the error wraps stays, for errors.Is and errors.As.
func (t *transport) scrub(err error, u *url.URL) error {
	var ue *url.Error
	if !errors.As(err, &ue) {
		return err
	}
	inner := ue.Err
	if strings.HasPrefix(inner.Error(), "failed to parse Location header") { // net/http, before CheckRedirect
		inner = errInvalidLocation
	}
	return &url.Error{Op: ue.Op, URL: t.pseudoURL(u), Err: inner}
}

// record logs an exchange at debug and adds it to the diagnostics buffer of
// the request, if ctx has a scope (FR-36). The path of ex is pseudonymised and
// its error a fixed class, so neither carries calendar contents (NFR-36); the
// log never gets request or response bodies or credentials. The headers are the
// server's, so they are cut as the buffer cuts them.
func (t *transport) record(ctx context.Context, ex diag.Exchange) {
	t.p.log.DebugContext(ctx, "caldav exchange",
		"method", ex.Method,
		"host", ex.Host,
		"path", ex.Path,
		"status", ex.Status,
		"duration_ms", ex.DurationMS,
		"bytes", ex.Bytes,
		"content_type", diag.Cap(ex.ContentType, diag.MaxHeaderValue),
		"server", diag.Cap(ex.Server, diag.MaxHeaderValue),
		"dav", diag.Cap(ex.DAV, diag.MaxHeaderValue),
		"error", ex.Error,
	)
	if scope, ok := diag.ScopeFrom(ctx); ok {
		ex.RequestID = scope.RequestID
		scope.Buffer.AddExchange(ex)
	}
}

// errorClass reduces the error of a failed request to a fixed word, which
// says what kind of failure it was without the text of the error: that can
// carry the URL and what the server said (NFR-36). The classes are "dns" (the
// name did not resolve), "connect" (no connection, or it ended before the
// answer was complete: a reset, an EOF), "tls" (the certificate or the
// handshake), "timeout", "canceled" (the caller gave up), "ssrf_blocked" (the
// address is not allowed, NFR-24), "body_too_large", "redirect" (too many
// redirects, or one the client could not parse) and "other".
func errorClass(err error) string {
	var (
		dnsErr   *net.DNSError
		netErr   net.Error
		opErr    *net.OpError
		verify   *tls.CertificateVerificationError
		unknown  x509.UnknownAuthorityError
		hostname x509.HostnameError
		invalid  x509.CertificateInvalidError
		recHdr   tls.RecordHeaderError
		alert    tls.AlertError
		ech      *tls.ECHRejectionError
	)
	switch {
	case errors.Is(err, domain.ErrForbiddenTarget):
		return "ssrf_blocked"
	case errors.Is(err, errBodyTooLarge):
		return "body_too_large"
	case errors.Is(err, errTooManyRedirects), errors.Is(err, errInvalidLocation):
		return classRedirect
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, os.ErrDeadlineExceeded):
		return "timeout"
	case errors.As(err, &dnsErr):
		return "dns"
	case errors.As(err, &verify), errors.As(err, &unknown), errors.As(err, &hostname),
		errors.As(err, &invalid), errors.As(err, &recHdr), errors.As(err, &alert), errors.As(err, &ech):
		return "tls"
	case errors.As(err, &netErr) && netErr.Timeout():
		return "timeout"
	case errors.As(err, &opErr), errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, io.EOF):
		return "connect"
	}
	return "other"
}

// checkRedirect decides whether a redirect from cur to next may be followed.
// Credentials are attached to every request, so they must never reach a host
// the user did not choose: redirects stay on the original host, except during
// discovery, where the original host's subdomains are allowed too (e.g.
// example.com/.well-known/caldav -> dav.example.com), mirroring net/http's
// policy for forwarding the Authorization header. Downgrades from https to
// http are always refused.
func checkRedirect(orig, cur, next *url.URL, discovery bool) error {
	switch {
	case next.Scheme != "http" && next.Scheme != "https":
		return fmt.Errorf("%w: redirect to unsupported scheme", domain.ErrUpstream)
	case cur.Scheme == "https" && next.Scheme != "https":
		return fmt.Errorf("%w: refusing redirect from https to http", domain.ErrUpstream)
	case next.Host == orig.Host:
		return nil
	case discovery && isSubdomain(next.Hostname(), orig.Hostname()):
		return nil
	}
	return fmt.Errorf("%w: refusing redirect to another host", domain.ErrUpstream)
}

// isSubdomain reports whether sub is a subdomain of parent.
func isSubdomain(sub, parent string) bool {
	sub, parent = strings.ToLower(sub), strings.ToLower(parent)
	return parent != "" && net.ParseIP(parent) == nil && strings.HasSuffix(sub, "."+parent)
}

func isRedirect(code int) bool {
	switch code {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	}
	return false
}

// --- XML ---

// multistatus is the body of a 207 response.
type multistatus struct {
	XMLName   xml.Name     `xml:"DAV: multistatus"`
	Responses []msResponse `xml:"DAV: response"`
	SyncToken string       `xml:"DAV: sync-token"`
}

type msResponse struct {
	Hrefs     []string   `xml:"DAV: href"`
	Status    string     `xml:"DAV: status"`
	Propstats []propstat `xml:"DAV: propstat"`
}

type propstat struct {
	Prop   props  `xml:"DAV: prop"`
	Status string `xml:"DAV: status"`
}

// props contains all properties Lucid reads. Absent properties stay zero.
type props struct {
	CurrentUserPrincipal *hrefProp     `xml:"DAV: current-user-principal"`
	CalendarHomeSet      *hrefProp     `xml:"urn:ietf:params:xml:ns:caldav calendar-home-set"`
	ResourceType         *anyChildren  `xml:"DAV: resourcetype"`
	DisplayName          *string       `xml:"DAV: displayname"`
	Description          *string       `xml:"urn:ietf:params:xml:ns:caldav calendar-description"`
	Color                *string       `xml:"http://apple.com/ns/ical/ calendar-color"`
	SupportedComponents  *compSet      `xml:"urn:ietf:params:xml:ns:caldav supported-calendar-component-set"`
	PrivilegeSet         *privilegeSet `xml:"DAV: current-user-privilege-set"`
	CTag                 *string       `xml:"http://calendarserver.org/ns/ getctag"`
	SyncToken            *string       `xml:"DAV: sync-token"`
	ETag                 *string       `xml:"DAV: getetag"`
	CalendarData         *string       `xml:"urn:ietf:params:xml:ns:caldav calendar-data"`
}

type hrefProp struct {
	Href string `xml:"DAV: href"`
}

type anyChildren struct {
	Children []struct {
		XMLName xml.Name
	} `xml:",any"`
}

func (a *anyChildren) has(space, local string) bool {
	if a == nil {
		return false
	}
	for _, c := range a.Children {
		if c.XMLName.Space == space && c.XMLName.Local == local {
			return true
		}
	}
	return false
}

type compSet struct {
	Comps []compName `xml:"urn:ietf:params:xml:ns:caldav comp"`
}

type compName struct {
	Name string `xml:"name,attr"`
}

type privilegeSet struct {
	Privileges []anyChildren `xml:"DAV: privilege"`
}

// ok returns the merged properties of all propstats with a 2xx status.
func (r *msResponse) ok() props {
	var p props
	for _, ps := range r.Propstats {
		if !statusOK(ps.Status) {
			continue
		}
		mergeProps(&p, &ps.Prop)
	}
	return p
}

func mergeProps(dst, src *props) {
	dst.CurrentUserPrincipal = cmpOr(dst.CurrentUserPrincipal, src.CurrentUserPrincipal)
	dst.CalendarHomeSet = cmpOr(dst.CalendarHomeSet, src.CalendarHomeSet)
	dst.ResourceType = cmpOr(dst.ResourceType, src.ResourceType)
	dst.DisplayName = cmpOr(dst.DisplayName, src.DisplayName)
	dst.Description = cmpOr(dst.Description, src.Description)
	dst.Color = cmpOr(dst.Color, src.Color)
	dst.SupportedComponents = cmpOr(dst.SupportedComponents, src.SupportedComponents)
	dst.PrivilegeSet = cmpOr(dst.PrivilegeSet, src.PrivilegeSet)
	dst.CTag = cmpOr(dst.CTag, src.CTag)
	dst.SyncToken = cmpOr(dst.SyncToken, src.SyncToken)
	dst.ETag = cmpOr(dst.ETag, src.ETag)
	dst.CalendarData = cmpOr(dst.CalendarData, src.CalendarData)
}

func cmpOr[T any](a, b *T) *T {
	if a != nil {
		return a
	}
	return b
}

// statusOK reports whether an HTTP status line ("HTTP/1.1 200 OK") is 2xx.
// An empty status is treated as OK.
func statusOK(s string) bool {
	f := strings.Fields(s)
	if len(f) < 2 {
		return s == ""
	}
	return strings.HasPrefix(f[1], "2")
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}

// parseMultistatus decodes a multistatus body. encoding/xml never resolves
// external entities or DTDs; in strict mode unknown entities are an error.
func parseMultistatus(body []byte) (*multistatus, error) {
	var ms multistatus
	dec := xml.NewDecoder(bytes.NewReader(body))
	dec.Strict = true
	if err := dec.Decode(&ms); err != nil {
		return nil, fmt.Errorf("%w: invalid multistatus response: %w", domain.ErrUpstream, err)
	}
	return &ms, nil
}

// propfind sends a PROPFIND with the given property names and parses the
// multistatus response.
func (t *transport) propfind(ctx context.Context, u *url.URL, depth string, names []xml.Name, crossOrigin bool) (*multistatus, *response, error) {
	resp, err := t.do(ctx, request{
		method:      "PROPFIND",
		url:         u,
		body:        propfindBody(names),
		ctype:       "application/xml; charset=utf-8",
		headers:     map[string]string{"Depth": depth},
		crossOrigin: crossOrigin,
	})
	if err != nil {
		return nil, resp, err
	}
	ms, err := parseMultistatus(resp.body)
	if err != nil {
		return nil, resp, err
	}
	return ms, resp, nil
}

func propfindBody(names []xml.Name) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="utf-8"?>` +
		`<d:propfind xmlns:d="DAV:" xmlns:c="` + nsCalDAV + `" xmlns:cs="` + nsCS + `" xmlns:a="` + nsApple + `"><d:prop>`)
	prefixes := map[string]string{nsDAV: "d", nsCalDAV: "c", nsCS: "cs", nsApple: "a"}
	for _, n := range names {
		b.WriteString("<" + prefixes[n.Space] + ":" + n.Local + "/>")
	}
	b.WriteString(`</d:prop></d:propfind>`)
	return []byte(b.String())
}

// resolveHref resolves a (possibly relative) href against base. Unless
// crossOrigin is set, hrefs that point to other origins are rejected. A
// downgrade from https to http is never allowed.
func resolveHref(base *url.URL, href string, crossOrigin bool) (*url.URL, error) {
	href = strings.TrimSpace(href)
	if href == "" {
		return nil, errors.New("caldav: empty href")
	}
	u, err := base.Parse(href)
	if err != nil {
		return nil, fmt.Errorf("caldav: invalid href: %w", err)
	}
	switch {
	case u.Scheme != "http" && u.Scheme != "https":
		return nil, errors.New("caldav: href has unsupported scheme")
	case base.Scheme == "https" && u.Scheme != "https":
		return nil, errors.New("caldav: href downgrades to http")
	case !crossOrigin && (u.Host != base.Host || u.Scheme != base.Scheme):
		return nil, errors.New("caldav: href points to another origin")
	}
	u.RawQuery, u.Fragment, u.User = "", "", nil
	return u, nil
}
