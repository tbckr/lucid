package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tbckr/lucid/internal/domain"
	"github.com/tbckr/lucid/internal/middleware"
	"github.com/tbckr/lucid/internal/session"
)

// fakeProvider implements domain.Provider.
type fakeProvider struct {
	mu       sync.Mutex
	connect  func(domain.Credentials) (domain.Account, error)
	gotCreds domain.Credentials
	gotAcct  domain.Account
	svc      *fakeService
}

func (p *fakeProvider) Connect(_ context.Context, creds domain.Credentials) (domain.Account, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.gotCreds = creds
	if p.connect != nil {
		return p.connect(creds)
	}
	return domain.Account{
		Username: creds.Username, Password: creds.Password, ServerURL: creds.ServerURL,
		EndpointURL: "https://dav.example.com/",
	}, nil
}

func (p *fakeProvider) Service(acct domain.Account) domain.CalendarService {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.gotAcct = acct
	return p.svc
}

// fakeService implements domain.CalendarService. If err is set, every
// method returns it.
type fakeService struct {
	mu          sync.Mutex
	err         error
	panicMsg    string
	calendars   []domain.Calendar
	events      []domain.Event
	todos       []domain.Todo
	occurrences []domain.TodoOccurrence
	// updateTodoResult overrides UpdateTodo's default response, if set.
	updateTodoResult *domain.Todo
	// updateTodoSnapshot is returned as UpdateTodo's snapshot, if set.
	updateTodoSnapshot *domain.Snapshot
	// occurrenceETag and followingETag are the ETags DeleteOccurrence and
	// DeleteFollowing return: "" as for a deleted resource.
	occurrenceETag, followingETag string
	// updateEventSnapshot, occurrenceSnapshot, deleteOccurrenceSnapshot,
	// deleteFollowingSnapshot and updateFollowingSnapshot are returned as the
	// snapshot of UpdateEvent, UpdateOccurrence, DeleteOccurrence,
	// DeleteFollowing and UpdateFollowing, if set.
	updateEventSnapshot, occurrenceSnapshot, deleteOccurrenceSnapshot, deleteFollowingSnapshot,
	updateFollowingSnapshot *domain.Snapshot
	// detachTodoSnapshot and skipTodoSnapshot are returned as the snapshot
	// of DetachTodoOccurrence and SkipTodoOccurrence, if set.
	detachTodoSnapshot, skipTodoSnapshot *domain.Snapshot
	// updateTodoFollowingSnapshot and deleteTodoFollowingSnapshot are
	// returned as the snapshot of UpdateTodoFollowing and
	// DeleteTodoFollowing, if set.
	updateTodoFollowingSnapshot, deleteTodoFollowingSnapshot *domain.Snapshot
	// todoFollowingDeleted makes DeleteTodoFollowing answer as for a
	// resource it deleted: a zero Todo.
	todoFollowingDeleted bool

	calls    []string
	gotCal   string
	gotID    string
	gotETag  string
	gotStart time.Time
	gotEnd   time.Time
	gotEvent domain.EventInput
	gotTodo  domain.TodoInput
	gotSnap  domain.Snapshot
	gotRID   time.Time
	gotOcc   domain.OccurrenceInput
	// gotRevalidate is whether the last list call's context asked to
	// revalidate the cache (domain.Revalidation).
	gotRevalidate bool
}

func (f *fakeService) record(name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	if f.panicMsg != "" {
		panic(f.panicMsg)
	}
	return f.err
}

func (f *fakeService) ListCalendars(context.Context) ([]domain.Calendar, error) {
	if err := f.record("ListCalendars"); err != nil {
		return nil, err
	}
	return f.calendars, nil
}

func (f *fakeService) ListEvents(ctx context.Context, cal string, start, end time.Time) ([]domain.Event, error) {
	f.mu.Lock()
	f.gotCal, f.gotStart, f.gotEnd, f.gotRevalidate = cal, start, end, domain.Revalidation(ctx)
	f.mu.Unlock()
	if err := f.record("ListEvents"); err != nil {
		return nil, err
	}
	return f.events, nil
}

