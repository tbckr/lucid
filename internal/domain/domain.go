// Package domain holds the types and service interfaces shared between the
// HTTP layer and the CalDAV integration. It has no dependencies on either, so
// both sides can be developed and tested in isolation (dependency injection).
package domain

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Sentinel errors returned by CalendarService and Provider implementations.
// The HTTP layer maps them to status codes; wrap them with fmt.Errorf("%w").
var (
	// ErrUnauthorized means the CalDAV server rejected the credentials.
	ErrUnauthorized = errors.New("unauthorized")
	// ErrNotFound means the calendar or object does not exist.
	ErrNotFound = errors.New("not found")
	// ErrConflict means the If-Match ETag no longer matches (412 upstream).
	ErrConflict = errors.New("conflict")
	// ErrInvalidInput means the request failed validation.
	ErrInvalidInput = errors.New("invalid input")
	// ErrReadOnly means the target calendar cannot be written to.
	ErrReadOnly = errors.New("read only")
	// ErrUnsupportedComponent means the target calendar does not accept the
	// component type (e.g. an event in a calendar that only holds todos).
	ErrUnsupportedComponent = errors.New("component type not supported by calendar")
	// ErrSeriesMoveUnsupported means "all events" of a recurring series,
	// "this and following events" as a series of their own, or a task series
	// from its current repeat, cannot move as asked without some of them
	// landing elsewhere than the edited one, so only that event or repeat
	// can move (FR-17).
	ErrSeriesMoveUnsupported = errors.New("series move unsupported")
	// ErrSeriesSplitUnsupported means a recurring series cannot be split at
	// an occurrence ("this and following events"): it has an ORGANIZER or an
	// ATTENDEE, an EXRULE, more than one RRULE, or a rule Lucid cannot read
	// or walk to the occurrence, the occurrence is at or before DTSTART
	// without being the first, or a new series of a single event would lose
	// an event the series shows after it. Nothing is written; the whole
	// series or only the event can change instead (FR-17).
	ErrSeriesSplitUnsupported = errors.New("series split unsupported")
	// ErrDiscovery means no CalDAV service could be found for the given URL.
	ErrDiscovery = errors.New("caldav discovery failed")
	// ErrForbiddenTarget means the target address was rejected by SSRF protection.
	ErrForbiddenTarget = errors.New("forbidden target address")
	// ErrUpstream means the CalDAV server failed or was unreachable.
	ErrUpstream = errors.New("upstream error")
)

// Credentials are the values a user enters on the login form.
type Credentials struct {
	ServerURL string `json:"serverUrl"`
	Username  string `json:"username"`
	Password  string `json:"password"`
}

// Account is the result of a successful Connect. It is stored (encrypted)
// in the server-side session and contains everything needed to talk to the
// CalDAV server again without repeating discovery.
type Account struct {
	Username        string `json:"username"`
	Password        string `json:"password"`
	ServerURL       string `json:"serverUrl"`       // URL as entered by the user
	EndpointURL     string `json:"endpointUrl"`     // resolved CalDAV context URL
	PrincipalURL    string `json:"principalUrl"`    // absolute URL
	CalendarHomeURL string `json:"calendarHomeUrl"` // absolute URL
}

// Calendar is a CalDAV calendar collection.
type Calendar struct {
	ID             string `json:"id"` // opaque, URL-safe
	Name           string `json:"name"`
	Description    string `json:"description,omitempty"`
	Color          string `json:"color"` // "#rrggbb"; a default is assigned when the server has none
	ReadOnly       bool   `json:"readOnly"`
	SupportsEvents bool   `json:"supportsEvents"`
	SupportsTodos  bool   `json:"supportsTodos"`
}

