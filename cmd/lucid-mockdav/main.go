// Command lucid-mockdav serves an in-memory CalDAV server with demo data for
// local development and end-to-end tests.
//
// Login with user "demo" and password "demo". The server listens on
// LUCID_MOCKDAV_ADDR (default 127.0.0.1:5232). Because it runs on a loopback
// address over plain HTTP, Lucid must be started with
//
//	LUCID_ALLOW_PRIVATE_NETWORKS=true LUCID_COOKIE_INSECURE=true
//
// to be able to reach it and to accept the session cookie without TLS.
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
	mock := caldavtest.New(caldavtest.Options{Username: "demo", Password: "demo"})
	if err := seed(mock, time.Now()); err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           mock,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	fmt.Printf("lucid-mockdav listening on http://%s/ (login: demo / demo)\n", addr)
	fmt.Println("start Lucid with LUCID_ALLOW_PRIVATE_NETWORKS=true LUCID_COOKIE_INSECURE=true")

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
	return wrap("VEVENT", uid, summary, lines)
}

func vtodo(uid, summary string, lines ...string) string {
	return wrap("VTODO", uid, summary, lines)
}

func wrap(comp, uid, summary string, lines []string) string {
	all := append([]string{
		"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lucid//mockdav//EN",
		"BEGIN:" + comp, "UID:" + uid, dtstamp, "SUMMARY:" + summary,
	}, lines...)
	all = append(all, "END:"+comp, "END:VCALENDAR", "")
	return strings.Join(all, "\r\n")
}