func (f *fakeService) CreateEvent(_ context.Context, cal string, in domain.EventInput) (domain.Event, error) {
	f.mu.Lock()
	f.gotCal, f.gotEvent = cal, in
	f.mu.Unlock()
	if err := f.record("CreateEvent"); err != nil {
		return domain.Event{}, err
	}
	return domain.Event{ID: "new", CalendarID: cal, Title: in.Title, ETag: `"1"`}, nil
}

func (f *fakeService) UpdateEvent(_ context.Context, id, etag string, in domain.EventInput) (domain.Event, *domain.Snapshot, error) {
	f.mu.Lock()
	f.gotID, f.gotETag, f.gotEvent = id, etag, in
	snap := f.updateEventSnapshot
	f.mu.Unlock()
	if err := f.record("UpdateEvent"); err != nil {
		return domain.Event{}, nil, err
	}
	return domain.Event{ID: id, Title: in.Title, ETag: `"2"`}, snap, nil
}

func (f *fakeService) UpdateOccurrence(_ context.Context, id, etag string, rid time.Time, in domain.OccurrenceInput) (domain.Event, *domain.Snapshot, error) {
	f.mu.Lock()
	f.gotID, f.gotETag, f.gotRID, f.gotOcc = id, etag, rid, in
	snap := f.occurrenceSnapshot
	f.mu.Unlock()
	if err := f.record("UpdateOccurrence"); err != nil {
		return domain.Event{}, nil, err
	}
	return domain.Event{ID: id, Title: in.Title, ETag: `"3"`}, snap, nil
}

func (f *fakeService) RestoreEvent(_ context.Context, snap domain.Snapshot) (domain.EventRestore, error) {
	f.mu.Lock()
	f.gotSnap = snap
	f.mu.Unlock()
	if err := f.record("RestoreEvent"); err != nil {
		return domain.EventRestore{}, err
	}
	return domain.EventRestore{ETag: `"9"`}, nil
}

func (f *fakeService) DeleteEvent(_ context.Context, id, etag string) error {
	f.mu.Lock()
	f.gotID, f.gotETag = id, etag
	f.mu.Unlock()
	return f.record("DeleteEvent")
}

func (f *fakeService) DeleteOccurrence(_ context.Context, id, etag string, rid time.Time) (string, *domain.Snapshot, error) {
	f.mu.Lock()
	f.gotID, f.gotETag, f.gotRID = id, etag, rid
	next, snap := f.occurrenceETag, f.deleteOccurrenceSnapshot
	f.mu.Unlock()
	if err := f.record("DeleteOccurrence"); err != nil {
		return "", nil, err
	}
	return next, snap, nil
}

func (f *fakeService) DeleteFollowing(_ context.Context, id, etag string, rid time.Time) (string, *domain.Snapshot, error) {
	f.mu.Lock()
	f.gotID, f.gotETag, f.gotRID = id, etag, rid
	next, snap := f.followingETag, f.deleteFollowingSnapshot
	f.mu.Unlock()
	if err := f.record("DeleteFollowing"); err != nil {
		return "", nil, err
	}
	return next, snap, nil
}

// UpdateFollowing answers with the edited event in a new series "n1" and the
// old series' new ETag "4".
func (f *fakeService) UpdateFollowing(_ context.Context, id, etag string, rid time.Time, in domain.EventInput) (domain.FollowingResult, *domain.Snapshot, error) {
	f.mu.Lock()
	f.gotID, f.gotETag, f.gotRID, f.gotEvent = id, etag, rid, in
	snap := f.updateFollowingSnapshot
	f.mu.Unlock()
	if err := f.record("UpdateFollowing"); err != nil {
		return domain.FollowingResult{}, nil, err
	}
	return domain.FollowingResult{Event: domain.Event{ID: "n1", Title: in.Title, ETag: `"n"`}, ETag: `"4"`}, snap, nil
}

func (f *fakeService) ListTodos(ctx context.Context, cal string) ([]domain.Todo, error) {
	f.mu.Lock()
	f.gotCal, f.gotRevalidate = cal, domain.Revalidation(ctx)
	f.mu.Unlock()
	if err := f.record("ListTodos"); err != nil {
		return nil, err
	}
	return f.todos, nil
}

