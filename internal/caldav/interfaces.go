package caldav

import (
	"context"
	"time"
)

// Event represents a calendar event
type Event struct {
	ID          string    `json:"id"`
	UID         string    `json:"uid"`
	CalendarID  string    `json:"calendar_id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Location    string    `json:"location"`
	StartTime   time.Time `json:"start_time"`
	EndTime     time.Time `json:"end_time"`
	AllDay      bool      `json:"all_day"`
	Timezone    string    `json:"timezone,omitempty"`
	RRULE       string    `json:"rrule,omitempty"`
	EXDATE      string    `json:"exdate,omitempty"`
	ETag        string    `json:"etag,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// Calendar represents a calendar collection
type Calendar struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	DisplayName string    `json:"display_name"`
	Description string    `json:"description"`
	Color       string    `json:"color"`
	Timezone    string    `json:"timezone"`
	ReadOnly    bool      `json:"read_only"`
	CTag        string    `json:"ctag,omitempty"`
	URL         string    `json:"url"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// Task represents a TODO item (VTODO)
type Task struct {
	ID          string    `json:"id"`
	UID         string    `json:"uid"`
	CalendarID  string    `json:"calendar_id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	DueDate     time.Time `json:"due_date,omitempty"`
	Priority    int       `json:"priority"`        // 0-9, 0 = undefined
	Status      string    `json:"status"`          // NEEDS-ACTION, IN-PROCESS, COMPLETED, CANCELLED
	Completed   bool      `json:"completed"`
	PercentDone int       `json:"percent_done"`    // 0-100
	ETag        string    `json:"etag,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// CalendarService defines the interface for CalDAV operations
type CalendarService interface {
	// Calendar operations
	GetCalendars(ctx context.Context) ([]Calendar, error)
	GetCalendar(ctx context.Context, id string) (*Calendar, error)
	
	// Event operations
	GetEvents(ctx context.Context, calendarID string, start, end time.Time) ([]Event, error)
	GetEvent(ctx context.Context, calendarID, eventID string) (*Event, error)
	CreateEvent(ctx context.Context, calendarID string, event *Event) (*Event, error)
	UpdateEvent(ctx context.Context, calendarID, eventID string, event *Event, etag string) (*Event, error)
	DeleteEvent(ctx context.Context, calendarID, eventID string) error
	
	// Task operations
	GetTasks(ctx context.Context, calendarID string) ([]Task, error)
	GetTask(ctx context.Context, calendarID, taskID string) (*Task, error)
	CreateTask(ctx context.Context, calendarID string, task *Task) (*Task, error)
	UpdateTask(ctx context.Context, calendarID, taskID string, task *Task, etag string) (*Task, error)
	DeleteTask(ctx context.Context, calendarID, taskID string) error
	
	// Sync operations
	SyncCalendar(ctx context.Context, calendarID string) error
}

// CacheProvider defines the caching interface
type CacheProvider interface {
	Get(ctx context.Context, key string) (interface{}, error)
	Set(ctx context.Context, key string, value interface{}, ttl time.Duration) error
	Invalidate(ctx context.Context, key string) error
	InvalidatePattern(ctx context.Context, pattern string) error
}

// RRuleExpander expands recurring rules
type RRuleExpander interface {
	Expand(rrule string, startTime time.Time, endTime time.Time, exceptions []string) ([]time.Time, error)
}
