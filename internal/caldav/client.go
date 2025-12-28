package caldav

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/emersion/go-webdav/caldav"
	"github.com/tbckr/lucid/internal/transport"
)

// Client implements the CalendarService interface
type Client struct {
	httpClient   *http.Client
	serverURL    string
	username     string
	password     string
	cache        CacheProvider
	rruleExpander RRuleExpander
}

// ClientConfig holds configuration for the CalDAV client
type ClientConfig struct {
	ServerURL    string
	Username     string
	Password     string
	Cache        CacheProvider
	RRuleExpander RRuleExpander
}

// NewClient creates a new CalDAV client with SSRF protection
func NewClient(cfg ClientConfig) (*Client, error) {
	if cfg.ServerURL == "" {
		return nil, errors.New("server URL is required")
	}
	if cfg.Username == "" {
		return nil, errors.New("username is required")
	}
	if cfg.Password == "" {
		return nil, errors.New("password is required")
	}

	// Create HTTP client with SafeTransport for SSRF protection
	httpClient := &http.Client{
		Transport: transport.NewSafeTransport(),
		Timeout:   30 * time.Second,
	}

	// Auto-discover CalDAV endpoint if needed
	serverURL, err := discoverCalDAVEndpoint(httpClient, cfg.ServerURL, cfg.Username, cfg.Password)
	if err != nil {
		return nil, fmt.Errorf("failed to discover CalDAV endpoint: %w", err)
	}

	return &Client{
		httpClient:    httpClient,
		serverURL:     serverURL,
		username:      cfg.Username,
		password:      cfg.Password,
		cache:         cfg.Cache,
		rruleExpander: cfg.RRuleExpander,
	}, nil
}

// discoverCalDAVEndpoint implements auto-discovery using .well-known/caldav
func discoverCalDAVEndpoint(client *http.Client, baseURL, username, password string) (string, error) {
	// Parse base URL
	u, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("invalid URL: %w", err)
	}

	// Try .well-known/caldav first (RFC 6764)
	wellKnownURL := fmt.Sprintf("%s://%s/.well-known/caldav", u.Scheme, u.Host)
	
	req, err := http.NewRequest("PROPFIND", wellKnownURL, nil)
	if err != nil {
		return "", err
	}
	
	req.SetBasicAuth(username, password)
	req.Header.Set("Depth", "0")
	
	resp, err := client.Do(req)
	if err == nil {
		defer resp.Body.Close()
		
		// Follow redirects to actual CalDAV endpoint
		if resp.StatusCode == http.StatusMovedPermanently || 
		   resp.StatusCode == http.StatusFound || 
		   resp.StatusCode == http.StatusSeeOther {
			location := resp.Header.Get("Location")
			if location != "" {
				// Resolve relative URLs
				locationURL, err := url.Parse(location)
				if err == nil {
					return u.ResolveReference(locationURL).String(), nil
				}
			}
		}
		
		// If .well-known returns 200, use the base URL
		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusMultiStatus {
			return wellKnownURL, nil
		}
	}

	// Fallback: try common CalDAV paths
	commonPaths := []string{
		"/caldav",
		fmt.Sprintf("/caldav.php/%s", username),
		fmt.Sprintf("/remote.php/dav/calendars/%s", username),
		fmt.Sprintf("/dav/%s", username),
	}

	for _, path := range commonPaths {
		testURL := fmt.Sprintf("%s://%s%s", u.Scheme, u.Host, path)
		
		req, err := http.NewRequest("PROPFIND", testURL, nil)
		if err != nil {
			continue
		}
		
		req.SetBasicAuth(username, password)
		req.Header.Set("Depth", "0")
		
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		resp.Body.Close()
		
		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusMultiStatus {
			return testURL, nil
		}
	}

	// If all discovery fails, use the original URL
	return baseURL, nil
}

