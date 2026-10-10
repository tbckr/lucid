package caldav

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

var (
	propGetCTag      = xml.Name{Space: nsCS, Local: "getctag"}
	propSyncToken    = xml.Name{Space: nsDAV, Local: "sync-token"}
	propGetETag      = xml.Name{Space: nsDAV, Local: "getetag"}
	propPrivilegeSet = xml.Name{Space: nsDAV, Local: "current-user-privilege-set"}
)

// service implements domain.CalendarService for one account.
type service struct {
	p        *Provider
	acct     domain.Account
	t        *transport
	home     *url.URL
	homePath string
	err      error // non-nil if the account is unusable
}

var _ domain.CalendarService = (*service)(nil)

// Service implements domain.Provider. It is cheap: all shared state lives in
// the Provider.
func (p *Provider) Service(acct domain.Account) domain.CalendarService {
	s := &service{p: p, acct: acct, t: newTransport(p.opts.HTTPClient, acct.Username, acct.Password)}
	home, err := url.Parse(acct.CalendarHomeURL)
	if err != nil || (home.Scheme != "http" && home.Scheme != "https") || home.Host == "" {
		s.err = fmt.Errorf("%w: invalid calendar home URL in account", domain.ErrUpstream)
		return s
	}
	home.RawQuery, home.Fragment, home.User = "", "", nil
	if !strings.HasSuffix(home.Path, "/") {
		home.Path += "/"
	}
	home.RawPath = ""
	s.home, s.homePath = home, home.Path
	return s
}

// urlFor returns the absolute URL of a path on the calendar home's origin.
func (s *service) urlFor(p string) *url.URL {
	u := *s.home
	u.Path, u.RawPath = p, ""
	return &u
}

// --- object cache ---

// calObject is one calendar object resource.
type calObject struct {
	path string
	etag string
	cal  *ical.Calendar // treated as immutable once cached
}

// calEntry is the cached object set of one calendar and component type.
type calEntry struct {
	ctag      string
	syncToken string
	objects   []calObject
	checked   atomic.Int64 // unix nanoseconds of the last validation
}

// identity returns the account the service is bound to: the origin of its
// calendar home and its username.
func (s *service) identity() string {
	return s.home.Scheme + "://" + s.home.Host + "\x00" + s.acct.Username
}

func (s *service) cacheKey(calPath, comp string) string {
	// Endpoint (origin of the home set) + username + path: no cross-user or
	// cross-server leakage.
	return strings.Join([]string{s.identity(), calPath, comp}, "\x00")
}

func (s *service) invalidate(calPath string) {
	s.p.cache.Remove(s.cacheKey(calPath, ical.CompEvent))
	s.p.cache.Remove(s.cacheKey(calPath, ical.CompToDo))
}

// objects returns all objects of the given component type in calPath, using
// the cache when it is fresh or its CTag/sync-token is unchanged. A ctx from
// domain.WithRevalidation skips the freshness window (FR-23).
func (s *service) objects(ctx context.Context, calPath, comp string) ([]calObject, error) {
	key := s.cacheKey(calPath, comp)
	now := s.p.now()
	entry, cached := s.p.cache.Get(key)
	if cached && !domain.Revalidation(ctx) && now.Sub(time.Unix(0, entry.checked.Load())) < s.p.opts.CacheFreshness {
		s.p.metrics.hits.Inc()
		return entry.objects, nil
	}

	ctag, token, err := s.collectionTags(ctx, calPath)
	if err != nil {
		s.p.metrics.errors.Inc()
		return nil, err
	}
	if cached && ((ctag != "" && ctag == entry.ctag) || (ctag == "" && token != "" && token == entry.syncToken)) {
		entry.checked.Store(now.UnixNano())
		s.p.metrics.hits.Inc()
		return entry.objects, nil
	}

	s.p.metrics.misses.Inc()
	objs, err := s.query(ctx, calPath, comp)
	if err != nil {
		s.p.metrics.errors.Inc()
		return nil, err
	}
	e := &calEntry{ctag: ctag, syncToken: token, objects: objs}
	e.checked.Store(now.UnixNano())
	s.p.cache.Add(key, e)
	return objs, nil
}

// collectionTags returns the CTag and sync-token of a calendar ("" if the
// server does not provide them).
func (s *service) collectionTags(ctx context.Context, calPath string) (ctag, token string, err error) {
	ms, _, err := s.t.propfind(ctx, s.urlFor(calPath), "0", []xml.Name{propGetCTag, propSyncToken, propResourceType}, false)
	if err != nil {
		return "", "", mapError(err)
	}
	if len(ms.Responses) == 0 {
		return "", "", nil
	}
	pr := ms.Responses[0].ok()
	if pr.ResourceType != nil && !pr.ResourceType.has(nsCalDAV, "calendar") {
		return "", "", fmt.Errorf("%w: not a calendar", domain.ErrNotFound)
	}
	return str(pr.CTag), str(pr.SyncToken), nil
}

