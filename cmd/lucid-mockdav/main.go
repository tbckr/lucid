// Command lucid-mockdav serves an in-memory CalDAV server with demo data for
// local development and end-to-end tests.
//
// Login with user "demo" and password "demo". The server listens on
// LUCID_MOCKDAV_ADDR (default 127.0.0.1:5232). The demo data lies around
// today, or around LUCID_MOCKDAV_NOW (a date such as 2026-03-11) for
// reproducible screenshots. Lucid reaches it in local mode (leave LUCID_ADDR
// unset), which allows loopback CalDAV servers and plain-HTTP cookies; no
// further configuration is needed.
//
// A second account, for a forced logout (FR-36), lives below /revoked/: server
// URL http://127.0.0.1:5232/revoked/, user and password "revoked". Its server
// answers every GET of an object with 403, as one does whose permissions were
// taken away during a session, and its calendar has an event whose rule Lucid
// cannot evaluate, a problem whose content the report offers: showing that
// content reads the object, and the 403 signs the session out.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
)

func main() {
	if err := run(); err != nil {
		slog.Error("lucid-mockdav failed", "error", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	addr := os.Getenv("LUCID_MOCKDAV_ADDR")
	if addr == "" {
		addr = "127.0.0.1:5232"
	}
	now, err := seedTime(os.Getenv("LUCID_MOCKDAV_NOW"), time.Now())
	if err != nil {
		return err
	}
	handler, err := newHandler(now)
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	fmt.Printf("lucid-mockdav listening on http://%s/ (login: demo / demo)\n", addr)
	fmt.Println("Lucid reaches it in local mode: start it without LUCID_ADDR")

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}

// revokedPrefix is the path the account of a forced logout lives below.
const revokedPrefix = "/revoked"

// newHandler serves the demo account, seeded around now, and below
// revokedPrefix the account of a forced logout.
func newHandler(now time.Time) (http.Handler, error) {
	demo := caldavtest.New(caldavtest.Options{Username: "demo", Password: "demo"})
	if err := seed(demo, now); err != nil {
		return nil, err
	}
	revoked, err := newRevoked(now)
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle(revokedPrefix+"/", revoked)
	mux.Handle("/", demo)
	return mux, nil
}

// newRevoked returns the account of a forced logout: a calendar with an event
// and one whose rule Lucid cannot evaluate (it shows the first occurrence and
// records a problem), on a server that refuses every GET with 403.
func newRevoked(now time.Time) (*caldavtest.Server, error) {
	m := caldavtest.New(caldavtest.Options{Username: "revoked", Password: "revoked", Prefix: revokedPrefix})
	shared := m.AddCalendar(caldavtest.Calendar{Slug: "shared", Name: "Shared", Color: "#8B5CF6FF", Components: []string{"VEVENT"}})
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	utc := func(h int) string { return day.Add(time.Duration(h) * time.Hour).Format("20060102T150405Z") }
	for _, o := range []struct{ name, body string }{
		{"plan.ics", vevent("revoked-plan", "Shared plan", "DTSTART:"+utc(10), "DTEND:"+utc(11))},
		{"rule.ics", vevent("revoked-rule", "Unknown rule", "DTSTART:"+utc(12), "DTEND:"+utc(13), "RRULE:FREQ=FORTNIGHTLY")},
	} {
		if _, err := m.PutObject(shared, o.name, o.body); err != nil {
			return nil, err
		}
	}
	m.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method != http.MethodGet {
			return false
		}
		http.Error(w, "forbidden", http.StatusForbidden)
		return true
	})
	return m, nil
}

// seedTime returns the date in value (YYYY-MM-DD), or now if value is empty.
func seedTime(value string, now time.Time) (time.Time, error) {
	if value == "" {
		return now, nil
	}
	t, err := time.Parse(time.DateOnly, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("LUCID_MOCKDAV_NOW: %w", err)
	}
	return t, nil
}

