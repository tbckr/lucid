package diag

import (
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestScope(t *testing.T) {
	t.Parallel()
	b := NewBuffer(AnonymousLimits)
	ctx := WithScope(context.Background(), Scope{Buffer: b, RequestID: "req-1"})

	got, ok := ScopeFrom(ctx)
	if !ok || got.Buffer != b || got.RequestID != "req-1" {
		t.Errorf("ScopeFrom = %+v, %v, want the scope that was set", got, ok)
	}

	if got, ok := ScopeFrom(context.Background()); ok || got != (Scope{}) {
		t.Errorf("ScopeFrom(Background) = %+v, %v, want the zero scope and false", got, ok)
	}

	// An inner scope shadows the outer one, and a child context keeps it.
	inner := WithScope(ctx, Scope{RequestID: "req-2"})
	type key struct{}
	child := context.WithValue(inner, key{}, 1)
	if got, ok := ScopeFrom(child); !ok || got.RequestID != "req-2" || got.Buffer != nil {
		t.Errorf("ScopeFrom(child of inner) = %+v, %v, want the inner scope", got, ok)
	}
}

func TestBuildReport(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 20, 14, 0, 0, 0, time.FixedZone("CEST", 2*60*60))
	lucid := LucidInfo{Version: "1.2.3", Mode: "server", OS: "linux", Arch: "amd64"}
	acct := &AccountInfo{Endpoint: "https://dav.example/", Principal: "/principals/{user}/", Home: "/calendars/{user}/"}
	snap := Snapshot{
		Exchanges: []Exchange{
			{Host: "old.example", Server: "OldServer/1", DAV: "1"},
			{Host: "dav.example", Server: "Radicale/3", DAV: "1, 2, calendar-access"},
			{Host: "other.example", Server: "", DAV: "1, 3"},
		},
		Problems:  []Problem{{Kind: ProblemInvalidObject, Reason: "r"}},
		Calendars: []CalendarNote{{Path: "c", Events: true}},
	}

	r := BuildReport(snap, lucid, acct, true, now)

	if r.Format != 1 {
		t.Errorf("Format = %d, want 1", r.Format)
	}
	if !r.CreatedAt.Equal(now) || r.CreatedAt.Location() != time.UTC {
		t.Errorf("CreatedAt = %v, want the same instant as %v, in UTC", r.CreatedAt, now)
	}
	if r.Lucid != lucid {
		t.Errorf("Lucid = %+v, want %+v", r.Lucid, lucid)
	}
	if !r.Authenticated {
		t.Error("Authenticated = false, want true")
	}
	// Product and Host come from the newest exchange with a Server header, DAV
	// from the newest one with a DAV header, which is a later one here.
	if want := (ServerInfo{Host: "dav.example", Product: "Radicale/3", DAV: "1, 3"}); r.Server != want {
		t.Errorf("Server = %+v, want %+v", r.Server, want)
	}
	if r.Account == nil || *r.Account != *acct {
		t.Errorf("Account = %+v, want %+v", r.Account, acct)
	}
	if !reflect.DeepEqual(r.Exchanges, snap.Exchanges) || !reflect.DeepEqual(r.Problems, snap.Problems) || !reflect.DeepEqual(r.Calendars, snap.Calendars) {
		t.Errorf("report does not carry the snapshot: %+v", r)
	}

	// The DAV header may come from an exchange older than the Server header.
	r = BuildReport(Snapshot{Exchanges: []Exchange{{Host: "a", DAV: "1, 2"}, {Host: "b", Server: "nginx"}, {Host: "c"}}}, lucid, nil, false, now)
	if want := (ServerInfo{Host: "b", Product: "nginx", DAV: "1, 2"}); r.Server != want {
		t.Errorf("Server = %+v, want %+v", r.Server, want)
	}

	// No exchange names a server: Host is the newest exchange's that has one,
	// Product stays empty, and DAV is still seen.
	r = BuildReport(Snapshot{Exchanges: []Exchange{{Host: "old", DAV: "1"}, {Host: "h"}, {Error: "dns"}}}, lucid, nil, false, now)
	if want := (ServerInfo{Host: "h", DAV: "1"}); r.Server != want {
		t.Errorf("Server = %+v, want %+v", r.Server, want)
	}
	// An exchange without a host is no fallback.
	r = BuildReport(Snapshot{Exchanges: []Exchange{{Error: "dns"}}}, lucid, nil, false, now)
	if r.Server != (ServerInfo{}) {
		t.Errorf("Server = %+v, want none", r.Server)
	}
	if r.Authenticated || r.Account != nil {
		t.Errorf("Authenticated = %v, Account = %+v, want false and nil", r.Authenticated, r.Account)
	}
}