// query fetches all objects of the component type via calendar-query.
func (s *service) query(ctx context.Context, calPath, comp string) ([]calObject, error) {
	body := `<?xml version="1.0" encoding="utf-8"?>` +
		`<c:calendar-query xmlns:d="DAV:" xmlns:c="` + nsCalDAV + `">` +
		`<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
		`<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="` + comp + `"/></c:comp-filter></c:filter>` +
		`</c:calendar-query>`
	resp, err := s.t.do(ctx, request{
		method:  "REPORT",
		url:     s.urlFor(calPath),
		body:    []byte(body),
		ctype:   "application/xml; charset=utf-8",
		headers: map[string]string{"Depth": "1"},
	})
	if err != nil {
		return nil, mapError(err)
	}
	ms, err := parseMultistatus(resp.body)
	if err != nil {
		return nil, err
	}
	objs := make([]calObject, 0, len(ms.Responses))
	for _, r := range ms.Responses {
		if len(r.Hrefs) == 0 || (r.Status != "" && !statusOK(r.Status)) {
			continue
		}
		u, err := resolveHref(s.home, r.Hrefs[0], false)
		if err != nil || !strings.HasPrefix(u.Path, calPath) || len(u.Path) == len(calPath) {
			continue
		}
		pr := r.ok()
		data := str(pr.CalendarData)
		if data == "" {
			continue
		}
		cal, err := ical.NewDecoder(strings.NewReader(data)).Decode()
		if err != nil {
			s.p.log.WarnContext(ctx, "skipping unparsable calendar object", "path", u.Path, "error", err)
			continue
		}
		objs = append(objs, calObject{path: u.Path, etag: str(pr.ETag), cal: cal})
	}
	return objs, nil
}

// --- writes ---

// checkWritable verifies that calPath is a calendar the user may write to.
// A non-empty comp must also be in its supported component set, so a new
// object of the wrong type fails with a clear error instead of an upstream 403.
// Updates pass "" so objects already stored in the calendar stay editable.
func (s *service) checkWritable(ctx context.Context, calPath, comp string) error {
	ms, _, err := s.t.propfind(ctx, s.urlFor(calPath), "0", []xml.Name{propResourceType, propPrivilegeSet, propSupportedComp}, false)
	if err != nil {
		return mapError(err)
	}
	if len(ms.Responses) == 0 {
		return nil
	}
	pr := ms.Responses[0].ok()
	if pr.ResourceType != nil && !pr.ResourceType.has(nsCalDAV, "calendar") {
		return fmt.Errorf("%w: not a calendar", domain.ErrNotFound)
	}
	if !canWrite(pr.PrivilegeSet) {
		return domain.ErrReadOnly
	}
	if comp != "" && !supportsComp(pr.SupportedComponents, comp) {
		return fmt.Errorf("%w: %s", domain.ErrUnsupportedComponent, comp)
	}
	return nil
}

// canWrite reports whether a privilege set allows writing. A missing set is
// treated as writable (best effort).
func canWrite(ps *privilegeSet) bool {
	if ps == nil {
		return true
	}
	for _, p := range ps.Privileges {
		for _, name := range []string{"all", "write", "write-content", "bind"} {
			if p.has(nsDAV, name) {
				return true
			}
		}
	}
	return false
}

// getObject fetches and parses one object. It also returns the object's data
// as read, raw.
func (s *service) getObject(ctx context.Context, objPath string) (cal *ical.Calendar, etag string, raw []byte, err error) {
	resp, err := s.t.do(ctx, request{method: http.MethodGet, url: s.urlFor(objPath)})
	if err != nil {
		return nil, "", nil, mapError(err)
	}
	cal, err = ical.NewDecoder(bytes.NewReader(resp.body)).Decode()
	if err != nil {
		return nil, "", nil, fmt.Errorf("%w: invalid iCalendar data: %w", domain.ErrUpstream, err)
	}
	return cal, resp.header.Get("ETag"), resp.body, nil
}

// putObject encodes cal and stores it at objPath, see putBytes.
func (s *service) putObject(ctx context.Context, objPath string, cal *ical.Calendar, ifMatch string, create bool) (string, error) {
	var buf bytes.Buffer
	if err := ical.NewEncoder(&buf).Encode(cal); err != nil {
		return "", fmt.Errorf("%w: encoding iCalendar: %w", domain.ErrInvalidInput, err)
	}
	return s.putBytes(ctx, objPath, buf.Bytes(), ifMatch, create)
}

// putBytes stores the iCalendar data at objPath as it is and returns the
// object's new ETag, "" if the server tells none: a weak one counts as none,
// like a weak one from the PUT response itself, and so does a failure to
// read it back (A-01) — the PUT already succeeded by then, so that failure
// must not be reported as a failed write. Exactly one of ifMatch / create
// must be used: create sends If-None-Match: *.
func (s *service) putBytes(ctx context.Context, objPath string, data []byte, ifMatch string, create bool) (string, error) {
	headers := map[string]string{}
	if create {
		headers["If-None-Match"] = "*"
	} else {
		headers["If-Match"] = ifMatch
	}
	resp, err := s.t.do(ctx, request{
		method:  http.MethodPut,
		url:     s.urlFor(objPath),
		body:    data,
		ctype:   "text/calendar; charset=utf-8",
		headers: headers,
	})
	if err != nil {
		return "", mapWriteError(err)
	}
	if etag := resp.header.Get("ETag"); etag != "" && !strings.HasPrefix(etag, "W/") {
		return etag, nil
	}
	// The server may have modified the data and therefore omitted the ETag,
	// or sent a weak one: read it back.
	etag, err := s.objectETag(ctx, objPath)
	if err != nil {
		// The PUT itself already succeeded: a failure here only leaves the
		// new ETag unknown, not the write undone (A-01).
		s.p.log.WarnContext(ctx, "could not read back the etag of a write", "path", objPath, "error", err)
		return "", nil
	}
	if strings.HasPrefix(etag, "W/") {
		return "", nil
	}
	return etag, nil
}

// objectETag reads the ETag of the object at objPath, "" if the server tells
// none.
func (s *service) objectETag(ctx context.Context, objPath string) (string, error) {
	ms, _, err := s.t.propfind(ctx, s.urlFor(objPath), "0", []xml.Name{propGetETag}, false)
	if err != nil {
		return "", mapError(err)
	}
	for _, r := range ms.Responses {
		if etag := str(r.ok().ETag); etag != "" {
			return etag, nil
		}
	}
	return "", nil
}

func (s *service) deleteObject(ctx context.Context, objPath, etag string) error {
	_, err := s.t.do(ctx, request{
		method:  http.MethodDelete,
		url:     s.urlFor(objPath),
		headers: map[string]string{"If-Match": etag},
	})
	return mapWriteError(err)
}

// mapWriteError maps errors of PUT/DELETE requests.
func mapWriteError(err error) error {
	switch statusCode(err) {
	case http.StatusForbidden:
		return fmt.Errorf("%w: %w", domain.ErrReadOnly, err)
	case http.StatusPreconditionFailed, http.StatusConflict:
		return fmt.Errorf("%w: %w", domain.ErrConflict, err)
	}
	return mapError(err)
}

// writeRefused reports whether err, of a PUT or DELETE, is the server's
// definite refusal, a 4xx, after which the write was not applied. Any other
// failure is ambiguous: no answer at all (a network error, a timeout) or a
// 5xx, which a reverse proxy answers when its read timeout fires after the
// server behind it committed the write (FR-17, A-01); see settleWrite.
func writeRefused(err error) bool {
	code := statusCode(err)
	return code >= 400 && code < 500
}

// requireETag validates the client supplied ETag.
func requireETag(etag string) error {
	if strings.TrimSpace(etag) == "" {
		return &domain.ValidationError{Msg: "etag is required"}
	}
	return nil
}

// errWrongComponent is returned when an object ID refers to an object of
// another component type (e.g. a VTODO passed to UpdateEvent).
var errWrongComponent = errors.New("object has a different component type")

// mainComponent returns the master component of the given type: the first
// one without RECURRENCE-ID, or the first one at all.
func mainComponent(cal *ical.Calendar, name string) *ical.Component {
	var first *ical.Component
	for _, c := range cal.Children {
		if c.Name != name {
			continue
		}
		if c.Props.Get(ical.PropRecurrenceID) == nil {
			return c
		}
		if first == nil {
			first = c
		}
	}
	return first
}

// bumpChangeProps updates SEQUENCE, DTSTAMP and LAST-MODIFIED.
func bumpChangeProps(c *ical.Component, now time.Time) {
	seq := 0
	if p := c.Props.Get(ical.PropSequence); p != nil {
		if n, err := p.Int(); err == nil {
			seq = n
		}
	}
	sp := ical.NewProp(ical.PropSequence)
	sp.Value = strconv.Itoa(seq + 1)
	c.Props.Set(sp)
	setUTCNow(c.Props, ical.PropDateTimeStamp, now)
	setUTCNow(c.Props, ical.PropLastModified, now)
}

// newCalendar returns an empty VCALENDAR with the mandatory properties.
func newCalendar() *ical.Calendar {
	cal := ical.NewCalendar()
	cal.Props.SetText(ical.PropVersion, "2.0")
	cal.Props.SetText(ical.PropProductID, "-//Lucid//Lucid CalDAV Client//EN")
	return cal
}

// newComponent creates a component with UID, DTSTAMP, CREATED, LAST-MODIFIED
// and SEQUENCE set.
func newComponent(name, uid string, now time.Time) *ical.Component {
	c := ical.NewComponent(name)
	c.Props.SetText(ical.PropUID, uid)
	setUTCNow(c.Props, ical.PropDateTimeStamp, now)
	setUTCNow(c.Props, ical.PropCreated, now)
	setUTCNow(c.Props, ical.PropLastModified, now)
	sp := ical.NewProp(ical.PropSequence)
	sp.Value = "0"
	c.Props.Set(sp)
	return c
}