// Event is a single VEVENT occurrence. Recurring series are expanded by the
// backend: every occurrence in the requested range is returned as its own
// Event sharing ID/ETag with the series, distinguished by RecurrenceID.
type Event struct {
	ID           string     `json:"id"`  // opaque object ID (identifies the .ics resource)
	Key          string     `json:"key"` // unique per occurrence: ID, or ID + "@" + RecurrenceID (RFC 3339)
	CalendarID   string     `json:"calendarId"`
	UID          string     `json:"uid"`
	ETag         string     `json:"etag"` // Concurrency control (If-Match)
	Title        string     `json:"title"`
	Description  string     `json:"description,omitempty"`
	Location     string     `json:"location,omitempty"`
	Start        time.Time  `json:"start"` // UTC instant; for all-day events midnight UTC of the start date
	End          time.Time  `json:"end"`   // exclusive; for all-day events midnight UTC of the day after the last day
	AllDay       bool       `json:"allDay"`
	Timezone     string     `json:"timezone,omitempty"` // IANA TZID of DTSTART, if any
	RRule        string     `json:"rrule,omitempty"`    // e.g. "FREQ=WEEKLY;BYDAY=MO"
	Recurring    bool       `json:"recurring"`
	RecurrenceID *time.Time `json:"recurrenceId,omitempty"` // original start of this occurrence
	// Modified is true for an occurrence of a series that an override
	// visibly changes: start, duration, all-day, title, location or
	// description. Invisible differences, such as PARTSTAT or an added
	// VALARM, do not set it (FR-17).
	Modified bool `json:"modified,omitempty"`
	// First is true for the occurrence that is the first one of its series
	// ListEvents shows, whatever the window: a window that starts after it
	// has no such event. A series is not split at its first event, which
	// "this and following events" there is "all events" for (FR-17).
	First bool `json:"first,omitempty"`
	// HasAttendees is true for every event of a resource where the series or
	// any of its overrides has an ORGANIZER or an ATTENDEE. The server does
	// not split such a series, so the client does not offer it (FR-17).
	HasAttendees bool `json:"hasAttendees,omitempty"`
	// UndoToken undoes the change of the series whose response carries it
	// (FR-17).
	UndoToken string `json:"undoToken,omitempty"`
}

// EventInput is the payload for creating or updating an event.
type EventInput struct {
	Title       string    `json:"title"`
	Description string    `json:"description,omitempty"`
	Location    string    `json:"location,omitempty"`
	Start       time.Time `json:"start"`
	End         time.Time `json:"end"`
	AllDay      bool      `json:"allDay"`
	Timezone    string    `json:"timezone,omitempty"`
	RRule       string    `json:"rrule,omitempty"`
	// InstanceStart is only used when updating an occurrence of a recurring
	// series: it is the RecurrenceID of the occurrence that was edited. The
	// update is applied to the whole series ("all events"): it moves by the
	// distance the occurrence moved from where it was shown, and takes only
	// the fields that changed from it (FR-17).
	InstanceStart *time.Time `json:"instanceStart,omitempty"`
}

// OccurrenceInput is the payload for changing only one occurrence of a
// recurring series ("only this event"), writing or editing an RFC 5545
// override. There is no RRule: the rule belongs to the series (FR-17).
type OccurrenceInput struct {
	Title       string    `json:"title"`
	Description string    `json:"description,omitempty"`
	Location    string    `json:"location,omitempty"`
	Start       time.Time `json:"start"`
	End         time.Time `json:"end"`
	AllDay      bool      `json:"allDay"`
	Timezone    string    `json:"timezone,omitempty"`
}

// Validate checks the input for structural problems, the EventInput rules
// without RRule (FR-17). It wraps ErrInvalidInput.
func (in OccurrenceInput) Validate() error {
	return EventInput{
		Title: in.Title, Description: in.Description, Location: in.Location,
		Start: in.Start, End: in.End, AllDay: in.AllDay, Timezone: in.Timezone,
	}.Validate()
}

// Maximum field sizes accepted from clients.
const (
	MaxTitleLen       = 1024
	MaxDescriptionLen = 64 * 1024
	MaxLocationLen    = 1024
	MaxRRuleLen       = 1024
)

// Validate checks the input for structural problems. It wraps ErrInvalidInput.
func (in EventInput) Validate() error {
	switch {
	case len(in.Title) > MaxTitleLen:
		return invalid("title too long")
	case len(in.Description) > MaxDescriptionLen:
		return invalid("description too long")
	case len(in.Location) > MaxLocationLen:
		return invalid("location too long")
	case len(in.RRule) > MaxRRuleLen:
		return invalid("rrule too long")
	case in.Start.IsZero() || in.End.IsZero():
		return invalid("start and end are required")
	case in.End.Before(in.Start):
		return invalid("end must not be before start")
	case in.Timezone != "":
		if _, err := time.LoadLocation(in.Timezone); err != nil {
			return invalid("unknown timezone")
		}
	}
	return nil
}

