// Package caldavtest provides an in-memory CalDAV server for tests and local
// development (see cmd/lucid-mockdav).
//
// It is built on github.com/emersion/go-webdav's caldav.Handler with an
// in-memory Backend and adds what real servers offer and Lucid relies on:
// HTTP basic auth, a /.well-known/caldav redirect, CalendarServer getctag,
// WebDAV sync-token, Apple calendar-color, read-only calendars (privileges),
// ETags and If-Match / If-None-Match preconditions. Requests are counted per
// method so that tests can assert cache behavior.
package caldavtest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-ical"
	"github.com/emersion/go-webdav"
	"github.com/emersion/go-webdav/caldav"
)

// Options configures a Server.
type Options struct {
	// Username and Password for HTTP basic auth. Defaults "user" / "pass".
	Username, Password string
	// Prefix mounts the DAV tree below this path (e.g. "/dav"). Requests
	// outside the prefix get 404, so discovery must use .well-known.
	Prefix string
	// WellKnownStatus is the redirect status for /.well-known/caldav.
	// Default 301.
	WellKnownStatus int
	// DisableCTag hides the getctag property.
	DisableCTag bool
	// DisableSyncToken hides the sync-token property.
	DisableSyncToken bool
}

// Calendar describes a calendar collection to seed.
type Calendar struct {
	Slug        string   // last path segment, e.g. "personal"
	Name        string   // displayname
	Description string   // calendar-description
	Color       string   // Apple calendar-color, e.g. "#3B82F6FF"
	Components  []string // supported components; default VEVENT
	ReadOnly    bool     // current-user-privilege-set without write
}

type object struct {
	data    []byte
	etag    string
	modTime time.Time
}

type calendar struct {
	Calendar
	path    string
	objects map[string]*object // by path
	version int
}

// Server is an in-memory CalDAV server implementing http.Handler.
type Server struct {
	opts    Options
	handler *caldav.Handler

	mu     sync.Mutex
	cals   map[string]*calendar // by path (with trailing slash)
	counts map[string]int
	hook   func(http.ResponseWriter, *http.Request) bool
}

// New creates an empty Server.
func New(opts Options) *Server {
	if opts.Username == "" {
		opts.Username = "user"
	}
	if opts.Password == "" {
		opts.Password = "pass"
	}
	if opts.WellKnownStatus == 0 {
		opts.WellKnownStatus = http.StatusMovedPermanently
	}
	opts.Prefix = strings.TrimSuffix(opts.Prefix, "/")
	s := &Server{opts: opts, cals: map[string]*calendar{}, counts: map[string]int{}}
	s.handler = &caldav.Handler{Backend: &backend{s: s}, Prefix: opts.Prefix}
	return s
}

// PrincipalPath returns the path of the user principal.
func (s *Server) PrincipalPath() string { return s.opts.Prefix + "/" + s.opts.Username + "/" }

// HomePath returns the calendar home set path.
func (s *Server) HomePath() string { return s.PrincipalPath() + "calendars/" }

// AddCalendar adds (or replaces) a calendar and returns its path.
func (s *Server) AddCalendar(c Calendar) string {
	if len(c.Components) == 0 {
		c.Components = []string{ical.CompEvent}
	}
	p := s.HomePath() + c.Slug + "/"
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cals[p] = &calendar{Calendar: c, path: p, objects: map[string]*object{}, version: 1}
	return p
}

