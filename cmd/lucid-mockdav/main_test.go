package main

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tbckr/lucid/internal/caldav"
	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

// TestSeed connects the real provider to the seeded mock server.
func TestSeed(t *testing.T) {
	t.Parallel()
	now := time.Now()
	mock := caldavtest.New(caldavtest.Options{Username: "demo", Password: "demo"})
	if err := seed(mock, now); err != nil {
		t.Fatalf("seed: %v", err)
	}
	ts := httptest.NewServer(mock)
	t.Cleanup(ts.Close)

	p, err := caldav.NewProvider(caldav.Options{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	acct, err := p.Connect(ctx, domain.Credentials{ServerURL: ts.URL, Username: "demo", Password: "demo"})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	svc := p.Service(acct)
	cals, err := svc.ListCalendars(ctx)
	if err != nil || len(cals) != 3 {
		t.Fatalf("ListCalendars = %+v, %v", cals, err)
	}
	var events, todos int
	for _, c := range cals {
		if c.SupportsEvents {
			evs, err := svc.ListEvents(ctx, c.ID, now.AddDate(0, 0, -7), now.AddDate(0, 0, 14))
			if err != nil {
				t.Fatalf("ListEvents(%s): %v", c.Name, err)
			}
			events += len(evs)
		}
		if c.SupportsTodos {
			ts, err := svc.ListTodos(ctx, c.ID)
			if err != nil {
				t.Fatalf("ListTodos(%s): %v", c.Name, err)
			}
			for _, td := range ts {
				if td.Title == "Buy milk" && len(td.Checklist) != 2 {
					t.Errorf("checklist not parsed: %+v", td)
				}
			}
			todos += len(ts)
		}
	}
	if events < 10 || todos != 3 {
		t.Fatalf("events=%d todos=%d", events, todos)
	}
}
