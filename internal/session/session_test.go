package session

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

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
				if (i+j)%3 == 0 {
					s.Delete(sess.ID)
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
