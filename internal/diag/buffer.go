package diag

import (
	"maps"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Exchange is one HTTP exchange with the CalDAV server, as metadata only
// (FR-36): what was asked, what came back, how long it took. Path is already
// pseudonymised (Pseudonymizer.Path), and Error is a fixed wording, never a
// message that carries content (NFR-36).
type Exchange struct {
	At         time.Time `json:"at"`
	RequestID  string    `json:"requestId,omitempty"`
	Method     string    `json:"method,omitempty"`
	Host       string    `json:"host,omitempty"`
	Path       string    `json:"path,omitempty"`
	Status     int       `json:"status,omitempty"`
	DurationMS int64     `json:"durationMs"`
	Bytes      int64     `json:"bytes"`
	// ContentType, Server and DAV are the server's response headers of those
	// names. The Buffer cuts each to MaxHeaderValue bytes.
	ContentType string `json:"contentType,omitempty"`
	Server      string `json:"server,omitempty"`
	DAV         string `json:"dav,omitempty"`
	Error       string `json:"error,omitempty"`
}

// ProblemKind says what kind of thing went wrong.
type ProblemKind string

const (
	// ProblemUnparsableObject is a calendar object that did not parse as
	// iCalendar and was skipped.
	ProblemUnparsableObject ProblemKind = "unparsable_object"
	// ProblemInvalidObject is a calendar object that parsed but that Lucid
	// skipped as an event or task: a value it cannot use.
	ProblemInvalidObject ProblemKind = "invalid_object"
	// ProblemInvalidXML is a WebDAV response that was not the XML that was
	// expected.
	ProblemInvalidXML ProblemKind = "invalid_xml"
	// ProblemErrorResponse is an XML error body that came with an error
	// status, for the exception it names.
	ProblemErrorResponse ProblemKind = "error_response"
	// ProblemRejectedWrite is a write the server refused, with the skeleton of
	// what Lucid sent.
	ProblemRejectedWrite ProblemKind = "rejected_write"
)

// Problem is something that went wrong, with its reason and the skeleton of
// the document involved (FR-36). Path is pseudonymised, Reason comes from
// Reason, Skeleton from ICalSkeleton or XMLSkeleton, so none of it carries
// content (NFR-36).
type Problem struct {
	At        time.Time   `json:"at"`
	RequestID string      `json:"requestId"`
	Kind      ProblemKind `json:"kind"`
	Path      string      `json:"path"`
	// ObjectID is the ID of the calendar object the problem is about, for the
	// content the user may add to the report. It is not pseudonymous: it
	// encodes the real object path, so Buffer.WithoutObjects clears it.
	ObjectID string   `json:"objectId,omitempty"`
	Reason   string   `json:"reason"`
	Skeleton Skeleton `json:"skeleton"`
}

// CalendarNote is what Lucid found out about one calendar: its capabilities
// and how many objects it holds, never its name or contents (FR-36). Path is
// pseudonymised.
type CalendarNote struct {
	Path      string `json:"path"`
	ReadOnly  bool   `json:"readOnly"`
	Events    bool   `json:"events"`
	Todos     bool   `json:"todos"`
	CTag      bool   `json:"ctag"`
	SyncToken bool   `json:"syncToken"`
	Objects   int    `json:"objects"`
}

// Limits bound how much a Buffer keeps. An entry beyond a limit pushes out
// the oldest one; a limit of zero or less keeps none.
type Limits struct {
	Exchanges, Problems int
}

var (
	// AnonymousLimits are the limits of a session that is not logged in:
	// anyone can create one, so it keeps little (NFR-36, FR-36).
	AnonymousLimits = Limits{Exchanges: 30, Problems: 5}
	// SessionLimits are the limits of a logged-in session.
	SessionLimits = Limits{Exchanges: 100, Problems: 20}
)

const (
	// MaxCalendarNotes caps the number of calendars a Buffer keeps a note of.
	MaxCalendarNotes = 50
	// MaxHeaderValue caps the response header values an Exchange keeps, in
	// bytes: a server decides how long they are.
	MaxHeaderValue = 256
)

// Snapshot is a copy of what a Buffer holds, oldest entry first. Calendars are
// sorted by Path.
type Snapshot struct {
	Exchanges []Exchange
	Problems  []Problem
	Calendars []CalendarNote
}

// Buffer keeps the most recent exchanges and problems of one session and a
// note per calendar, within its Limits and MaxCalendarNotes (FR-36). It is
// safe for concurrent use, and a nil *Buffer drops everything it is given, so
// code that records into the buffer of a Scope need not check for one.
type Buffer struct {
	mu        sync.Mutex
	limits    Limits
	exchanges []Exchange
	problems  []Problem
	calendars map[string]CalendarNote
}

// NewBuffer returns an empty Buffer with the limits l.
func NewBuffer(l Limits) *Buffer {
	return &Buffer{limits: l, calendars: make(map[string]CalendarNote)}
}

// AddExchange appends e, with its header values cut to MaxHeaderValue bytes,
// and drops the oldest exchange if there are more than the limit.
func (b *Buffer) AddExchange(e Exchange) {
	if b == nil {
		return
	}
	e.ContentType = capHeader(e.ContentType)
	e.Server = capHeader(e.Server)
	e.DAV = capHeader(e.DAV)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.exchanges = trim(append(b.exchanges, e), b.limits.Exchanges)
}

// AddProblem appends p and drops the oldest problem if there are more than the
// limit.
func (b *Buffer) AddProblem(p Problem) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.problems = trim(append(b.problems, p), b.limits.Problems)
}