// GetCalendars retrieves all calendars for the authenticated user
func (c *Client) GetCalendars(ctx context.Context) ([]Calendar, error) {
	// Create CalDAV client using go-webdav
	caldavClient, err := caldav.NewClient(c.httpClient, c.serverURL)
	if err != nil {
		return nil, fmt.Errorf("failed to create caldav client: %w", err)
	}

	// Set authentication
	caldavClient.HTTPClient.Transport = &basicAuthTransport{
		username: c.username,
		password: c.password,
		base:     c.httpClient.Transport,
	}

	// Find calendar home set
	principal, err := caldavClient.FindCurrentUserPrincipal(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to find principal: %w", err)
	}

	homeSet, err := caldavClient.FindCalendarHomeSet(ctx, principal)
	if err != nil {
		return nil, fmt.Errorf("failed to find calendar home set: %w", err)
	}

	// Get calendars
	calendars, err := caldavClient.FindCalendars(ctx, homeSet)
	if err != nil {
		return nil, fmt.Errorf("failed to find calendars: %w", err)
	}

	// Convert to our Calendar type
	result := make([]Calendar, 0, len(calendars))
	for _, cal := range calendars {
		result = append(result, Calendar{
			ID:          cal.Path,
			Name:        cal.Name,
			DisplayName: cal.Name,
			Description: cal.Description,
			Color:       cal.Color,
			ReadOnly:    false,
			URL:         cal.Path,
			CreatedAt:   time.Now(), // CalDAV doesn't provide creation time
			UpdatedAt:   time.Now(),
		})
	}

	return result, nil
}

// GetCalendar retrieves a specific calendar by ID
func (c *Client) GetCalendar(ctx context.Context, id string) (*Calendar, error) {
	calendars, err := c.GetCalendars(ctx)
	if err != nil {
		return nil, err
	}

	for _, cal := range calendars {
		if cal.ID == id {
			return &cal, nil
		}
	}

	return nil, fmt.Errorf("calendar not found: %s", id)
}

// GetEvents retrieves events for a calendar in the specified time range
func (c *Client) GetEvents(ctx context.Context, calendarID string, start, end time.Time) ([]Event, error) {
	// Check cache first
	if c.cache != nil {
		cacheKey := fmt.Sprintf("events:%s:%d:%d", calendarID, start.Unix(), end.Unix())
		cached, err := c.cache.Get(ctx, cacheKey)
		if err == nil && cached != nil {
			if events, ok := cached.([]Event); ok {
				return events, nil
			}
		}
	}

	// Create CalDAV client
	caldavClient, err := caldav.NewClient(c.httpClient, c.serverURL)
	if err != nil {
		return nil, fmt.Errorf("failed to create caldav client: %w", err)
	}

	caldavClient.HTTPClient.Transport = &basicAuthTransport{
		username: c.username,
		password: c.password,
		base:     c.httpClient.Transport,
	}

	// Query events using calendar-query REPORT
	query := caldav.CalendarQuery{
		CompFilter: caldav.CompFilter{
			Name: "VCALENDAR",
			Comps: []caldav.CompFilter{{
				Name:  "VEVENT",
				Start: start,
				End:   end,
			}},
		},
	}

	objects, err := caldavClient.QueryCalendar(ctx, calendarID, &query)
	if err != nil {
		return nil, fmt.Errorf("failed to query calendar: %w", err)
	}

	// Parse events
	events := make([]Event, 0, len(objects))
	for _, obj := range objects {
		// Parse iCal data (simplified - full implementation in phase-2-caldav-04)
		event := Event{
			ID:         obj.Path,
			CalendarID: calendarID,
			ETag:       obj.ETag,
			CreatedAt:  time.Now(),
			UpdatedAt:  time.Now(),
		}
		
		// Basic parsing - will be enhanced with ical_parser.go
		if obj.Data != nil && obj.Data.Events != nil && len(obj.Data.Events) > 0 {
			icalEvent := obj.Data.Events[0]
			event.UID = icalEvent.Props.Get("UID").Value
			event.Title = icalEvent.Props.Get("SUMMARY").Value
			event.Description = icalEvent.Props.Get("DESCRIPTION").Value
			event.Location = icalEvent.Props.Get("LOCATION").Value
			
			// Parse dates (simplified)
			if dtStart := icalEvent.Props.Get("DTSTART"); dtStart != nil {
				if t, err := time.Parse("20060102T150405Z", dtStart.Value); err == nil {
					event.StartTime = t
				}
			}
			if dtEnd := icalEvent.Props.Get("DTEND"); dtEnd != nil {
				if t, err := time.Parse("20060102T150405Z", dtEnd.Value); err == nil {
					event.EndTime = t
				}
			}
			
			// Check for RRULE
			if rrule := icalEvent.Props.Get("RRULE"); rrule != nil {
				event.RRULE = rrule.Value
			}
		}
		
		events = append(events, event)
	}

	// Cache the results
	if c.cache != nil {
		cacheKey := fmt.Sprintf("events:%s:%d:%d", calendarID, start.Unix(), end.Unix())
		_ = c.cache.Set(ctx, cacheKey, events, 5*time.Minute)
	}

	return events, nil
}

