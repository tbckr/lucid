package session

import (
	"bytes"
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/tbckr/lucid/internal/diag"
	"github.com/tbckr/lucid/internal/domain"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *fakeClock {
	return &fakeClock{now: time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

var testKey = bytes.Repeat([]byte{0x42}, KeySize)

func newStore(t *testing.T, mod func(*Options)) (*Store, *fakeClock) {
	t.Helper()
	clk := newClock()
	opts := Options{Key: testKey, TTL: 12 * time.Hour, IdleTimeout: 2 * time.Hour, Now: clk.Now}
	if mod != nil {
		mod(&opts)
	}
	s, err := New(opts)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return s, clk
}

var acct = domain.Account{
	Username:        "tim",
	Password:        "s3cr3t-p4ssw0rd",
	ServerURL:       "example.com",
	EndpointURL:     "https://dav.example.com/",
	PrincipalURL:    "https://dav.example.com/principals/tim/",
	CalendarHomeURL: "https://dav.example.com/calendars/tim/",
}

func TestNewValidatesKey(t *testing.T) {
	t.Parallel()
	for _, n := range []int{0, 16, 31, 33} {
		if _, err := New(Options{Key: make([]byte, n)}); err == nil {
			t.Errorf("New() with %d-byte key: want error", n)
		}
	}
	s, err := New(Options{Key: testKey})
	if err != nil {
		t.Fatal(err)
	}
	if s.opts.TTL != DefaultTTL || s.opts.IdleTimeout != DefaultIdleTimeout ||
		s.opts.AnonymousTTL != DefaultAnonymousTTL || s.opts.MaxAnonymous != DefaultMaxAnonymous ||
		s.opts.MaxSessions != DefaultMaxSessions || s.opts.Now == nil {
		t.Errorf("defaults not applied: %+v", s.opts)
	}
}

func TestNewGeneratesKey(t *testing.T) {
	t.Parallel()
	s, err := New(Options{})
	if err != nil {
		t.Fatalf("New() without key: %v", err)
	}
	if len(s.opts.Key) != KeySize {
		t.Fatalf("generated key is %d bytes, want %d", len(s.opts.Key), KeySize)
	}
	if bytes.Equal(s.opts.Key, make([]byte, KeySize)) {
		t.Error("generated key is all zeros")
	}
	other, err := New(Options{})
	if err != nil {
		t.Fatalf("second New() without key: %v", err)
	}
	if bytes.Equal(s.opts.Key, other.opts.Key) {
		t.Error("two stores generated the same key")
	}
	acct := domain.Account{Username: "u", Password: "p", ServerURL: "https://dav.example/"}
	sess, err := s.Login("", acct) // seal with the generated key …
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Account(sess.ID) // … and open again
	if err != nil || got != acct {
		t.Fatalf("Account() = %+v, %v", got, err)
	}
}

func TestCreateAndGet(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)
	sess, err := s.Create()
	if err != nil {
		t.Fatal(err)
	}
	if len(sess.ID) != 43 || len(sess.CSRFToken) != 43 {
		t.Errorf("id/token length = %d/%d, want 43 (256 bit base64url)", len(sess.ID), len(sess.CSRFToken))
	}
	if sess.Authenticated {
		t.Error("new session must be anonymous")
	}
	if want := clk.Now().Add(DefaultAnonymousTTL); !sess.ExpiresAt.Equal(want) {
		t.Errorf("ExpiresAt = %v, want %v", sess.ExpiresAt, want)
	}
	got, err := s.Get(sess.ID)
	if err != nil || got != sess {
		t.Fatalf("Get() = %+v, %v; want %+v", got, err, sess)
	}
	if _, err := s.Account(sess.ID); !errors.Is(err, ErrNotAuthenticated) {
		t.Errorf("Account() of anonymous session error = %v", err)
	}
	other, _ := s.Create()
	if other.ID == sess.ID || other.CSRFToken == sess.CSRFToken {
		t.Error("IDs/tokens must be unique")
	}
}

func TestGetInvalidIDs(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, nil)
	for _, id := range []string{"", "short", strings.Repeat("a", 42), strings.Repeat("a", 44), strings.Repeat("!", 43), strings.Repeat("a", 43)} {
		if _, err := s.Get(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Get(%q) error = %v, want ErrNotFound", id, err)
		}
		if _, err := s.Account(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Account(%q) error = %v, want ErrNotFound", id, err)
		}
	}
}

func TestCheckCSRF(t *testing.T) {
	t.Parallel()
	sess := Session{CSRFToken: "abc"}
	tests := []struct {
		token string
		want  bool
	}{
		{"abc", true},
		{"abd", false},
		{"ab", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := sess.CheckCSRF(tt.token); got != tt.want {
			t.Errorf("CheckCSRF(%q) = %v, want %v", tt.token, got, tt.want)
		}
	}
	if (Session{}).CheckCSRF("") {
		t.Error("empty tokens must never match")
	}
}

func TestLoginRotatesAndEncrypts(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)
	anon, _ := s.Create()

	sess, err := s.Login(anon.ID, acct)
	if err != nil {
		t.Fatal(err)
	}
	if sess.ID == anon.ID || sess.CSRFToken == anon.CSRFToken {
		t.Error("login must rotate ID and CSRF token")
	}
	if !sess.Authenticated || sess.Username != "tim" || sess.ServerURL != "example.com" {
		t.Errorf("session = %+v", sess)
	}
	if want := clk.Now().Add(12 * time.Hour); !sess.ExpiresAt.Equal(want) {
		t.Errorf("ExpiresAt = %v, want %v", sess.ExpiresAt, want)
	}
	if _, err := s.Get(anon.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("old session still valid: %v", err)
	}
	if s.anon.Len() != 0 {
		t.Errorf("anonymous list not cleaned: %d", s.anon.Len())
	}
	got, err := s.Account(sess.ID)
	if err != nil || got != acct {
		t.Fatalf("Account() = %+v, %v", got, err)
	}

	// The password must not be stored in clear text anywhere in the entry.
	e := s.sessions[hashID(sess.ID)]
	if bytes.Contains(e.sealed, []byte(acct.Password)) {
		t.Error("password stored in clear text")
	}
	// Raw session IDs are not used as map keys.
	for k := range s.sessions {
		if bytes.Contains(k[:], []byte(sess.ID)) {
			t.Error("raw ID stored")
		}
	}
}

func TestCiphertextBoundToSessionID(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, nil)
	a, _ := s.Login("", acct)
	other := acct
	other.Username = "mallory"
	b, _ := s.Login("", other)

	// Swap the sealed blobs: AAD (session ID) must make decryption fail.
	ea, eb := s.sessions[hashID(a.ID)], s.sessions[hashID(b.ID)]
	ea.sealed, eb.sealed = eb.sealed, ea.sealed
	if _, err := s.Account(a.ID); err == nil {
		t.Error("ciphertext moved between sessions still decrypts")
	}

	// A different key cannot decrypt either.
	s2, _ := newStore(t, func(o *Options) { o.Key = bytes.Repeat([]byte{1}, KeySize) })
	c, _ := s.Login("", acct)
	s2.sessions[hashID(c.ID)] = s.sessions[hashID(c.ID)]
	if _, err := s2.Account(c.ID); err == nil {
		t.Error("decrypted with wrong key")
	}
}

