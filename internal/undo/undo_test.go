package undo

import (
	"bytes"
	"context"
	"crypto/sha256"
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

func newStore(t *testing.T, mod func(*Options)) (*Store, *fakeClock) {
	t.Helper()
	clk := newClock()
	opts := Options{Now: clk.Now}
	if mod != nil {
		mod(&opts)
	}
	return New(opts), clk
}

func snapAt(now time.Time, data []byte) domain.TodoSnapshot {
	return domain.TodoSnapshot{
		TodoID:   "todo-1",
		ETag:     "etag-1",
		Data:     data,
		CopyID:   "copy-1",
		CopyETag: "copy-etag-1",
		Account:  "https://dav.example.com\x00tim",
		TakenAt:  now,
	}
}

func TestPutGet(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)
	snap := snapAt(clk.Now(), []byte("resource bytes"))

	token, ok := s.Put("s1", snap)
	if !ok {
		t.Fatalf("Put() ok = false")
	}

	got, ok := s.Get("s1", token)
	if !ok {
		t.Fatalf("Get(s1) ok = false")
	}
	if got.TodoID != snap.TodoID || got.ETag != snap.ETag || !bytes.Equal(got.Data, snap.Data) ||
		got.CopyID != snap.CopyID || got.CopyETag != snap.CopyETag || got.Account != snap.Account ||
		!got.TakenAt.Equal(snap.TakenAt) {
		t.Errorf("Get() = %+v, want %+v", got, snap)
	}

	if _, ok := s.Get("s2", token); ok {
		t.Error("Get() with another owner ok = true, want false")
	}
}

func TestTokenFormat(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)
	token, ok := s.Put("s1", snapAt(clk.Now(), []byte("x")))
	if !ok {
		t.Fatalf("Put() ok = false")
	}
	if len(token) != 43 {
		t.Errorf("len(token) = %d, want 43", len(token))
	}
	for i := range len(token) {
		c := token[i]
		valid := 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_'
		if !valid {
			t.Fatalf("token %q contains invalid char %q at %d", token, c, i)
		}
	}

	bad := []string{"x", "", string(make([]byte, 43))}
	for _, tok := range bad {
		if _, ok := s.Get("s1", tok); ok {
			t.Errorf("Get(%q) ok = true, want false", tok)
		}
	}
	// 43-char token made entirely of '!', which is not in the base64url alphabet.
	bang := make([]byte, 43)
	for i := range bang {
		bang[i] = '!'
	}
	if _, ok := s.Get("s1", string(bang)); ok {
		t.Error("Get() with 43-char invalid-charset token ok = true, want false")
	}
}

// TestValidToken checks ValidToken directly: internal/httpapi uses it to
// reject a malformed token as invalid input before ever asking the store,
// rather than let it fall through to the store's "not found".
func TestValidToken(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)
	token, ok := s.Put("s1", snapAt(clk.Now(), []byte("x")))
	if !ok {
		t.Fatalf("Put() ok = false")
	}

	if !ValidToken(token) {
		t.Errorf("ValidToken(%q) = false, want true for a token Put returned", token)
	}

	bang := strings.Repeat("!", 43) // 43 chars, but outside the base64url alphabet
	for _, tt := range []struct {
		name  string
		token string
	}{
		{"empty", ""},
		{"too short", "x"},
		{"too long", token + "x"},
		{"right length, wrong charset", bang},
		{"all zero bytes, right length", string(make([]byte, 43))},
	} {
		if ValidToken(tt.token) {
			t.Errorf("ValidToken(%q) = true, want false (%s)", tt.token, tt.name)
		}
	}
}

func TestExpiry(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)
	token, ok := s.Put("s1", snapAt(clk.Now(), []byte("x")))
	if !ok {
		t.Fatalf("Put() ok = false")
	}

	clk.Advance(2*time.Minute + time.Second)

	if _, ok := s.Get("s1", token); ok {
		t.Error("Get() after expiry ok = true, want false")
	}
	if n := s.Cleanup(); n != 1 {
		t.Errorf("Cleanup() = %d, want 1", n)
	}
}