// NoteCalendar calls update on the note of the calendar at path, which is
// empty the first time, and stores the result: calls for one path merge. The
// note's Path stays path whatever update does. A new path is ignored, update
// not called, once MaxCalendarNotes calendars have a note. update runs while
// the Buffer is locked and must not call it.
func (b *Buffer) NoteCalendar(path string, update func(*CalendarNote)) {
	if b == nil || update == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	note, known := b.calendars[path]
	if !known {
		if len(b.calendars) >= MaxCalendarNotes {
			return
		}
		note = CalendarNote{Path: path}
	}
	update(&note)
	note.Path = path
	b.calendars[path] = note
}

// SetLimits changes the limits. Shrinking drops the oldest entries at once,
// growing keeps all.
func (b *Buffer) SetLimits(l Limits) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.limits = l
	b.exchanges = trim(b.exchanges, l.Exchanges)
	b.problems = trim(b.problems, l.Problems)
}

// Snapshot returns a copy of what the Buffer holds.
func (b *Buffer) Snapshot() Snapshot {
	if b == nil {
		return Snapshot{}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return Snapshot{
		Exchanges: slices.Clone(b.exchanges),
		Problems:  slices.Clone(b.problems),
		Calendars: b.sortedCalendars(),
	}
}

// WithoutObjects returns a copy of the Buffer for an anonymous session: the
// same exchanges, problems and calendar notes, which are all pseudonymous,
// without the object IDs of the problems, which are not, and with
// AnonymousLimits, so the newest entries within them. The Buffer is not
// changed, and the two share nothing. It is what survives a forced logout
// (FR-36).
func (b *Buffer) WithoutObjects() *Buffer {
	c := NewBuffer(AnonymousLimits)
	if b == nil {
		return c
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	c.exchanges = trim(slices.Clone(b.exchanges), c.limits.Exchanges)
	c.problems = trim(slices.Clone(b.problems), c.limits.Problems)
	for i := range c.problems {
		c.problems[i].ObjectID = ""
	}
	maps.Copy(c.calendars, b.calendars)
	return c
}

// sortedCalendars returns the notes sorted by Path. The caller holds b.mu.
func (b *Buffer) sortedCalendars() []CalendarNote {
	notes := slices.Collect(maps.Values(b.calendars))
	slices.SortFunc(notes, func(a, b CalendarNote) int { return strings.Compare(a.Path, b.Path) })
	return notes
}

// trim keeps the last limit elements of s, moving them to the front of s so
// the dropped ones are not kept alive behind the slice.
func trim[T any](s []T, limit int) []T {
	limit = max(limit, 0)
	if len(s) <= limit {
		return s
	}
	n := copy(s, s[len(s)-limit:])
	clear(s[n:])
	return s[:n]
}

// capHeader cuts v to MaxHeaderValue bytes, not in the middle of a rune.
func capHeader(v string) string {
	if len(v) <= MaxHeaderValue {
		return v
	}
	n := MaxHeaderValue
	for n > 0 && !utf8.RuneStart(v[n]) {
		n--
	}
	return v[:n]
}