func (f *fakeService) ListTodoOccurrences(ctx context.Context, cal string, start, end time.Time) ([]domain.TodoOccurrence, error) {
	f.mu.Lock()
	f.gotCal, f.gotStart, f.gotEnd, f.gotRevalidate = cal, start, end, domain.Revalidation(ctx)
	f.mu.Unlock()
	if err := f.record("ListTodoOccurrences"); err != nil {
		return nil, err
	}
	return f.occurrences, nil
}

func (f *fakeService) CreateTodo(_ context.Context, cal string, in domain.TodoInput) (domain.Todo, error) {
	f.mu.Lock()
	f.gotCal, f.gotTodo = cal, in
	f.mu.Unlock()
	if err := f.record("CreateTodo"); err != nil {
		return domain.Todo{}, err
	}
	return domain.Todo{ID: "t-new", CalendarID: cal, Title: in.Title}, nil
}

func (f *fakeService) UpdateTodo(_ context.Context, id, etag string, in domain.TodoInput) (domain.Todo, *domain.Snapshot, error) {
	f.mu.Lock()
	f.gotID, f.gotETag, f.gotTodo = id, etag, in
	snap := f.updateTodoSnapshot
	f.mu.Unlock()
	if err := f.record("UpdateTodo"); err != nil {
		return domain.Todo{}, nil, err
	}
	if f.updateTodoResult != nil {
		return *f.updateTodoResult, snap, nil
	}
	return domain.Todo{ID: id, Title: in.Title, Checklist: in.Checklist}, snap, nil
}

func (f *fakeService) RestoreTodo(_ context.Context, snap domain.Snapshot) (domain.Todo, error) {
	f.mu.Lock()
	f.gotSnap = snap
	f.mu.Unlock()
	if err := f.record("RestoreTodo"); err != nil {
		return domain.Todo{}, err
	}
	return domain.Todo{ID: snap.ID}, nil
}

func (f *fakeService) DeleteTodo(_ context.Context, id, etag string) error {
	f.mu.Lock()
	f.gotID, f.gotETag = id, etag
	f.mu.Unlock()
	return f.record("DeleteTodo")
}

// DetachTodoOccurrence answers with the rolled series and the detached copy
// "t-copy", which has the input's title.
func (f *fakeService) DetachTodoOccurrence(_ context.Context, id, etag string, rid time.Time, in domain.TodoInput) (domain.Todo, *domain.Snapshot, error) {
	f.mu.Lock()
	f.gotID, f.gotETag, f.gotRID, f.gotTodo = id, etag, rid, in
	snap := f.detachTodoSnapshot
	f.mu.Unlock()
	if err := f.record("DetachTodoOccurrence"); err != nil {
		return domain.Todo{}, nil, err
	}
	return domain.Todo{
		ID: id, Title: "Series", ETag: `"6"`, Recurring: true,
		DetachedCopy: &domain.Todo{ID: "t-copy", Title: in.Title, ETag: `"c"`, DetachedFrom: "series-uid"},
	}, snap, nil
}

// SkipTodoOccurrence answers with the rolled series.
func (f *fakeService) SkipTodoOccurrence(_ context.Context, id, etag string, rid time.Time) (domain.Todo, *domain.Snapshot, error) {
	f.mu.Lock()
	f.gotID, f.gotETag, f.gotRID = id, etag, rid
	snap := f.skipTodoSnapshot
	f.mu.Unlock()
	if err := f.record("SkipTodoOccurrence"); err != nil {
		return domain.Todo{}, nil, err
	}
	return domain.Todo{ID: id, Title: "Series", ETag: `"7"`, Recurring: true}, snap, nil
}

// UpdateTodoFollowing answers with the new series "t-new", which has the
// input's title, and the old series as written.
func (f *fakeService) UpdateTodoFollowing(_ context.Context, id, etag string, rid time.Time, in domain.TodoInput) (domain.TodoFollowing, *domain.Snapshot, error) {
	f.mu.Lock()
	f.gotID, f.gotETag, f.gotRID, f.gotTodo = id, etag, rid, in
	snap := f.updateTodoFollowingSnapshot
	f.mu.Unlock()
	if err := f.record("UpdateTodoFollowing"); err != nil {
		return domain.TodoFollowing{}, nil, err
	}
	return domain.TodoFollowing{
		Todo:   domain.Todo{ID: "t-new", Title: in.Title, ETag: `"n"`, Recurring: true},
		Series: domain.Todo{ID: id, Title: "Series", ETag: `"8"`, Recurring: true},
	}, snap, nil
}