func TestPerOwnerCap(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)

	otherToken, ok := s.Put("s2", snapAt(clk.Now(), []byte("other")))
	if !ok {
		t.Fatalf("Put(s2) ok = false")
	}

	var tokens []string
	for range 9 {
		tok, ok := s.Put("s1", snapAt(clk.Now(), []byte("x")))
		if !ok {
			t.Fatalf("Put(s1) ok = false")
		}
		tokens = append(tokens, tok)
		clk.Advance(time.Millisecond)
	}

	if _, ok := s.Get("s1", tokens[0]); ok {
		t.Error("oldest entry survived the 9th Put, want evicted")
	}
	for i, tok := range tokens[1:] {
		if _, ok := s.Get("s1", tok); !ok {
			t.Errorf("entry %d evicted unexpectedly", i+1)
		}
	}
	if _, ok := s.Get("s2", otherToken); !ok {
		t.Error("another owner's entry was evicted")
	}
}

func TestByteBudget(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, func(o *Options) { o.MaxBytes = 10 })

	first, ok := s.Put("s1", snapAt(clk.Now(), []byte("123456")))
	if !ok {
		t.Fatalf("Put() first ok = false")
	}
	clk.Advance(time.Millisecond)
	second, ok := s.Put("s1", snapAt(clk.Now(), []byte("789012")))
	if !ok {
		t.Fatalf("Put() second ok = false")
	}

	if _, ok := s.Get("s1", first); ok {
		t.Error("first snapshot survived the byte budget, want evicted")
	}
	if _, ok := s.Get("s1", second); !ok {
		t.Error("second snapshot missing")
	}
}

func TestTooLarge(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, func(o *Options) { o.MaxSnapshot = 10 })

	data := make([]byte, 11)
	token, ok := s.Put("s1", snapAt(clk.Now(), data))
	if ok {
		t.Fatalf("Put() ok = true, want false")
	}
	if token != "" {
		t.Errorf("Put() token = %q, want empty", token)
	}
	if keys := s.ownerKeys(); len(keys) != 0 {
		t.Errorf("ownerKeys() = %v, want none stored", keys)
	}
}

func TestDeleteAndDeleteOwner(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)

	a1, ok := s.Put("s1", snapAt(clk.Now(), []byte("a1")))
	if !ok {
		t.Fatalf("Put() a1 ok = false")
	}
	a2, ok := s.Put("s1", snapAt(clk.Now(), []byte("a2")))
	if !ok {
		t.Fatalf("Put() a2 ok = false")
	}
	b1, ok := s.Put("s2", snapAt(clk.Now(), []byte("b1")))
	if !ok {
		t.Fatalf("Put() b1 ok = false")
	}

	s.Delete("s1", a1)
	if _, ok := s.Get("s1", a1); ok {
		t.Error("Delete() did not remove the entry")
	}
	if _, ok := s.Get("s1", a2); !ok {
		t.Error("Delete() removed an unrelated entry")
	}

	s.DeleteOwner("s1")
	if _, ok := s.Get("s1", a2); ok {
		t.Error("DeleteOwner() left an entry behind")
	}
	if _, ok := s.Get("s2", b1); !ok {
		t.Error("DeleteOwner() removed another owner's entry")
	}
}

func TestOwnerHashed(t *testing.T) {
	t.Parallel()
	s, clk := newStore(t, nil)
	if _, ok := s.Put("s1", snapAt(clk.Now(), []byte("x"))); !ok {
		t.Fatalf("Put() ok = false")
	}

	keys := s.ownerKeys()
	if len(keys) != 1 {
		t.Fatalf("ownerKeys() = %v, want exactly one key", keys)
	}
	want := sha256.Sum256([]byte("s1"))
	if keys[0] != want {
		t.Errorf("ownerKeys()[0] = %x, want sha256(%q) = %x", keys[0], "s1", want)
	}
}

func TestRun(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		s, clk := newStore(t, nil)
		token, ok := s.Put("s1", snapAt(clk.Now(), []byte("x")))
		if !ok {
			t.Fatalf("Put() ok = false")
		}
		clk.Advance(2*time.Minute + time.Second)

		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan struct{})
		go func() {
			s.Run(ctx, time.Minute)
			close(done)
		}()
		time.Sleep(61 * time.Second)
		synctest.Wait()
		if keys := s.ownerKeys(); len(keys) != 0 {
			t.Errorf("janitor did not clean up: ownerKeys() = %v", keys)
		}
		cancel()
		<-done

		if _, ok := s.Get("s1", token); ok {
			t.Error("Get() after janitor cleanup ok = true, want false")
		}
	})
}