func TestCorruptPlaintext(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, nil)
	sess, _ := s.Login("", acct)
	e := s.sessions[hashID(sess.ID)]
	ns := s.aead.NonceSize()
	e.sealed = s.aead.Seal(e.sealed[:ns:ns], e.sealed[:ns], []byte("not json"), []byte(sess.ID))
	if _, err := s.Account(sess.ID); err == nil || !strings.Contains(err.Error(), "decoding") {
		t.Errorf("Account() error = %v", err)
	}
}

func TestExpiry(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		anon  bool
		steps []time.Duration // advance, then Get (must succeed) ...
		final time.Duration   // ... finally advance and expect ErrExpired
	}{
		{"idle", false, nil, 2 * time.Hour},
		{"idle refreshed", false, []time.Duration{time.Hour, time.Hour, time.Hour}, 2 * time.Hour},
		{"absolute", false, []time.Duration{110 * time.Minute, 110 * time.Minute, 110 * time.Minute, 110 * time.Minute, 110 * time.Minute, 110 * time.Minute}, 60 * time.Minute},
		{"anonymous ttl", true, []time.Duration{10 * time.Minute}, 5 * time.Minute},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			s, clk := newStore(t, nil)
			var sess Session
			if tt.anon {
				sess, _ = s.Create()
			} else {
				sess, _ = s.Login("", acct)
			}
			for i, d := range tt.steps {
				clk.Advance(d)
				if _, err := s.Get(sess.ID); err != nil {
					t.Fatalf("step %d: Get() error = %v", i, err)
				}
			}
			clk.Advance(tt.final)
			if _, err := s.Account(sess.ID); !errors.Is(err, ErrExpired) {
				t.Fatalf("Account() error = %v, want ErrExpired", err)
			}
			if _, err := s.Get(sess.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("second Get() error = %v, want ErrNotFound (removed)", err)
			}
		})
	}
}