// PutObject stores raw iCalendar data as name inside the calendar at calPath
// (bypassing HTTP) and returns the object path.
func (s *Server) PutObject(calPath, name, ics string) (string, error) {
	cal, err := ical.NewDecoder(strings.NewReader(ics)).Decode()
	if err != nil {
		return "", fmt.Errorf("caldavtest: %w", err)
	}
	var buf bytes.Buffer
	if err := ical.NewEncoder(&buf).Encode(cal); err != nil {
		return "", fmt.Errorf("caldavtest: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.cals[calPath]
	if !ok {
		return "", fmt.Errorf("caldavtest: no calendar %s", calPath)
	}
	p := calPath + name
	c.objects[p] = newObject(buf.Bytes())
	c.version++
	return p, nil
}

// Object returns the stored iCalendar data of the object at p.
func (s *Server) Object(p string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.cals {
		if o, ok := c.objects[p]; ok {
			return string(o.data), true
		}
	}
	return "", false
}

// ObjectPaths returns the sorted object paths of a calendar.
func (s *Server) ObjectPaths(calPath string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.cals[calPath]
	if !ok {
		return nil
	}
	out := make([]string, 0, len(c.objects))
	for p := range c.objects {
		out = append(out, p)
	}
	slices.Sort(out)
	return out
}

// Count returns the number of requests received with the given method.
func (s *Server) Count(method string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.counts[method]
}

// ResetCounts clears the request counters.
func (s *Server) ResetCounts() {
	s.mu.Lock()
	defer s.mu.Unlock()
	clear(s.counts)
}

// SetHook installs a function that sees every request first. If it returns
// true, the request is considered handled.
func (s *Server) SetHook(h func(http.ResponseWriter, *http.Request) bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hook = h
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.counts[r.Method]++
	hook := s.hook
	s.mu.Unlock()
	if hook != nil && hook(w, r) {
		return
	}

	if r.URL.Path == "/.well-known/caldav" {
		http.Redirect(w, r, s.opts.Prefix+"/", s.opts.WellKnownStatus)
		return
	}
	if s.opts.Prefix != "" && r.URL.Path != s.opts.Prefix && !strings.HasPrefix(r.URL.Path, s.opts.Prefix+"/") {
		http.NotFound(w, r)
		return
	}
	user, pass, ok := r.BasicAuth()
	if !ok || user != s.opts.Username || pass != s.opts.Password {
		w.Header().Set("WWW-Authenticate", `Basic realm="caldavtest"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	switch r.Method {
	case "PROPFIND":
		if s.propfindCollection(w, r) {
			return
		}
	case http.MethodDelete:
		s.delete(w, r)
		return
	}
	s.handler.ServeHTTP(w, r)
}

func (s *Server) delete(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, o := s.lookup(r.URL.Path)
	if o == nil {
		http.NotFound(w, r)
		return
	}
	if c.ReadOnly {
		http.Error(w, "read only", http.StatusForbidden)
		return
	}
	if im := r.Header.Get("If-Match"); im != "" && im != "*" && im != quote(o.etag) {
		http.Error(w, "precondition failed", http.StatusPreconditionFailed)
		return
	}
	delete(c.objects, r.URL.Path)
	c.version++
	w.WriteHeader(http.StatusNoContent)
}

// lookup returns the calendar and object for an object path (locked).
func (s *Server) lookup(p string) (*calendar, *object) {
	c, ok := s.cals[path.Dir(p)+"/"]
	if !ok {
		return nil, nil
	}
	return c, c.objects[p]
}

func newObject(data []byte) *object {
	sum := sha256.Sum256(data)
	return &object{data: data, etag: hex.EncodeToString(sum[:8]), modTime: time.Now().UTC()}
}

func quote(etag string) string { return `"` + etag + `"` }

// --- PROPFIND for the home set and calendars ---

type propfindReq struct {
	Prop *struct {
		Names []struct {
			XMLName xml.Name
		} `xml:",any"`
	} `xml:"DAV: prop"`
}

// propfindCollection answers PROPFIND on the home set and calendar
// collections itself, so that it can offer getctag, sync-token,
// calendar-color and privileges. It reports whether it handled the request.
func (s *Server) propfindCollection(w http.ResponseWriter, r *http.Request) bool {
	p := strings.TrimSuffix(r.URL.Path, "/") + "/"
	s.mu.Lock()
	defer s.mu.Unlock()
	c, isCal := s.cals[p]
	if p != s.HomePath() && !isCal {
		return false
	}

	var req propfindReq
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var names []xml.Name
	if len(bytes.TrimSpace(body)) > 0 {
		if err := xml.Unmarshal(body, &req); err != nil {
			http.Error(w, "bad propfind", http.StatusBadRequest)
			return true
		}
		if req.Prop != nil {
			for _, n := range req.Prop.Names {
				names = append(names, n.XMLName)
			}
		}
	}
	if len(names) == 0 {
		names = allProps
	}
	depth1 := r.Header.Get("Depth") != "0"

	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="utf-8"?>` +
		`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/">`)
	if isCal {
		s.writeResponse(&b, p, names, s.calendarProps(c))
		if depth1 {
			for _, op := range sortedKeys(c.objects) {
				o := c.objects[op]
				s.writeResponse(&b, op, names, map[xml.Name]string{
					{Space: "DAV:", Local: "getetag"}:        escape(quote(o.etag)),
					{Space: "DAV:", Local: "getcontenttype"}: "text/calendar; charset=utf-8",
					{Space: "DAV:", Local: "resourcetype"}:   "",
				})
			}
		}
	} else {
		s.writeResponse(&b, p, names, map[xml.Name]string{
			{Space: "DAV:", Local: "resourcetype"}:           "<d:collection/>",
			{Space: "DAV:", Local: "current-user-principal"}: "<d:href>" + escape(s.PrincipalPath()) + "</d:href>",
		})
		if depth1 {
			for _, cp := range sortedKeys(s.cals) {
				s.writeResponse(&b, cp, names, s.calendarProps(s.cals[cp]))
			}
		}
	}
	b.WriteString(`</d:multistatus>`)
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(http.StatusMultiStatus)
	_, _ = io.WriteString(w, b.String())
	return true
}

// allProps is used for PROPFIND requests without a prop list (allprop).
var allProps = []xml.Name{
	{Space: "DAV:", Local: "resourcetype"},
	{Space: "DAV:", Local: "displayname"},
	{Space: "DAV:", Local: "current-user-privilege-set"},
	{Space: "urn:ietf:params:xml:ns:caldav", Local: "calendar-description"},
	{Space: "urn:ietf:params:xml:ns:caldav", Local: "supported-calendar-component-set"},
	{Space: "http://apple.com/ns/ical/", Local: "calendar-color"},
	{Space: "http://calendarserver.org/ns/", Local: "getctag"},
	{Space: "DAV:", Local: "sync-token"},
	{Space: "DAV:", Local: "getetag"},
}

// calendarProps returns the inner XML of all properties of c (locked).
func (s *Server) calendarProps(c *calendar) map[xml.Name]string {
	var comps strings.Builder
	for _, comp := range c.Components {
		comps.WriteString(`<c:comp name="` + escape(comp) + `"/>`)
	}
	priv := "<d:privilege><d:read/></d:privilege>"
	if !c.ReadOnly {
		priv += "<d:privilege><d:write/></d:privilege><d:privilege><d:write-content/></d:privilege><d:privilege><d:bind/></d:privilege><d:privilege><d:unbind/></d:privilege>"
	}
	props := map[xml.Name]string{
		{Space: "DAV:", Local: "resourcetype"}:                                              "<d:collection/><c:calendar/>",
		{Space: "DAV:", Local: "displayname"}:                                               escape(c.Name),
		{Space: "DAV:", Local: "current-user-privilege-set"}:                                priv,
		{Space: "DAV:", Local: "current-user-principal"}:                                    "<d:href>" + escape(s.PrincipalPath()) + "</d:href>",
		{Space: "urn:ietf:params:xml:ns:caldav", Local: "supported-calendar-component-set"}: comps.String(),
	}
	if c.Description != "" {
		props[xml.Name{Space: "urn:ietf:params:xml:ns:caldav", Local: "calendar-description"}] = escape(c.Description)
	}
	if c.Color != "" {
		props[xml.Name{Space: "http://apple.com/ns/ical/", Local: "calendar-color"}] = escape(c.Color)
	}
	if !s.opts.DisableCTag {
		props[xml.Name{Space: "http://calendarserver.org/ns/", Local: "getctag"}] = "ctag-" + strconv.Itoa(c.version)
	}
	if !s.opts.DisableSyncToken {
		props[xml.Name{Space: "DAV:", Local: "sync-token"}] = "http://caldavtest/sync/" + strconv.Itoa(c.version)
	}
	return props
}

var prefixes = map[string]string{
	"DAV:":                          "d",
	"urn:ietf:params:xml:ns:caldav": "c",
	"http://calendarserver.org/ns/": "cs",
	"http://apple.com/ns/ical/":     "a",
}

func (s *Server) writeResponse(b *strings.Builder, href string, names []xml.Name, props map[xml.Name]string) {
	var found, missing strings.Builder
	for i, n := range names {
		v, ok := props[n]
		var tag, decl string
		if pfx, known := prefixes[n.Space]; known {
			tag = pfx + ":" + n.Local
		} else {
			tag = "x" + strconv.Itoa(i) + ":" + n.Local
			decl = ` xmlns:x` + strconv.Itoa(i) + `="` + escape(n.Space) + `"`
		}
		if ok {
			found.WriteString("<" + tag + decl + ">" + v + "</" + tag + ">")
		} else {
			missing.WriteString("<" + tag + decl + "/>")
		}
	}
	b.WriteString("<d:response><d:href>" + escape(href) + "</d:href>")
	if found.Len() > 0 {
		b.WriteString("<d:propstat><d:prop>" + found.String() + "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>")
	}
	if missing.Len() > 0 {
		b.WriteString("<d:propstat><d:prop>" + missing.String() + "</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>")
	}
	b.WriteString("</d:response>")
}

func escape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// --- caldav.Backend ---

type backend struct{ s *Server }

var _ caldav.Backend = (*backend)(nil)

func (b *backend) CurrentUserPrincipal(context.Context) (string, error) {
	return b.s.PrincipalPath(), nil
}

func (b *backend) CalendarHomeSetPath(context.Context) (string, error) {
	return b.s.HomePath(), nil
}

func (b *backend) CreateCalendar(context.Context, *caldav.Calendar) error {
	return webdav.NewHTTPError(http.StatusForbidden, errors.New("calendar creation not supported"))
}

func (b *backend) ListCalendars(context.Context) ([]caldav.Calendar, error) {
	b.s.mu.Lock()
	defer b.s.mu.Unlock()
	var out []caldav.Calendar
	for _, p := range sortedKeys(b.s.cals) {
		out = append(out, toCalendar(b.s.cals[p]))
	}
	return out, nil
}

func toCalendar(c *calendar) caldav.Calendar {
	return caldav.Calendar{Path: c.path, Name: c.Name, Description: c.Description, SupportedComponentSet: c.Components}
}

func (b *backend) GetCalendar(_ context.Context, p string) (*caldav.Calendar, error) {
	b.s.mu.Lock()
	defer b.s.mu.Unlock()
	c, ok := b.s.cals[strings.TrimSuffix(p, "/")+"/"]
	if !ok {
		return nil, webdav.NewHTTPError(http.StatusNotFound, fmt.Errorf("no calendar %s", p))
	}
	cal := toCalendar(c)
	return &cal, nil
}

func (b *backend) GetCalendarObject(_ context.Context, p string, _ *caldav.CalendarCompRequest) (*caldav.CalendarObject, error) {
	b.s.mu.Lock()
	defer b.s.mu.Unlock()
	_, o := b.s.lookup(p)
	if o == nil {
		return nil, webdav.NewHTTPError(http.StatusNotFound, fmt.Errorf("no object %s", p))
	}
	return toObject(p, o)
}

func toObject(p string, o *object) (*caldav.CalendarObject, error) {
	cal, err := ical.NewDecoder(bytes.NewReader(o.data)).Decode()
	if err != nil {
		return nil, err
	}
	return &caldav.CalendarObject{Path: p, ModTime: o.modTime, ContentLength: int64(len(o.data)), ETag: o.etag, Data: cal}, nil
}

func (b *backend) ListCalendarObjects(_ context.Context, p string, _ *caldav.CalendarCompRequest) ([]caldav.CalendarObject, error) {
	b.s.mu.Lock()
	defer b.s.mu.Unlock()
	c, ok := b.s.cals[strings.TrimSuffix(p, "/")+"/"]
	if !ok {
		return nil, webdav.NewHTTPError(http.StatusNotFound, fmt.Errorf("no calendar %s", p))
	}
	var out []caldav.CalendarObject
	for _, op := range sortedKeys(c.objects) {
		co, err := toObject(op, c.objects[op])
		if err != nil {
			return nil, err
		}
		out = append(out, *co)
	}
	return out, nil
}

func (b *backend) QueryCalendarObjects(ctx context.Context, p string, query *caldav.CalendarQuery) ([]caldav.CalendarObject, error) {
	objs, err := b.ListCalendarObjects(ctx, p, nil)
	if err != nil {
		return nil, err
	}
	return caldav.Filter(query, objs)
}

func (b *backend) PutCalendarObject(_ context.Context, p string, cal *ical.Calendar, opts *caldav.PutCalendarObjectOptions) (*caldav.CalendarObject, error) {
	var buf bytes.Buffer
	if err := ical.NewEncoder(&buf).Encode(cal); err != nil {
		return nil, webdav.NewHTTPError(http.StatusBadRequest, err)
	}
	b.s.mu.Lock()
	defer b.s.mu.Unlock()
	c, ok := b.s.cals[path.Dir(p)+"/"]
	if !ok {
		return nil, webdav.NewHTTPError(http.StatusConflict, fmt.Errorf("no calendar for %s", p))
	}
	if c.ReadOnly {
		return nil, webdav.NewHTTPError(http.StatusForbidden, errors.New("calendar is read-only"))
	}
	existing := c.objects[p]
	if opts != nil {
		if opts.IfNoneMatch.IsWildcard() && existing != nil {
			return nil, webdav.NewHTTPError(http.StatusPreconditionFailed, errors.New("object exists"))
		}
		if opts.IfMatch.IsSet() {
			if existing == nil {
				return nil, webdav.NewHTTPError(http.StatusPreconditionFailed, errors.New("object does not exist"))
			}
			if ok, err := opts.IfMatch.MatchETag(existing.etag); err != nil || !ok {
				return nil, webdav.NewHTTPError(http.StatusPreconditionFailed, errors.New("etag mismatch"))
			}
		}
	}
	o := newObject(buf.Bytes())
	c.objects[p] = o
	c.version++
	return &caldav.CalendarObject{Path: p, ModTime: o.modTime, ContentLength: int64(len(o.data)), ETag: o.etag, Data: cal}, nil
}

func (b *backend) DeleteCalendarObject(_ context.Context, p string) error {
	b.s.mu.Lock()
	defer b.s.mu.Unlock()
	c, o := b.s.lookup(p)
	if o == nil {
		return webdav.NewHTTPError(http.StatusNotFound, fmt.Errorf("no object %s", p))
	}
	delete(c.objects, p)
	c.version++
	return nil
}