// Todo statuses (RFC 5545 VTODO STATUS).
const (
	TodoNeedsAction = "NEEDS-ACTION"
	TodoInProcess   = "IN-PROCESS"
	TodoCompleted   = "COMPLETED"
	TodoCancelled   = "CANCELLED"
)

// ChecklistItem is one entry of a task checklist. Checklists are stored in
// the VTODO DESCRIPTION as Markdown task lines ("- [ ] text" / "- [x] text")
// after the free-text description, so they stay readable in other clients.
type ChecklistItem struct {
	Text string `json:"text"`
	Done bool   `json:"done"`
}

// Todo is a VTODO item.
type Todo struct {
	ID          string          `json:"id"`
	CalendarID  string          `json:"calendarId"`
	UID         string          `json:"uid"`
	ETag        string          `json:"etag"`
	Title       string          `json:"title"`
	Description string          `json:"description,omitempty"` // without checklist lines
	Checklist   []ChecklistItem `json:"checklist"`
	// Start and Due span the calendar views (FR-16); for an open recurring
	// todo: those of its current occurrence (FR-17).
	Start       *time.Time `json:"start,omitempty"` // DTSTART
	StartAllDay bool       `json:"startAllDay"`
	Due         *time.Time `json:"due,omitempty"`
	DueAllDay   bool       `json:"dueAllDay"`
	Priority    int        `json:"priority"` // 0 = undefined, 1 = highest ... 9 = lowest
	Status      string     `json:"status"`
	Completed   *time.Time `json:"completed,omitempty"`

	// RRule, Recurring, FixedDays and RuleUnsupported describe a recurring
	// series (FR-17). Next is the earliest open occurrence after the current
	// one, or nil if this is the last. CompletedCopy is the just-completed
	// occurrence, returned only by the PUT that completes it, so the client
	// can show it alongside the advanced series without a refetch.
	RRule           string     `json:"rrule"`
	Recurring       bool       `json:"recurring"`
	FixedDays       bool       `json:"fixedDays"`
	RuleUnsupported bool       `json:"ruleUnsupported"`
	Next            *TodoDates `json:"next"`
	CompletedCopy   *Todo      `json:"completedCopy,omitempty"`
	// HasAttendees reports that a VTODO of the resource, the series or one of
	// its overrides, has an ORGANIZER or an ATTENDEE: a server that schedules
	// implicitly may have told others of a change, so Lucid hands out no undo
	// for it (RFC 5545 section 3.8.7.4). DetachedFrom is the UID of the series
	// the todo was detached from, as the property X-LUCID-DETACHED-FROM
	// stores it; setting a rule on the todo drops it, as the todo becomes a
	// series of its own. DetachedCopy is the repeat a detach just turned into
	// a todo of its own, returned only by the request that detaches it, like
	// CompletedCopy (FR-17).
	HasAttendees bool   `json:"hasAttendees,omitempty"`
	DetachedFrom string `json:"detachedFrom,omitempty"`
	DetachedCopy *Todo  `json:"detachedCopy,omitempty"`
	// UndoToken undoes the change whose response carries it. CopyKept, in
	// the response of an undo, reports that the completed copy the change
	// left stays, because another client changed it (FR-17).
	UndoToken string `json:"undoToken,omitempty"`
	CopyKept  bool   `json:"copyKept,omitempty"`
}

// TodoDates are the start and due of one occurrence, with their own value
// types (FR-16, FR-17): an override can carry a type that differs from its
// series' (e.g. a date moved to a time), so the current and the next
// occurrence each report their own.
type TodoDates struct {
	Start       *time.Time `json:"start"`
	StartAllDay bool       `json:"startAllDay"`
	Due         *time.Time `json:"due"`
	DueAllDay   bool       `json:"dueAllDay"`
}

// Occurrence states (FR-17).
const (
	OccurrenceCurrent  = "current"
	OccurrenceUpcoming = "upcoming"
	OccurrenceDone     = "done"
)

// TodoOccurrence is one occurrence of an open recurring todo (FR-16, FR-17).
type TodoOccurrence struct {
	Key          string     `json:"key"` // TodoID + "@" + RecurrenceID in RFC 3339 UTC
	TodoID       string     `json:"todoId"`
	CalendarID   string     `json:"calendarId"`
	RecurrenceID time.Time  `json:"recurrenceId"`
	Title        string     `json:"title"`
	Start        *time.Time `json:"start"`
	StartAllDay  bool       `json:"startAllDay"`
	Due          *time.Time `json:"due"`
	DueAllDay    bool       `json:"dueAllDay"`
	State        string     `json:"state"` // OccurrenceCurrent, OccurrenceUpcoming or OccurrenceDone
}