func TestAnonymousCap(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, func(o *Options) { o.MaxAnonymous = 3 })
	auth, _ := s.Login("", acct)
	var ids []string
	for range 5 {
		sess, err := s.Create()
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, sess.ID)
	}
	if s.Len() != 4 {
		t.Errorf("Len() = %d, want 3 anonymous + 1 authenticated", s.Len())
	}
	for i, id := range ids {
		_, err := s.Get(id)
		if evicted := i < 2; evicted != errors.Is(err, ErrNotFound) {
			t.Errorf("session %d: err = %v, evicted = %v", i, err, evicted)
		}
	}
	if _, err := s.Get(auth.ID); err != nil {
		t.Errorf("authenticated session evicted: %v", err)
	}
}

func TestMaxSessions(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, func(o *Options) { o.MaxSessions = 2 })
	a, _ := s.Login("", acct)
	if _, err := s.Login("", acct); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Login("", acct); !errors.Is(err, ErrFull) {
		t.Errorf("Login() error = %v, want ErrFull", err)
	}
	if _, err := s.Create(); !errors.Is(err, ErrFull) {
		t.Errorf("Create() error = %v, want ErrFull", err)
	}
	// Rotating an existing session frees its slot first.
	if _, err := s.Login(a.ID, acct); err != nil {
		t.Errorf("Login() with rotation error = %v", err)
	}
}

func TestDeleteAndCleanup(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)
	a, _ := s.Login("", acct)
	b, _ := s.Create()
	s.Delete(a.ID)
	s.Delete("unknown")
	if _, err := s.Get(a.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleted session still valid: %v", err)
	}
	c, _ := s.Login("", acct)
	clk.Advance(20 * time.Minute) // anonymous b expires, c still valid
	if n := s.Cleanup(); n != 1 {
		t.Errorf("Cleanup() = %d, want 1", n)
	}
	if _, err := s.Get(b.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("anonymous session not cleaned: %v", err)
	}
	if _, err := s.Get(c.ID); err != nil {
		t.Errorf("valid session removed: %v", err)
	}
	if s.anon.Len() != 0 {
		t.Errorf("anon list len = %d", s.anon.Len())
	}
}

func TestRunJanitor(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		s, clk := newStore(t, nil)
		_, _ = s.Create()
		clk.Advance(time.Hour)

		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan struct{})
		go func() {
			s.Run(ctx, time.Minute)
			close(done)
		}()
		time.Sleep(90 * time.Second) // fake time inside the bubble
		synctest.Wait()
		if s.Len() != 0 {
			t.Errorf("janitor did not clean up: Len() = %d", s.Len())
		}
		cancel()
		<-done
	})
}