// DeleteTodoFollowing answers with the series as written, or with a zero
// Todo where todoFollowingDeleted is set.
func (f *fakeService) DeleteTodoFollowing(_ context.Context, id, etag string, rid time.Time) (domain.Todo, *domain.Snapshot, error) {
	f.mu.Lock()
	f.gotID, f.gotETag, f.gotRID = id, etag, rid
	snap, deleted := f.deleteTodoFollowingSnapshot, f.todoFollowingDeleted
	f.mu.Unlock()
	if err := f.record("DeleteTodoFollowing"); err != nil {
		return domain.Todo{}, nil, err
	}
	if deleted {
		return domain.Todo{}, nil, nil
	}
	return domain.Todo{ID: id, Title: "Series", ETag: `"9"`, Recurring: true}, snap, nil
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type harness struct {
	srv   *Server
	store *session.Store
	prov  *fakeProvider
	svc   *fakeService
	logs  *syncBuffer
	clock *clock
}

func newHarness(t *testing.T, mod func(*Options)) *harness {
	t.Helper()
	h := &harness{
		svc:   &fakeService{},
		logs:  &syncBuffer{},
		clock: &clock{now: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)},
	}
	h.prov = &fakeProvider{svc: h.svc}
	store, err := session.New(session.Options{Key: bytes.Repeat([]byte{9}, 32), Now: h.clock.Now})
	if err != nil {
		t.Fatal(err)
	}
	h.store = store
	logger := slog.New(slog.NewJSONHandler(h.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	sec, err := middleware.NewSecurity(logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	opts := Options{Provider: h.prov, Sessions: store, Logger: logger, Security: sec}
	if mod != nil {
		mod(&opts)
	}
	h.srv, err = New(opts)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// client is a minimal browser: it keeps the session cookie and CSRF token.
type client struct {
	cookie string
	csrf   string
}

type req struct {
	method  string
	path    string
	body    string
	headers map[string]string
	noCSRF  bool
}

func (h *harness) do(t *testing.T, c *client, rq req) *httptest.ResponseRecorder {
	t.Helper()
	body := io.Reader(http.NoBody)
	if rq.body != "" {
		body = strings.NewReader(rq.body)
	}
	r := httptest.NewRequest(rq.method, rq.path, body)
	if rq.body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if c != nil {
		if c.cookie != "" {
			r.AddCookie(&http.Cookie{Name: CookieName, Value: c.cookie})
		}
		if c.csrf != "" && !rq.noCSRF {
			r.Header.Set(middleware.CSRFHeader, c.csrf)
		}
	}
	for k, v := range rq.headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.srv.ServeHTTP(w, r)
	if c != nil {
		for _, ck := range w.Result().Cookies() {
			if ck.Name == CookieName {
				c.cookie = ck.Value
			}
		}
	}
	return w
}

// anonymous returns a client holding an anonymous session.
func (h *harness) anonymous(t *testing.T) *client {
	t.Helper()
	c := &client{}
	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/session"})
	var resp sessionResponse
	decode(t, w, http.StatusOK, &resp)
	c.csrf = resp.CSRFToken
	return c
}

const loginBody = `{"serverUrl":"https://dav.example.com","username":"tim","password":"hunter2-secret"}`

// login returns an authenticated client.
func (h *harness) login(t *testing.T) *client {
	t.Helper()
	c := h.anonymous(t)
	w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/auth/login", body: loginBody})
	var resp sessionResponse
	decode(t, w, http.StatusOK, &resp)
	c.csrf = resp.CSRFToken
	return c
}

func decode(t *testing.T, w *httptest.ResponseRecorder, wantStatus int, v any) {
	t.Helper()
	if w.Code != wantStatus {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, wantStatus, w.Body)
	}
	if v == nil {
		return
	}
	if err := json.Unmarshal(w.Body.Bytes(), v); err != nil {
		t.Fatalf("decoding %q: %v", w.Body, err)
	}
}

func expectError(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var e middleware.ErrorBody
	decode(t, w, status, &e)
	if e.Error.Code != code {
		t.Fatalf("error code = %q, want %q (message %q)", e.Error.Code, code, e.Error.Message)
	}
}