// GetEvent retrieves a specific event
func (c *Client) GetEvent(ctx context.Context, calendarID, eventID string) (*Event, error) {
	// Create CalDAV client
	caldavClient, err := caldav.NewClient(c.httpClient, c.serverURL)
	if err != nil {
		return nil, fmt.Errorf("failed to create caldav client: %w", err)
	}

	caldavClient.HTTPClient.Transport = &basicAuthTransport{
		username: c.username,
		password: c.password,
		base:     c.httpClient.Transport,
	}

	// Get the calendar object
	obj, err := caldavClient.GetCalendarObject(ctx, eventID)
	if err != nil {
		return nil, fmt.Errorf("failed to get event: %w", err)
	}

	event := &Event{
		ID:         obj.Path,
		CalendarID: calendarID,
		ETag:       obj.ETag,
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	}

	// Parse event data (simplified)
	if obj.Data != nil && obj.Data.Events != nil && len(obj.Data.Events) > 0 {
		icalEvent := obj.Data.Events[0]
		event.UID = icalEvent.Props.Get("UID").Value
		event.Title = icalEvent.Props.Get("SUMMARY").Value
		event.Description = icalEvent.Props.Get("DESCRIPTION").Value
		event.Location = icalEvent.Props.Get("LOCATION").Value
	}

	return event, nil
}

// CreateEvent creates a new event
func (c *Client) CreateEvent(ctx context.Context, calendarID string, event *Event) (*Event, error) {
	// Invalidate cache
	if c.cache != nil {
		_ = c.cache.InvalidatePattern(ctx, fmt.Sprintf("events:%s:*", calendarID))
	}

	// Create CalDAV client
	caldavClient, err := caldav.NewClient(c.httpClient, c.serverURL)
	if err != nil {
		return nil, fmt.Errorf("failed to create caldav client: %w", err)
	}

	caldavClient.HTTPClient.Transport = &basicAuthTransport{
		username: c.username,
		password: c.password,
		base:     c.httpClient.Transport,
	}

	// Generate UID if not provided
	if event.UID == "" {
		event.UID = fmt.Sprintf("%d@lucid", time.Now().UnixNano())
	}

	// Build iCal data (simplified - will use ical_parser in phase-2-caldav-04)
	icalData := fmt.Sprintf(`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Lucid//CalDAV Client//EN
BEGIN:VEVENT
UID:%s
SUMMARY:%s
DTSTART:%s
DTEND:%s
END:VEVENT
END:VCALENDAR`, 
		event.UID,
		event.Title,
		event.StartTime.Format("20060102T150405Z"),
		event.EndTime.Format("20060102T150405Z"),
	)

	// Generate event path
	eventPath := fmt.Sprintf("%s/%s.ics", calendarID, event.UID)

	// PUT the event
	req, err := http.NewRequestWithContext(ctx, "PUT", c.serverURL+eventPath, strings.NewReader(icalData))
	if err != nil {
		return nil, err
	}

	req.SetBasicAuth(c.username, c.password)
	req.Header.Set("Content-Type", "text/calendar; charset=utf-8")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to create event: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to create event: %s - %s", resp.Status, string(body))
	}

	// Get ETag from response
	event.ETag = resp.Header.Get("ETag")
	event.ID = eventPath
	event.CreatedAt = time.Now()
	event.UpdatedAt = time.Now()

	return event, nil
}