func TestConcurrentAccess(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, func(o *Options) { o.MaxAnonymous = 50 })
	var wg sync.WaitGroup
	for i := range 16 {
		wg.Go(func() {
			for j := range 100 {
				anon, err := s.Create()
				if err != nil {
					t.Error(err)
					return
				}
				_, _ = s.Get(anon.ID)
				sess, err := s.Login(anon.ID, acct)
				if err != nil {
					t.Error(err)
					return
				}
				if got, err := s.Account(sess.ID); err != nil || got != acct {
					t.Errorf("Account() = %+v, %v", got, err)
				}
				if buf, err := s.Diagnostics(sess.ID); err != nil {
					t.Errorf("Diagnostics() error = %v", err)
				} else {
					buf.AddExchange(diag.Exchange{RequestID: "r"})
				}
				switch (i + j) % 3 {
				case 0:
					s.Delete(sess.ID)
				case 1:
					if _, err := s.Demote(sess.ID); err != nil {
						t.Errorf("Demote() error = %v", err)
					}
				}
				if j%25 == 0 {
					s.Cleanup()
					clk.Advance(time.Second)
				}
			}
		})
	}
	wg.Wait()
}

// addExchanges records n exchanges in b whose request IDs are prefix0, prefix1, ...
func addExchanges(t *testing.T, b *diag.Buffer, prefix string, n int) {
	t.Helper()
	for i := range n {
		b.AddExchange(diag.Exchange{RequestID: prefix + strconv.Itoa(i)})
	}
}

// requestIDs returns the request IDs of the exchanges in b, oldest first.
func requestIDs(t *testing.T, b *diag.Buffer) []string {
	t.Helper()
	var ids []string
	exchanges := b.Snapshot().Exchanges
	for i := range exchanges {
		ids = append(ids, exchanges[i].RequestID)
	}
	return ids
}

// diagnostics returns the buffer of session id and fails the test if there is none.
func diagnostics(t *testing.T, s *Store, id string) *diag.Buffer {
	t.Helper()
	b, err := s.Diagnostics(id)
	if err != nil {
		t.Fatalf("Diagnostics() error = %v", err)
	}
	if b == nil {
		t.Fatal("Diagnostics() = nil buffer")
	}
	return b
}

func TestDiagnosticsPerSession(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)
	a, _ := s.Create()
	b, _ := s.Login("", acct)

	bufA, bufB := diagnostics(t, s, a.ID), diagnostics(t, s, b.ID)
	if bufA == bufB {
		t.Fatal("two sessions share one buffer")
	}
	if again := diagnostics(t, s, a.ID); again != bufA {
		t.Error("Diagnostics() returned another buffer for the same session")
	}
	bufA.AddExchange(diag.Exchange{RequestID: "only-a"})
	if got := requestIDs(t, bufB); len(got) != 0 {
		t.Errorf("exchange of session A leaked into session B: %v", got)
	}

	for _, id := range []string{"", "short", strings.Repeat("A", 43), strings.Repeat("!", 43)} {
		if _, err := s.Diagnostics(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Diagnostics(%q) error = %v, want ErrNotFound", id, err)
		}
	}

	clk.Advance(3 * time.Hour) // idle timeout of 2 h: both sessions expire
	if buf, err := s.Diagnostics(b.ID); !errors.Is(err, ErrExpired) || buf != nil {
		t.Errorf("Diagnostics() of an expired session = %v, %v, want nil, ErrExpired", buf, err)
	}
	if _, err := s.Diagnostics(b.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second Diagnostics() error = %v, want ErrNotFound (removed)", err)
	}
}

func TestDiagnosticsLimits(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, nil)
	anon, _ := s.Create()
	sess, _ := s.Login("", acct) // no old session: a fresh buffer

	tests := []struct {
		name string
		id   string
		want int
	}{
		{"anonymous", anon.ID, diag.AnonymousLimits.Exchanges},
		{"authenticated", sess.ID, diag.SessionLimits.Exchanges},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			buf := diagnostics(t, s, tt.id)
			addExchanges(t, buf, "r", tt.want+1)
			got := requestIDs(t, buf)
			if len(got) != tt.want || got[0] != "r1" {
				t.Errorf("kept %d exchanges starting at %q, want %d starting at r1", len(got), got[0], tt.want)
			}
		})
	}
}