// seed adds demo calendars and objects around now.
func seed(m *caldavtest.Server, now time.Time) error {
	personal := m.AddCalendar(caldavtest.Calendar{Slug: "personal", Name: "Personal", Color: "#3B82F6FF", Components: []string{"VEVENT"}})
	work := m.AddCalendar(caldavtest.Calendar{Slug: "work", Name: "Work", Color: "#22C55EFF", Components: []string{"VEVENT"}})
	tasks := m.AddCalendar(caldavtest.Calendar{Slug: "tasks", Name: "Tasks", Color: "#F97316FF", Components: []string{"VTODO"}})

	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	date := func(d int) string { return day.AddDate(0, 0, d).Format("20060102") }
	utc := func(d, h, mi int) string {
		return day.AddDate(0, 0, d).Add(time.Duration(h)*time.Hour + time.Duration(mi)*time.Minute).Format("20060102T150405Z")
	}
	// Local wall time in Europe/Berlin for the recurring events.
	local := func(d, h, mi int) string {
		return day.AddDate(0, 0, d).Add(time.Duration(h)*time.Hour + time.Duration(mi)*time.Minute).Format("20060102T150405")
	}
	monday := -int(day.Weekday()+6) % 7

	objects := []struct{ cal, name, body string }{
		{personal, "dentist.ics", vevent("demo-dentist", "Dentist", "DTSTART:"+utc(1, 8, 30), "DTEND:"+utc(1, 9, 30), "LOCATION:Main Street 1")},
		{personal, "birthday.ics", vevent("demo-birthday", "Anna's birthday", "DTSTART;VALUE=DATE:"+date(3), "DTEND;VALUE=DATE:"+date(4))},
		{personal, "trip.ics", vevent("demo-trip", "Weekend trip", "DTSTART;VALUE=DATE:"+date(9), "DTEND;VALUE=DATE:"+date(12))},
		{personal, "gym.ics", vevent("demo-gym", "Gym",
			"DTSTART;TZID=Europe/Berlin:"+local(monday, 18, 0), "DTEND;TZID=Europe/Berlin:"+local(monday, 19, 0),
			"RRULE:FREQ=WEEKLY;BYDAY=MO,TH")},
		{work, "standup.ics", vevent("demo-standup", "Standup",
			"DTSTART;TZID=Europe/Berlin:"+local(monday-14, 9, 0), "DTEND;TZID=Europe/Berlin:"+local(monday-14, 9, 15),
			"RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")},
		{work, "review.ics", vevent("demo-review", "Quarterly review", "DTSTART:"+utc(2, 13, 0), "DTEND:"+utc(2, 15, 0), "DESCRIPTION:Slides in the shared folder.")},
		{work, "offsite.ics", vevent("demo-offsite", "Team offsite", "DTSTART;VALUE=DATE:"+date(-2), "DTEND;VALUE=DATE:"+date(0))},
		{tasks, "milk.ics", vtodo("demo-milk", "Buy milk", "DUE;VALUE=DATE:"+date(1), "PRIORITY:1", "DESCRIPTION:Oat milk\\n\\n- [ ] 2 liters\\n- [x] check fridge")},
		{tasks, "taxes.ics", vtodo("demo-taxes", "File taxes", "DUE:"+utc(14, 17, 0), "PRIORITY:5", "STATUS:IN-PROCESS")},
		{tasks, "plants.ics", vtodo("demo-plants", "Water plants", "STATUS:COMPLETED", "COMPLETED:"+utc(-1, 10, 0), "PERCENT-COMPLETE:100")},
		// Starts after the standup, so the week view has room for its title.
		{tasks, "slides.ics", vtodo("demo-slides", "Prepare slides", "DTSTART:"+utc(2, 9, 0), "DUE:"+utc(2, 10, 0))},
		{tasks, "landlord.ics", vtodo("demo-landlord", "Call the landlord", "DUE:"+utc(0, 15, 0))},
		// Repeating tasks (FR-17) as other clients write them: on fixed days, with this
		// Monday's repeat completed by an override (Thunderbird) ...
		{tasks, "flowers.ics", calendar(
			component("VTODO", "demo-flowers", "Water the flowers",
				"DTSTART;VALUE=DATE:"+date(monday), "DUE;VALUE=DATE:"+date(monday), "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"),
			component("VTODO", "demo-flowers", "Water the flowers",
				"RECURRENCE-ID;VALUE=DATE:"+date(monday), "DTSTART;VALUE=DATE:"+date(monday), "DUE;VALUE=DATE:"+date(monday),
				"STATUS:COMPLETED", "COMPLETED:"+utc(monday, 8, 0), "PERCENT-COMPLETE:100"),
		)},
		// ... and every other week from a due date alone, without DTSTART (Tasks.org).
		{tasks, "trash.ics", vtodo("demo-trash", "Take out the trash",
			"DUE;TZID=Europe/Berlin:"+local(monday+3, 19, 0), "RRULE:FREQ=WEEKLY;INTERVAL=2")},
	}
	for _, o := range objects {
		if _, err := m.PutObject(o.cal, o.name, o.body); err != nil {
			return err
		}
	}
	return nil
}

const dtstamp = "DTSTAMP:20250101T000000Z"

func vevent(uid, summary string, lines ...string) string {
	return calendar(component("VEVENT", uid, summary, lines...))
}

func vtodo(uid, summary string, lines ...string) string {
	return calendar(component("VTODO", uid, summary, lines...))
}

// calendar wraps components, such as a master and its overrides, in one VCALENDAR.
func calendar(components ...[]string) string {
	all := []string{"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lucid//mockdav//EN"}
	for _, c := range components {
		all = append(all, c...)
	}
	all = append(all, "END:VCALENDAR", "")
	return strings.Join(all, "\r\n")
}

// component returns the lines of one component with UID, DTSTAMP and SUMMARY.
func component(comp, uid, summary string, lines ...string) []string {
	all := append([]string{"BEGIN:" + comp, "UID:" + uid, dtstamp, "SUMMARY:" + summary}, lines...)
	return append(all, "END:"+comp)
}
