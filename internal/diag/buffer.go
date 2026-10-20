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
// message that carries content (NFR-36). The Buffer cuts every string field to
// MaxFieldValue bytes (the three headers to MaxHeaderValue) and keeps At in
// UTC.
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
	// names, cut to MaxHeaderValue bytes.
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

// Rederivable reports whether a problem of this kind comes back whenever Lucid
// reads the object again: an object that does not parse (ProblemUnparsableObject)
// and one it cannot evaluate (ProblemInvalidObject). The others, an answer of the
// server, a refused write, are one-off: once gone from a Buffer they are gone
// for good. A Buffer keeps those longer.
func (k ProblemKind) Rederivable() bool {
	return k == ProblemUnparsableObject || k == ProblemInvalidObject
}

// Problem is something that went wrong, with its reason and the skeleton of
// the document involved (FR-36). Path is pseudonymised, Reason comes from
// Reason, or is the HTTP status of an answer the server refused with ("HTTP
// 403"), Skeleton from ICalSkeleton or XMLSkeleton, so none of it carries
// content (NFR-36). The Buffer cuts Path, ObjectID and Reason to MaxFieldValue
// bytes and Skeleton.Text to MaxSkeleton, and keeps At in UTC.
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
// pseudonymised, and the Buffer cuts it to MaxFieldValue bytes. Objects is the
// largest number of objects one listing of events or tasks returned, unreadable
// ones included: events and tasks are listed apart, so neither count alone is
// the number of objects.
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
// the oldest one, except that problems that are Rederivable go before the
// others; a limit of zero or less keeps none.
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
	// MaxHeaderValue caps the response header values an Exchange keeps
	// (ContentType, Server, DAV), in bytes: a server decides how long they are.
	MaxHeaderValue = 256
	// MaxFieldValue caps every other string a Buffer keeps, in bytes: paths,
	// hosts, request IDs, errors and reasons are bounded by what produced
	// them, and a server or a client chooses what that is. Skeleton.Text has
	// its own cap, MaxSkeleton.
	MaxFieldValue = 512
)

// Snapshot is a copy of what a Buffer holds, oldest entry first. Calendars are
// sorted by Path.
type Snapshot struct {
	Exchanges []Exchange
	Problems  []Problem
	Calendars []CalendarNote
}

// Buffer keeps the most recent exchanges and problems of one session and a
// note per calendar, within its Limits, MaxCalendarNotes and the caps on the
// size of what it keeps (FR-36): it is bounded in entries and in bytes, as
// anyone can open an anonymous session. It is safe for concurrent use.
//
// A nil *Buffer is a buffer that keeps nothing, so code that records into the
// Buffer of a Scope need not check for one: AddExchange, AddProblem,
// NoteCalendar and SetLimits do nothing (AddProblem reports a new problem),
// Snapshot is empty, and WithoutObjects returns a new, empty Buffer that works.
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

// AddExchange appends e, with its strings cut to their caps (MaxHeaderValue
// for the headers, MaxFieldValue for the rest) and At in UTC, and drops the
// oldest exchange if there are more than the limit.
func (b *Buffer) AddExchange(e Exchange) {
	if b == nil {
		return
	}
	e.At = e.At.UTC()
	e.RequestID = Cap(e.RequestID, MaxFieldValue)
	e.Method = Cap(e.Method, MaxFieldValue)
	e.Host = Cap(e.Host, MaxFieldValue)
	e.Path = Cap(e.Path, MaxFieldValue)
	e.Error = Cap(e.Error, MaxFieldValue)
	e.ContentType = Cap(e.ContentType, MaxHeaderValue)
	e.Server = Cap(e.Server, MaxHeaderValue)
	e.DAV = Cap(e.DAV, MaxHeaderValue)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.exchanges = trim(append(b.exchanges, e), b.limits.Exchanges)
}

// AddProblem adds p, with its strings cut to MaxFieldValue bytes, its skeleton
// to MaxSkeleton and At in UTC, as the newest problem, and drops one if there
// are more than the limit: the oldest Rederivable, else the oldest, see
// trimProblems. A problem the Buffer already holds, one with
// the same Kind, Path, Reason and Skeleton.Text once cut, is kept once: the
// repeat replaces it, with the new At and RequestID, as the newest, and pushes
// nothing out. Lucid reads a calendar again and again, and the same object
// would otherwise fill the Buffer. AddProblem reports whether p was new: true
// too where nothing is kept (a limit of zero or a nil Buffer), as every
// problem is new there.
func (b *Buffer) AddProblem(p Problem) bool {
	if b == nil {
		return true
	}
	p.At = p.At.UTC()
	p.RequestID = Cap(p.RequestID, MaxFieldValue)
	p.Path = Cap(p.Path, MaxFieldValue)
	p.ObjectID = Cap(p.ObjectID, MaxFieldValue)
	p.Reason = Cap(p.Reason, MaxFieldValue)
	p.Skeleton = capSkeleton(p.Skeleton)
	b.mu.Lock()
	defer b.mu.Unlock()
	same := func(q Problem) bool {
		return q.Kind == p.Kind && q.Path == p.Path && q.Reason == p.Reason && q.Skeleton.Text == p.Skeleton.Text
	}
	if i := slices.IndexFunc(b.problems, same); i >= 0 {
		b.problems = append(slices.Delete(b.problems, i, i+1), p)
		return false
	}
	b.problems = trimProblems(append(b.problems, p), b.limits.Problems)
	return true
}