func TestLoginCarriesDiagnostics(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, nil)
	anon, _ := s.Create()
	anonBuf := diagnostics(t, s, anon.ID)
	addExchanges(t, anonBuf, "r", diag.AnonymousLimits.Exchanges)

	sess, err := s.Login(anon.ID, acct)
	if err != nil {
		t.Fatal(err)
	}
	buf := diagnostics(t, s, sess.ID)
	if buf != anonBuf {
		t.Error("login did not carry the buffer of the anonymous session")
	}
	if got := requestIDs(t, buf); len(got) != diag.AnonymousLimits.Exchanges || got[0] != "r0" {
		t.Fatalf("exchanges after login = %v, want the %d recorded before", got, diag.AnonymousLimits.Exchanges)
	}

	// The limits are those of a session now: 100 exchanges fit, the 101st pushes out the first.
	addExchanges(t, buf, "s", diag.SessionLimits.Exchanges-diag.AnonymousLimits.Exchanges)
	got := requestIDs(t, buf)
	if len(got) != diag.SessionLimits.Exchanges || got[0] != "r0" || got[len(got)-1] != "s69" {
		t.Fatalf("after %d exchanges: kept %d, from %q to %q", diag.SessionLimits.Exchanges, len(got), got[0], got[len(got)-1])
	}
	addExchanges(t, buf, "t", 1)
	if got := requestIDs(t, buf); len(got) != diag.SessionLimits.Exchanges || got[0] != "r1" {
		t.Errorf("101st exchange: kept %d starting at %q, want %d starting at r1", len(got), got[0], diag.SessionLimits.Exchanges)
	}
}

func TestLoginAccountSwitchStartsFresh(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, nil)
	first, _ := s.Login("", acct)
	firstBuf := diagnostics(t, s, first.ID)
	firstBuf.AddExchange(diag.Exchange{RequestID: "of-first"})
	firstBuf.AddProblem(diag.Problem{RequestID: "p1", Kind: diag.ProblemInvalidObject, Path: "/cal/obj", ObjectID: "x", Reason: "bad"})

	// Logging in again with the cookie of an authenticated session is an account
	// switch: the new session must not show what the first one recorded (FR-36).
	other := acct
	other.Username = "mallory"
	second, err := s.Login(first.ID, other)
	if err != nil {
		t.Fatal(err)
	}
	buf := diagnostics(t, s, second.ID)
	if buf == firstBuf {
		t.Error("account switch carried the buffer of the authenticated session")
	}
	if snap := buf.Snapshot(); len(snap.Exchanges) != 0 || len(snap.Problems) != 0 || len(snap.Calendars) != 0 {
		t.Errorf("new buffer = %+v, want empty", snap)
	}
	if _, err := s.Get(first.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("old session still valid: %v", err)
	}

	// It has the limits of a session.
	addExchanges(t, buf, "r", diag.SessionLimits.Exchanges+1)
	if got := requestIDs(t, buf); len(got) != diag.SessionLimits.Exchanges || got[0] != "r1" {
		t.Errorf("kept %d exchanges starting at %q, want %d starting at r1", len(got), got[0], diag.SessionLimits.Exchanges)
	}
}

func TestLoginWithUnknownOldSessionStartsFresh(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, nil)
	stale, _ := s.Create()
	s.Delete(stale.ID)

	sess, err := s.Login(stale.ID, acct)
	if err != nil {
		t.Fatal(err)
	}
	if got := requestIDs(t, diagnostics(t, s, sess.ID)); len(got) != 0 {
		t.Errorf("fresh session starts with exchanges: %v", got)
	}
}