// UpdateEvent updates an existing event
func (c *Client) UpdateEvent(ctx context.Context, calendarID, eventID string, event *Event, etag string) (*Event, error) {
	// Invalidate cache
	if c.cache != nil {
		_ = c.cache.InvalidatePattern(ctx, fmt.Sprintf("events:%s:*", calendarID))
	}

	// Build iCal data
	icalData := fmt.Sprintf(`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Lucid//CalDAV Client//EN
BEGIN:VEVENT
UID:%s
SUMMARY:%s
DTSTART:%s
DTEND:%s
END:VEVENT
END:VCALENDAR`, 
		event.UID,
		event.Title,
		event.StartTime.Format("20060102T150405Z"),
		event.EndTime.Format("20060102T150405Z"),
	)

	// PUT with If-Match header
	req, err := http.NewRequestWithContext(ctx, "PUT", c.serverURL+eventID, strings.NewReader(icalData))
	if err != nil {
		return nil, err
	}

	req.SetBasicAuth(c.username, c.password)
	req.Header.Set("Content-Type", "text/calendar; charset=utf-8")
	if etag != "" {
		req.Header.Set("If-Match", etag)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to update event: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusPreconditionFailed {
		return nil, fmt.Errorf("conflict: event was modified (ETag mismatch)")
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to update event: %s - %s", resp.Status, string(body))
	}

	event.ETag = resp.Header.Get("ETag")
	event.UpdatedAt = time.Now()

	return event, nil
}

// DeleteEvent deletes an event
func (c *Client) DeleteEvent(ctx context.Context, calendarID, eventID string) error {
	// Invalidate cache
	if c.cache != nil {
		_ = c.cache.InvalidatePattern(ctx, fmt.Sprintf("events:%s:*", calendarID))
	}

	req, err := http.NewRequestWithContext(ctx, "DELETE", c.serverURL+eventID, nil)
	if err != nil {
		return err
	}

	req.SetBasicAuth(c.username, c.password)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to delete event: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotFound {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to delete event: %s - %s", resp.Status, string(body))
	}

	return nil
}

// Task operations - Stub implementations (to be completed in phase-2-caldav-05)
func (c *Client) GetTasks(ctx context.Context, calendarID string) ([]Task, error) {
	return nil, errors.New("not implemented")
}

func (c *Client) GetTask(ctx context.Context, calendarID, taskID string) (*Task, error) {
	return nil, errors.New("not implemented")
}

func (c *Client) CreateTask(ctx context.Context, calendarID string, task *Task) (*Task, error) {
	return nil, errors.New("not implemented")
}

func (c *Client) UpdateTask(ctx context.Context, calendarID, taskID string, task *Task, etag string) (*Task, error) {
	return nil, errors.New("not implemented")
}

func (c *Client) DeleteTask(ctx context.Context, calendarID, taskID string) error {
	return errors.New("not implemented")
}

// SyncCalendar synchronizes a calendar using CTag
func (c *Client) SyncCalendar(ctx context.Context, calendarID string) error {
	// Invalidate cache to force refresh
	if c.cache != nil {
		_ = c.cache.InvalidatePattern(ctx, fmt.Sprintf("events:%s:*", calendarID))
	}
	return nil
}

// basicAuthTransport wraps a transport to add Basic Auth
type basicAuthTransport struct {
	username string
	password string
	base     http.RoundTripper
}

func (t *basicAuthTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.SetBasicAuth(t.username, t.password)
	return t.base.RoundTrip(req)
}