// TodoInput is the payload for creating or updating a todo.
type TodoInput struct {
	Title       string          `json:"title"`
	Description string          `json:"description,omitempty"`
	Checklist   []ChecklistItem `json:"checklist"`
	Start       *time.Time      `json:"start,omitempty"`
	StartAllDay bool            `json:"startAllDay"`
	// StartOmitted is set when a JSON body has no "start" at all: clients that
	// predate it keep the stored DTSTART, only an explicit null removes it.
	StartOmitted bool       `json:"-"`
	Due          *time.Time `json:"due,omitempty"`
	DueAllDay    bool       `json:"dueAllDay"`
	Priority     int        `json:"priority"`
	Status       string     `json:"status"` // empty means NEEDS-ACTION
	// RRule absent means keep the stored rule; "" means remove it (FR-17), see RRuleOmitted.
	RRule string `json:"rrule"`
	// RRuleOmitted is set when a JSON body has no "rrule" at all, like StartOmitted.
	RRuleOmitted bool   `json:"-"`
	Timezone     string `json:"timezone,omitempty"`
}

// UnmarshalJSON decodes strictly (unknown fields are errors, as for every
// request body) and records whether "start" and "rrule" were sent at all.
func (in *TodoInput) UnmarshalJSON(b []byte) error {
	type plain TodoInput // without this method, so decoding does not recurse
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var p plain
	if err := dec.Decode(&p); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(b, &fields); err != nil {
		return err
	}
	*in = TodoInput(p)
	in.StartOmitted = true
	in.RRuleOmitted = true
	for k := range fields {
		// encoding/json matches field names case-insensitively.
		if strings.EqualFold(k, "start") {
			in.StartOmitted = false
		}
		if strings.EqualFold(k, "rrule") {
			in.RRuleOmitted = false
		}
	}
	return nil
}

// MaxChecklistItems bounds the checklist length.
const MaxChecklistItems = 200

// Validate checks the input for structural problems. It wraps ErrInvalidInput.
func (in TodoInput) Validate() error {
	switch {
	case in.Title == "":
		return invalid("title is required")
	case len(in.Title) > MaxTitleLen:
		return invalid("title too long")
	case len(in.Description) > MaxDescriptionLen:
		return invalid("description too long")
	case in.Priority < 0 || in.Priority > 9:
		return invalid("priority must be between 0 and 9")
	case len(in.Checklist) > MaxChecklistItems:
		return invalid("too many checklist items")
	case len(in.RRule) > MaxRRuleLen:
		return invalid("rrule too long")
	}
	switch in.Status {
	case "", TodoNeedsAction, TodoInProcess, TodoCompleted, TodoCancelled:
	default:
		return invalid("unknown status")
	}
	if in.Timezone != "" {
		if _, err := time.LoadLocation(in.Timezone); err != nil {
			return invalid("unknown timezone")
		}
	}
	for _, it := range in.Checklist {
		if it.Text == "" || len(it.Text) > MaxTitleLen {
			return invalid("invalid checklist item")
		}
	}
	return nil
}

// ValidateDates checks that start and due form a valid pair: RFC 5545 wants
// the same value type and DUE not before DTSTART (FR-16). It wraps
// ErrInvalidInput. Updates skip it for dates the stored todo already has, so
// todos from other clients can still be completed.
func (in TodoInput) ValidateDates() error {
	if in.Start == nil || in.Due == nil {
		return nil
	}
	switch {
	case in.StartAllDay != in.DueAllDay:
		return invalid("start and due must both be dates or both have a time")
	case in.Start.After(*in.Due):
		return invalid("start must not be after due")
	}
	return nil
}

func invalid(msg string) error {
	return &ValidationError{Msg: msg}
}

// ValidationError describes invalid client input. errors.Is(err, ErrInvalidInput) is true.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return "invalid input: " + e.Msg }

// Is reports ErrInvalidInput as a match.
func (e *ValidationError) Is(target error) bool { return target == ErrInvalidInput }

// SnapshotKind tells which kind of resource a Snapshot was taken of, so an
// undo token of one kind never restores the other.
type SnapshotKind string

// The kinds of resource a Snapshot is taken of.
const (
	SnapshotTodo  SnapshotKind = "todo"
	SnapshotEvent SnapshotKind = "event"
)

