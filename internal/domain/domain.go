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
	// update is applied to the whole series, shifting the series by
	// (Start - InstanceStart) and setting the duration to End - Start.
	InstanceStart *time.Time `json:"instanceStart,omitempty"`
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
	// one, or nil if this is the last. MoveWindow bounds a move of the
	// current occurrence; nil when a move is free, and for a series that is
	// completed, cancelled or ruleUnsupported. CompletedCopy is the
	// just-completed occurrence, returned only by the PUT that completes it,
	// so the client can show it alongside the advanced series without a
	// refetch.
	RRule           string      `json:"rrule"`
	Recurring       bool        `json:"recurring"`
	FixedDays       bool        `json:"fixedDays"`
	RuleUnsupported bool        `json:"ruleUnsupported"`
	Next            *TodoDates  `json:"next"`
	MoveWindow      *MoveWindow `json:"moveWindow"`
	CompletedCopy   *Todo       `json:"completedCopy,omitempty"`
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

// MoveWindow is where a move of a series' current occurrence must keep its
// anchor (start, else due), [From, Until), by the rule's days in the series'
// zone (FR-17): a series on fixed days keeps its later repeats on their days,
// so its current one stays from the day of its own RECURRENCE-ID to before
// the day of the next one's. Those are the rule's days, which differ from
// Start and Next's dates when another client moved those occurrences. A
// current occurrence off the rule moves alone, in any series: it stays
// before the next one the same way, but has no day of its own to stay from
// (From nil). When the current occurrence is all-day, From and Until are
// dates at midnight UTC, as all-day dates are written.
type MoveWindow struct {
	From  *time.Time `json:"from"`  // start of the current occurrence's rule day, series zone; nil for an occurrence off the rule
	Until *time.Time `json:"until"` // start of next's rule day; next's instant if on the same day; nil for the last repeat
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

// TodoSnapshot captures a todo's resource exactly as it was before a write,
// so that write can be undone (FR-17). It is kept in the undo store, keyed by
// a token handed to the client.
type TodoSnapshot struct {
	TodoID   string // master ID
	ETag     string // master ETag after the write: If-Match of the restore
	Data     []byte // the resource exactly as read before the write
	CopyID   string // completed copy created by the write, "" if none
	CopyETag string
	Account  string // origin + "\x00" + username
	TakenAt  time.Time
}

// CalendarService is bound to one account. Implementations must be safe for
// concurrent use.
type CalendarService interface {
	ListCalendars(ctx context.Context) ([]Calendar, error)

	// ListEvents returns all occurrences overlapping [start, end) with
	// recurring series expanded to that window.
	ListEvents(ctx context.Context, calendarID string, start, end time.Time) ([]Event, error)
	CreateEvent(ctx context.Context, calendarID string, in EventInput) (Event, error)
	// UpdateEvent replaces the event. etag must match (If-Match), otherwise ErrConflict.
	UpdateEvent(ctx context.Context, eventID, etag string, in EventInput) (Event, error)
	DeleteEvent(ctx context.Context, eventID, etag string) error

	ListTodos(ctx context.Context, calendarID string) ([]Todo, error)
	// ListTodoOccurrences returns the occurrences of open, readable recurring
	// todos overlapping [start, end) (FR-16, FR-17).
	ListTodoOccurrences(ctx context.Context, calendarID string, start, end time.Time) ([]TodoOccurrence, error)
	CreateTodo(ctx context.Context, calendarID string, in TodoInput) (Todo, error)
	// UpdateTodo replaces the todo. etag must match (If-Match), otherwise
	// ErrConflict. The change of a recurring todo returns the snapshot that
	// RestoreTodo undoes it with, or nil when it cannot be undone (FR-17).
	UpdateTodo(ctx context.Context, todoID, etag string, in TodoInput) (Todo, *TodoSnapshot, error)
	// RestoreTodo undoes a change of a todo by writing back the resource as
	// the change read it, unless the todo changed since (ErrConflict), and
	// removes the completed copy the change left, unless that changed since:
	// then it stays, and the todo reports CopyKept (FR-17).
	RestoreTodo(ctx context.Context, snap TodoSnapshot) (Todo, error)
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