func TestBuildReportEmptyMarshalsArrays(t *testing.T) {
	t.Parallel()
	r := BuildReport(NewBuffer(AnonymousLimits).Snapshot(), LucidInfo{}, nil, false, time.Unix(0, 0).UTC())
	data, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{`"exchanges":[]`, `"problems":[]`, `"calendars":[]`} {
		if !strings.Contains(text, want) {
			t.Errorf("empty report %s lacks %s", text, want)
		}
	}
	if strings.Contains(text, `"account"`) {
		t.Errorf("empty report %s has an account, want none", text)
	}

	// The same holds for a zero Snapshot.
	data, err = json.Marshal(BuildReport(Snapshot{}, LucidInfo{}, nil, false, time.Time{}))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"exchanges":[]`, `"problems":[]`, `"calendars":[]`} {
		if !strings.Contains(string(data), want) {
			t.Errorf("report of a zero snapshot %s lacks %s", data, want)
		}
	}
}

// keysOf marshals v and returns the sorted keys of the JSON object.
func keysOf(t *testing.T, v any) []string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

func TestJSONNames(t *testing.T) {
	t.Parallel()
	at := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		v    any
		want []string
	}{
		{
			"exchange",
			Exchange{At: at, RequestID: "r", Method: "PROPFIND", Host: "h", Path: "/", Status: 207, DurationMS: 12, Bytes: 34, ContentType: "c", Server: "s", DAV: "d", Error: "e"},
			[]string{"at", "bytes", "contentType", "dav", "durationMs", "error", "host", "method", "path", "requestId", "server", "status"},
		},
		{"exchange without optional fields", Exchange{At: at}, []string{"at", "bytes", "durationMs"}},
		{
			"problem",
			Problem{At: at, RequestID: "r", Kind: ProblemInvalidXML, Path: "p", ObjectID: "o", Reason: "x", Skeleton: Skeleton{Text: "t"}},
			[]string{"at", "kind", "objectId", "path", "reason", "requestId", "skeleton"},
		},
		{"problem without object", Problem{At: at}, []string{"at", "kind", "path", "reason", "requestId", "skeleton"}},
		{"calendar note", CalendarNote{}, []string{"ctag", "events", "objects", "path", "readOnly", "syncToken", "todos"}},
		{"lucid", LucidInfo{}, []string{"arch", "mode", "os", "version"}},
		{"server", ServerInfo{}, []string{"dav", "host", "product"}},
		{"account", AccountInfo{}, []string{"endpoint", "home", "principal"}},
		{
			"report",
			BuildReport(Snapshot{}, LucidInfo{}, &AccountInfo{}, true, at),
			[]string{"account", "authenticated", "calendars", "createdAt", "exchanges", "format", "lucid", "problems", "server"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := keysOf(t, tt.v); !slices.Equal(got, tt.want) {
				t.Errorf("keys = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestProblemKinds(t *testing.T) {
	t.Parallel()
	for kind, want := range map[ProblemKind]string{
		ProblemUnparsableObject: "unparsable_object",
		ProblemInvalidObject:    "invalid_object",
		ProblemInvalidXML:       "invalid_xml",
		ProblemErrorResponse:    "error_response",
		ProblemRejectedWrite:    "rejected_write",
	} {
		if string(kind) != want {
			t.Errorf("kind %q, want %q", kind, want)
		}
	}
	data, err := json.Marshal(Problem{Kind: ProblemRejectedWrite})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"kind":"rejected_write"`) {
		t.Errorf("Problem marshals as %s, want kind rejected_write", data)
	}
}