// CreatedRef is a resource a write created, removed again by its undo.
type CreatedRef struct {
	ID, ETag string
	// MayStay says that the undo may leave the resource where it is, reported
	// as kept, when it changed since the write: a completed copy, a record of
	// the completion that stands on its own. Any other resource may not stay,
	// as it holds what the series restored holds again: the new series of a
	// split would show every repeat from the split on twice, a task a detach
	// made the detached occurrence. The undo is refused then, with nothing
	// written (FR-17).
	MayStay bool
}

// Snapshot captures a resource, a todo's or an event's, exactly as it was
// before a write, so that write can be undone (FR-17). It is kept in the undo
// store, keyed by a token handed to the client.
type Snapshot struct {
	Kind    SnapshotKind
	ID      string       // the changed resource (todo or event ID)
	ETag    string       // its ETag after the write: If-Match of the restore
	Data    []byte       // the resource exactly as read before the write
	Created []CreatedRef // resources the write created, e.g. a completed copy
	Account string       // origin + "\x00" + username
	TakenAt time.Time    // when the undo store took it in: stamped by the store, not by the service
}

// EventRestore answers an undo of a change to an event series (FR-17).
type EventRestore struct {
	ETag     string `json:"etag,omitempty"`     // the series' ETag after the restore, if the server tells it
	CopyKept bool   `json:"copyKept,omitempty"` // a resource the change created stays, as it changed during the restore
}

// FollowingResult answers a change of an occurrence of a series and the
// following ones ("this and following events", FR-17), see
// CalendarService.UpdateFollowing.
type FollowingResult struct {
	Event Event  // the edited occurrence, in the new series
	ETag  string // the old series' new ETag, "" when the server tells none
}

