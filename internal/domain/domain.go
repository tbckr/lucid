// Package domain holds the types and service interfaces shared between the
// HTTP layer and the CalDAV integration. It has no dependencies on either, so
// both sides can be developed and tested in isolation (dependency injection).
package domain

import (
	"context"
	"errors"
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
	Due         *time.Time      `json:"due,omitempty"`
	DueAllDay   bool            `json:"dueAllDay"`
	Priority    int             `json:"priority"` // 0 = undefined, 1 = highest ... 9 = lowest
	Status      string          `json:"status"`
	Completed   *time.Time      `json:"completed,omitempty"`
}

// TodoInput is the payload for creating or updating a todo.
type TodoInput struct {
	Title       string          `json:"title"`
	Description string          `json:"description,omitempty"`
	Checklist   []ChecklistItem `json:"checklist"`
	Due         *time.Time      `json:"due,omitempty"`
	DueAllDay   bool            `json:"dueAllDay"`
	Priority    int             `json:"priority"`
	Status      string          `json:"status"` // empty means NEEDS-ACTION
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
	}
	switch in.Status {
	case "", TodoNeedsAction, TodoInProcess, TodoCompleted, TodoCancelled:
	default:
		return invalid("unknown status")
	}
	for _, it := range in.Checklist {
		if it.Text == "" || len(it.Text) > MaxTitleLen {
			return invalid("invalid checklist item")
		}
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
	CreateTodo(ctx context.Context, calendarID string, in TodoInput) (Todo, error)
	UpdateTodo(ctx context.Context, todoID, etag string, in TodoInput) (Todo, error)
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