// NoteCalendar calls update on the note of the calendar at path, which is
// empty the first time, and stores the result: calls for one path merge. The
// path is cut to MaxFieldValue bytes first, so two longer paths with the same
// beginning are one calendar. The note's Path stays that path whatever update
// does. A new path is ignored, update not called, once MaxCalendarNotes
// calendars have a note. update runs while the Buffer is locked and must not
// call it.
func (b *Buffer) NoteCalendar(path string, update func(*CalendarNote)) {
	if b == nil || update == nil {
		return
	}
	path = Cap(path, MaxFieldValue)
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

// SetLimits changes the limits. Shrinking drops the oldest entries at once (the
// problems as AddProblem does), growing keeps all.
func (b *Buffer) SetLimits(l Limits) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.limits = l
	b.exchanges = trim(b.exchanges, l.Exchanges)
	b.problems = trimProblems(b.problems, l.Problems)
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
// AnonymousLimits, so the newest entries within them (the problems as AddProblem
// keeps them). The Buffer is not changed, and the two share nothing. It is what
// survives a forced logout (FR-36). On a nil Buffer it returns a new, empty one with AnonymousLimits,
// never nil.
func (b *Buffer) WithoutObjects() *Buffer {
	c := NewBuffer(AnonymousLimits)
	if b == nil {
		return c
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	c.exchanges = trim(slices.Clone(b.exchanges), c.limits.Exchanges)
	c.problems = trimProblems(slices.Clone(b.problems), c.limits.Problems)
	for i := range c.problems {
		c.problems[i].ObjectID = ""
	}
	maps.Copy(c.calendars, b.calendars)
	return c
}

// sortedCalendars returns the notes sorted by Path. The caller holds b.mu.
func (b *Buffer) sortedCalendars() []CalendarNote {
	notes := slices.Collect(maps.Values(b.calendars))
	slices.SortFunc(notes, func(x, y CalendarNote) int { return strings.Compare(x.Path, y.Path) })
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

// trimProblems keeps limit problems of ps. Over the limit it drops the oldest
// problem that is Rederivable, which comes back when Lucid reads the object
// again, and only when there is none the oldest of the others: Lucid replays
// the problems of an object on every read, and a one-off problem the user has
// just seen would otherwise be pushed out by the next refresh. A new problem is
// one of the candidates, so with the Buffer full of one-off problems a new
// re-derivable one is not kept.
func trimProblems(ps []Problem, limit int) []Problem {
	limit = max(limit, 0)
	for len(ps) > limit {
		i := slices.IndexFunc(ps, func(p Problem) bool { return p.Kind.Rederivable() })
		if i < 0 {
			i = 0
		}
		ps = slices.Delete(ps, i, i+1) // clears the vacated element, so nothing is kept alive
	}
	return ps
}

// Cap cuts v to limit bytes, not in the middle of a rune: a cut that
// lands inside one backs up to its first byte, at most utf8.UTFMax-1 bytes. So
// the result is as valid as v was, and a value that is not UTF-8 at all is cut
// within three bytes of limit rather than to nothing. It is what the Buffer
// cuts its strings with, for callers that log the same values.
func Cap(v string, limit int) string {
	if len(v) <= limit {
		return v
	}
	n := limit
	for back := 0; back < utf8.UTFMax-1 && n > 0 && !utf8.RuneStart(v[n]); back++ {
		n--
	}
	return v[:n]
}

// capSkeleton keeps the text of s within MaxSkeleton bytes. Skeletons from
// ICalSkeleton and XMLSkeleton already are, so this only holds for one that
// was made another way. Text that is too long is cut after its last line that
// fits, or, with no line break to cut at, at MaxSkeleton bytes, and Truncated
// is set.
func capSkeleton(s Skeleton) Skeleton {
	if len(s.Text) <= MaxSkeleton {
		return s
	}
	s.Truncated = true
	// A line break right after the cap ends a line that fits, so it counts.
	if i := strings.LastIndexByte(s.Text[:MaxSkeleton+1], '\n'); i > 0 {
		s.Text = s.Text[:i]
	} else {
		s.Text = Cap(s.Text, MaxSkeleton)
	}
	return s
}