// CalendarService is bound to one account. Implementations must be safe for
// concurrent use.
type CalendarService interface {
	ListCalendars(ctx context.Context) ([]Calendar, error)

	// ListEvents returns all occurrences overlapping [start, end) with
	// recurring series expanded to that window.
	ListEvents(ctx context.Context, calendarID string, start, end time.Time) ([]Event, error)
	CreateEvent(ctx context.Context, calendarID string, in EventInput) (Event, error)
	// UpdateEvent replaces the event. etag must match (If-Match), otherwise
	// ErrConflict. An in.InstanceStart that is no longer an occurrence of the
	// series, neither an event of its rule nor one with an override, as in a
	// view not reloaded since the series ended or split before it, is
	// ErrConflict too, and nothing is written (FR-17, NFR-26). The change of a
	// series that was recurring before it, including one that removes the
	// rule, returns the snapshot that RestoreEvent undoes it with. A single
	// event, a series with an ORGANIZER or an ATTENDEE, and a change whose
	// new ETag the server does not tell, return nil: nothing could be
	// restored safely (FR-17).
	UpdateEvent(ctx context.Context, eventID, etag string, in EventInput) (Event, *Snapshot, error)
	// UpdateOccurrence changes only the occurrence at recurrenceID of a
	// recurring event ("only this event"), writing or editing an RFC 5545
	// override in the series' resource. etag must match (If-Match),
	// otherwise ErrConflict. It returns the snapshot that RestoreEvent undoes
	// the change with, or nil when the server does not tell the new ETag or
	// the series has an ORGANIZER or an ATTENDEE (FR-17).
	UpdateOccurrence(ctx context.Context, eventID, etag string, recurrenceID time.Time, in OccurrenceInput) (Event, *Snapshot, error)
	// RestoreEvent undoes a change of an event series by writing back the
	// resource as the change read it, unless the series changed since
	// (ErrConflict), and removes what the change created, the new series of
	// a split. Should that have changed since, or have an ETag unknown or
	// weak, nothing is written (ErrConflict): restored next to it, the
	// series would show its events twice. One gone since leaves nothing to
	// remove. Only one that changes between that check and its removal
	// stays, and the answer reports CopyKept (FR-17).
	RestoreEvent(ctx context.Context, snap Snapshot) (EventRestore, error)
	DeleteEvent(ctx context.Context, eventID, etag string) error
	// DeleteOccurrence excludes only the occurrence at recurrenceID of a
	// recurring event ("only this event"): an EXDATE, removing an existing
	// override at the same instant in the same write. It deletes the
	// resource itself once no occurrence of the series is left. It returns
	// the resource's new ETag, or "" once the resource is deleted or when
	// the server tells none, and the snapshot that RestoreEvent undoes the
	// change with: nil when the resource is deleted, since nothing is left
	// to restore, when the new ETag is unknown, or when the series has an
	// ORGANIZER or an ATTENDEE. etag must match
	// (If-Match), otherwise ErrConflict (FR-17).
	DeleteOccurrence(ctx context.Context, eventID, etag string, recurrenceID time.Time) (string, *Snapshot, error)
	// DeleteFollowing ends the recurring series eventID before its occurrence
	// at recurrenceID ("this and following events"): the series' rule gets an
	// end just before it, and its exceptions and overrides from there on go.
	// At the series' first event that is all events: the resource itself is
	// deleted. At a later one, the events before it are left. Its answer is
	// DeleteOccurrence's: the resource's new ETag, or "" once it is deleted
	// or when the server tells none, and the snapshot RestoreEvent undoes the
	// change with. A series it cannot split, see ErrSeriesSplitUnsupported,
	// is that error, and an occurrence ListEvents shows nowhere (an EXDATE, a
	// cancelled override) is ErrNotFound. etag must match (If-Match),
	// otherwise ErrConflict (FR-17).
	DeleteFollowing(ctx context.Context, eventID, etag string, recurrenceID time.Time) (string, *Snapshot, error)
	// UpdateFollowing changes the occurrence at recurrenceID of the recurring
	// series eventID and the following ones ("this and following events") as
	// a series of their own: the series ends before it, as DeleteFollowing
	// ends it, and a new series, a resource with a UID of its own, goes on
	// from it, changed as UpdateEvent changes all events of a series from
	// recurrenceID. in.InstanceStart is ignored, and in.RRule is the new
	// series' rule, except that the series' own rule as stored, sent
	// unchanged, keeps the rule the new series inherits, with its COUNT
	// lowered by the events before it. At the series' first event that is all
	// events: UpdateEvent with in.InstanceStart at recurrenceID. It returns
	// the edited occurrence, in the new series (in the series itself at its
	// first event), the series' new ETag, "" when the server tells none, and
	// the snapshot RestoreEvent undoes the change with, which also deletes the
	// new series: nil when the new ETag of either series is unknown. A series
	// DeleteFollowing refuses is refused alike, and a move the new series
	// cannot follow is ErrSeriesMoveUnsupported; nothing is written then.
	// etag must match (If-Match), otherwise ErrConflict (FR-17).
	UpdateFollowing(ctx context.Context, eventID, etag string, recurrenceID time.Time, in EventInput) (FollowingResult, *Snapshot, error)

	ListTodos(ctx context.Context, calendarID string) ([]Todo, error)
	// ListTodoOccurrences returns the occurrences of open, readable recurring
	// todos overlapping [start, end) (FR-16, FR-17).
	ListTodoOccurrences(ctx context.Context, calendarID string, start, end time.Time) ([]TodoOccurrence, error)
	CreateTodo(ctx context.Context, calendarID string, in TodoInput) (Todo, error)
	// UpdateTodo replaces the todo. etag must match (If-Match), otherwise
	// ErrConflict. A move of a series that its rule cannot follow is
	// ErrSeriesMoveUnsupported, and nothing is written. The change of a
	// recurring todo returns the snapshot that RestoreTodo undoes it with, or
	// nil when it cannot be undone (FR-17).
	UpdateTodo(ctx context.Context, todoID, etag string, in TodoInput) (Todo, *Snapshot, error)
	// RestoreTodo undoes a change of a todo by writing back the resource as
	// the change read it, unless the todo changed since (ErrConflict), and
	// removes the completed copy the change left, unless that changed since:
	// then it stays, and the todo reports CopyKept (FR-17).
	RestoreTodo(ctx context.Context, snap Snapshot) (Todo, error)
	DeleteTodo(ctx context.Context, todoID, etag string) error
}

// Provider connects users to their CalDAV server.
type Provider interface {
	// Connect performs auto-discovery (.well-known, DNS SRV) and verifies the
	// credentials. It returns ErrUnauthorized, ErrDiscovery,
	// ErrForbiddenTarget or ErrUpstream on failure.
	Connect(ctx context.Context, creds Credentials) (Account, error)
	// Service returns a CalendarService bound to the account. It is cheap;
	// shared state (cache, HTTP client) lives in the Provider.
	Service(acct Account) CalendarService
}
