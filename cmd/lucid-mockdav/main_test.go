package main

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tbckr/lucid/internal/caldav"
	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

func TestSeedTime(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 27, 18, 30, 0, 0, time.UTC)
	for _, tc := range []struct {
		name, value string
		want        time.Time
		wantErr     bool
	}{
		{name: "unset uses now", value: "", want: now},
		{name: "fixed date", value: "2026-03-11", want: time.Date(2026, 3, 11, 0, 0, 0, 0, time.UTC)},
		{name: "not a date", value: "tomorrow", wantErr: true},
		{name: "date with time", value: "2026-03-11T10:00:00Z", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := seedTime(tc.value, now)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("seedTime(%q) = %v, want an error", tc.value, got)
				}
				return
			}
			if err != nil || !got.Equal(tc.want) {
				t.Fatalf("seedTime(%q) = %v, %v, want %v", tc.value, got, err, tc.want)
			}
		})
	}
}

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
	if events < 10 || todos != 5 {
		t.Fatalf("events=%d todos=%d", events, todos)
	}
}