func TestDemoteKeepsPseudonymousPart(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)
	old, _ := s.Login("", acct)
	oldBuf := diagnostics(t, s, old.ID)
	addExchanges(t, oldBuf, "r", 40)
	oldBuf.AddProblem(diag.Problem{RequestID: "p1", Kind: diag.ProblemInvalidObject, Path: "/cal/obj", ObjectID: "x", Reason: "bad"})
	oldBuf.NoteCalendar("/cal", func(n *diag.CalendarNote) { n.Events = true; n.Objects = 3 })

	clk.Advance(time.Minute)
	got, err := s.Demote(old.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Authenticated || got.Username != "" || got.ServerURL != "" {
		t.Errorf("demoted session = %+v, want anonymous without account data", got)
	}
	if got.ID == old.ID || got.CSRFToken == old.CSRFToken {
		t.Error("demote must issue a new ID and CSRF token")
	}
	if want := clk.Now().Add(s.opts.AnonymousTTL); !got.ExpiresAt.Equal(want) {
		t.Errorf("ExpiresAt = %v, want %v (anonymous TTL)", got.ExpiresAt, want)
	}
	if _, err := s.Get(old.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("old ID after Demote: Get() error = %v, want ErrNotFound", err)
	}
	if _, err := s.Account(old.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("old ID after Demote: Account() error = %v, want ErrNotFound", err)
	}
	if _, err := s.Account(got.ID); !errors.Is(err, ErrNotAuthenticated) {
		t.Errorf("Account() of the demoted session error = %v, want ErrNotAuthenticated", err)
	}
	if e := s.sessions[hashID(got.ID)]; e.sealed != nil || e.anonElem == nil {
		t.Errorf("demoted entry holds credentials or is not on the anonymous list: %+v", e)
	}
	if s.anon.Len() != 1 || s.Len() != 1 {
		t.Errorf("anon list = %d, Len() = %d, want 1 and 1", s.anon.Len(), s.Len())
	}

	buf := diagnostics(t, s, got.ID)
	if buf == oldBuf {
		t.Fatal("demoted session shares the buffer of the old one")
	}
	snap := buf.Snapshot()
	if ids := requestIDs(t, buf); len(ids) != diag.AnonymousLimits.Exchanges || ids[0] != "r10" || ids[len(ids)-1] != "r39" {
		t.Errorf("exchanges = %v, want the newest %d of 40", ids, diag.AnonymousLimits.Exchanges)
	}
	if len(snap.Problems) != 1 || snap.Problems[0].ObjectID != "" || snap.Problems[0].Path != "/cal/obj" ||
		snap.Problems[0].Reason != "bad" || snap.Problems[0].RequestID != "p1" {
		t.Errorf("problems = %+v, want the one problem without its ObjectID", snap.Problems)
	}
	if len(snap.Calendars) != 1 || snap.Calendars[0].Path != "/cal" || snap.Calendars[0].Objects != 3 {
		t.Errorf("calendars = %+v, want the note of /cal", snap.Calendars)
	}

	// The new buffer has the limits of an anonymous session ...
	addExchanges(t, buf, "n", 1)
	if ids := requestIDs(t, buf); len(ids) != diag.AnonymousLimits.Exchanges || ids[0] != "r11" {
		t.Errorf("after one more exchange: %d kept starting at %q, want %d starting at r11", len(ids), ids[0], diag.AnonymousLimits.Exchanges)
	}
	// ... and the old buffer is untouched.
	if oldSnap := oldBuf.Snapshot(); len(oldSnap.Exchanges) != 40 || oldSnap.Problems[0].ObjectID != "x" {
		t.Errorf("old buffer changed: %d exchanges, problems %+v", len(oldSnap.Exchanges), oldSnap.Problems)
	}
}

func TestDemoteRespectsAnonymousCap(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, func(o *Options) { o.MaxAnonymous = 2 })
	first, _ := s.Create()
	second, _ := s.Create()
	auth, _ := s.Login("", acct)

	got, err := s.Demote(auth.ID)
	if err != nil {
		t.Fatal(err)
	}
	if s.anon.Len() != 2 || s.Len() != 2 {
		t.Errorf("anon list = %d, Len() = %d, want 2 and 2", s.anon.Len(), s.Len())
	}
	if _, err := s.Get(first.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("oldest anonymous session not evicted: %v", err)
	}
	for _, id := range []string{second.ID, got.ID} {
		if _, err := s.Get(id); err != nil {
			t.Errorf("Get(%q) error = %v, want the session kept", id, err)
		}
	}
}

func TestDemoteAtMaxSessions(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, func(o *Options) { o.MaxSessions = 2 })
	a, _ := s.Login("", acct)
	b, _ := s.Login("", acct)

	// The demoted session takes the slot of the old one, so a full store is no obstacle.
	got, err := s.Demote(a.ID)
	if err != nil {
		t.Fatalf("Demote() in a full store error = %v", err)
	}
	if s.Len() != 2 {
		t.Errorf("Len() = %d, want 2", s.Len())
	}
	for _, id := range []string{b.ID, got.ID} {
		if _, err := s.Get(id); err != nil {
			t.Errorf("Get(%q) error = %v, want the session kept", id, err)
		}
	}
	if _, err := s.Create(); !errors.Is(err, ErrFull) {
		t.Errorf("Create() after Demote error = %v, want ErrFull (the store is still full)", err)
	}
}

func TestDemoteOverMaxSessions(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, nil)
	a, _ := s.Login("", acct)
	_, _ = s.Login("", acct)
	s.opts.MaxSessions = 1 // over the limit, which a swap alone never gets the store into

	if _, err := s.Demote(a.ID); !errors.Is(err, ErrFull) {
		t.Fatalf("Demote() error = %v, want ErrFull", err)
	}
	if s.anon.Len() != 0 {
		t.Errorf("anon list = %d, want no session added", s.anon.Len())
	}
	if _, err := s.Get(a.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("old session after a failed Demote: %v, want it gone as after a failed Login", err)
	}
}

func TestDemoteUnknown(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, nil)
	keep, _ := s.Login("", acct)
	for _, id := range []string{"", "short", strings.Repeat("A", 43), strings.Repeat("!", 43)} {
		if _, err := s.Demote(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Demote(%q) error = %v, want ErrNotFound", id, err)
		}
	}
	if _, err := s.Get(keep.ID); err != nil {
		t.Errorf("unrelated session affected: %v", err)
	}
}

func TestDemoteExpired(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)
	old, _ := s.Login("", acct)
	clk.Advance(3 * time.Hour) // idle timeout of 2 h

	if _, err := s.Demote(old.ID); !errors.Is(err, ErrExpired) {
		t.Fatalf("Demote() error = %v, want ErrExpired", err)
	}
	if s.Len() != 0 {
		t.Errorf("Len() = %d, want the expired session removed and none created", s.Len())
	}
	if _, err := s.Demote(old.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second Demote() error = %v, want ErrNotFound (removed)", err)
	}
}

func TestDemoteAnonymous(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, nil)
	anon, _ := s.Create()
	if _, err := s.Demote(anon.ID); !errors.Is(err, ErrNotAuthenticated) {
		t.Fatalf("Demote() of an anonymous session error = %v, want ErrNotAuthenticated", err)
	}
	if got, err := s.Get(anon.ID); err != nil || got.ID != anon.ID {
		t.Errorf("anonymous session changed by a refused Demote: %+v, %v", got, err)
	}
	if s.Len() != 1 || s.anon.Len() != 1 {
		t.Errorf("Len() = %d, anon list = %d, want 1 and 1", s.Len(), s.anon.Len())
	}
}

func TestDemoteConcurrent(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, nil)
	old, _ := s.Login("", acct)
	var ok atomic.Int32
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			switch _, err := s.Demote(old.ID); {
			case err == nil:
				ok.Add(1)
			case !errors.Is(err, ErrNotFound):
				t.Errorf("Demote() error = %v, want nil or ErrNotFound", err)
			}
		})
	}
	wg.Wait()
	if ok.Load() != 1 {
		t.Errorf("%d Demote calls succeeded, want exactly 1", ok.Load())
	}
	if s.Len() != 1 || s.anon.Len() != 1 {
		t.Errorf("Len() = %d, anon list = %d, want 1 and 1", s.Len(), s.anon.Len())
	}
}

func TestDeleteDropsDiagnostics(t *testing.T) {
	t.Parallel()
	s, _ := newStore(t, nil)
	sess, _ := s.Login("", acct)
	buf := diagnostics(t, s, sess.ID)
	s.Delete(sess.ID)
	if _, err := s.Diagnostics(sess.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("Diagnostics() after Delete error = %v, want ErrNotFound", err)
	}
	// A holder of the buffer keeps a working one; the store just no longer hands it out.
	buf.AddExchange(diag.Exchange{RequestID: "late"})
	if !slices.Equal(requestIDs(t, buf), []string{"late"}) {
		t.Error("buffer unusable after Delete")
	}
}
