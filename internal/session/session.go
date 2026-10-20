// Package session implements the server-side session store (FR-03, NFR-03).
//
// Sessions live in memory only. CalDAV credentials are kept encrypted with
// AES-256-GCM; the session ID is bound in as additional authenticated data,
// so a ciphertext cannot be moved to another session. The store itself never
// keeps raw session IDs: entries are keyed by SHA-256(ID), so a memory dump of
// the map alone does not yield usable cookies.
//
// Every session also owns a bounded diagnostics buffer (FR-36): the recent
// CalDAV exchanges and problems of that session, as metadata only (NFR-36).
// It lives and dies with the session, in memory.
package session

import (
	"container/list"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tbckr/lucid/internal/diag"
	"github.com/tbckr/lucid/internal/domain"
)

// Errors returned by the store.
var (
	// ErrNotFound means the session ID is unknown (or malformed).
	ErrNotFound = errors.New("session not found")
	// ErrExpired means the session existed but hit its absolute or idle timeout.
	ErrExpired = errors.New("session expired")
	// ErrNotAuthenticated means the session is anonymous and holds no account.
	ErrNotAuthenticated = errors.New("session not authenticated")
	// ErrFull means the store reached MaxSessions.
	ErrFull = errors.New("session store full")
)

// KeySize is the required encryption key length (AES-256).
const KeySize = 32

const (
	idBytes    = 32 // 256-bit session IDs
	tokenBytes = 32 // 256-bit CSRF tokens
)

// Defaults for Options.
const (
	DefaultTTL          = 12 * time.Hour
	DefaultIdleTimeout  = 2 * time.Hour
	DefaultAnonymousTTL = 15 * time.Minute
	DefaultMaxAnonymous = 10_000
	DefaultMaxSessions  = 100_000
)

// Options configures a Store.
type Options struct {
	// Key is the 32-byte AES-256 key. nil generates a random key; sessions live
	// only in memory, so nothing else needs it (NFR-20).
	Key []byte
	// TTL is the absolute lifetime of an authenticated session.
	TTL time.Duration
	// IdleTimeout ends a session that was not used for this long.
	IdleTimeout time.Duration
	// AnonymousTTL is the absolute lifetime of an anonymous session (created
	// before login only to carry a CSRF token). Kept short.
	AnonymousTTL time.Duration
	// MaxAnonymous caps anonymous sessions; the oldest is evicted when full,
	// so unauthenticated clients cannot exhaust memory.
	MaxAnonymous int
	// MaxSessions caps all sessions; Create/Login fail with ErrFull beyond.
	MaxSessions int
	// Now is the clock. Default time.Now.
	Now func() time.Time
}

// Session is a read-only snapshot of a session.
type Session struct {
	ID            string
	CSRFToken     string
	Authenticated bool
	// Username and ServerURL are non-secret display values.
	Username  string
	ServerURL string
	CreatedAt time.Time
	ExpiresAt time.Time // absolute expiry
}

// CheckCSRF compares token with the session's CSRF token in constant time.
func (s Session) CheckCSRF(token string) bool {
	return token != "" && s.CSRFToken != "" &&
		subtle.ConstantTimeCompare([]byte(token), []byte(s.CSRFToken)) == 1
}

type entry struct {
	csrf      string
	username  string
	serverURL string
	sealed    []byte // nonce || AES-GCM(Account JSON); nil for anonymous
	created   time.Time
	expires   time.Time
	lastSeen  atomic.Int64 // unix nanos; updated under the read lock
	anonElem  *list.Element
	// diag is the session's diagnostics buffer (FR-36). It is never nil, and
	// is not changed once the entry is in the map: Login and Demote set it
	// before they add the entry.
	diag *diag.Buffer
}

type hashKey [sha256.Size]byte

// Store is an in-memory session store, safe for concurrent use.
type Store struct {
	opts Options
	aead cipher.AEAD

	mu       sync.RWMutex
	sessions map[hashKey]*entry
	anon     *list.List // hashKeys of anonymous sessions, oldest first
}

// New creates a Store.
func New(opts Options) (*Store, error) {
	if opts.Key == nil {
		opts.Key = make([]byte, KeySize)
		_, _ = rand.Read(opts.Key) // never fails since Go 1.24 (it crashes instead)
	}
	if len(opts.Key) != KeySize {
		return nil, fmt.Errorf("session: key must be %d bytes", KeySize)
	}
	if opts.TTL <= 0 {
		opts.TTL = DefaultTTL
	}
	if opts.IdleTimeout <= 0 {
		opts.IdleTimeout = DefaultIdleTimeout
	}
	if opts.AnonymousTTL <= 0 {
		opts.AnonymousTTL = DefaultAnonymousTTL
	}
	opts.AnonymousTTL = min(opts.AnonymousTTL, opts.TTL)
	if opts.MaxAnonymous <= 0 {
		opts.MaxAnonymous = DefaultMaxAnonymous
	}
	if opts.MaxSessions <= 0 {
		opts.MaxSessions = DefaultMaxSessions
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	block, err := aes.NewCipher(opts.Key)
	if err != nil {
		return nil, fmt.Errorf("session: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("session: %w", err)
	}
	return &Store{
		opts:     opts,
		aead:     aead,
		sessions: make(map[hashKey]*entry),
		anon:     list.New(),
	}, nil
}

// Create starts a new anonymous session.
func (s *Store) Create() (Session, error) {
	id, e := s.newEntry()
	e.expires = e.created.Add(s.opts.AnonymousTTL)
	k := hashID(id)

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.addAnonymousLocked(k, e); err != nil {
		return Session{}, err
	}
	return snapshot(id, e), nil
}

// Get returns the session and refreshes its idle timer.
func (s *Store) Get(id string) (Session, error) {
	e, err := s.lookup(id)
	if err != nil {
		return Session{}, err
	}
	return snapshot(id, e), nil
}

// Account decrypts the credentials of an authenticated session. It also
// refreshes the idle timer.
func (s *Store) Account(id string) (domain.Account, error) {
	e, err := s.lookup(id)
	if err != nil {
		return domain.Account{}, err
	}
	if e.sealed == nil {
		return domain.Account{}, ErrNotAuthenticated
	}
	ns := s.aead.NonceSize()
	plain, err := s.aead.Open(nil, e.sealed[:ns], e.sealed[ns:], []byte(id))
	if err != nil {
		return domain.Account{}, fmt.Errorf("session: decrypting account: %w", err)
	}
	defer clear(plain)
	var acct domain.Account
	if err := json.Unmarshal(plain, &acct); err != nil {
		return domain.Account{}, fmt.Errorf("session: decoding account: %w", err)
	}
	return acct, nil
}

// Diagnostics returns the diagnostics buffer of a session (FR-36), with the
// errors of Get; it refreshes the idle timer too. The buffer is the same one
// on every call for as long as the session lives, and safe for concurrent use.
// Deleting the session does not empty a buffer someone still holds, the store
// just stops handing it out.
func (s *Store) Diagnostics(id string) (*diag.Buffer, error) {
	e, err := s.lookup(id)
	if err != nil {
		return nil, err
	}
	return e.diag, nil
}

// Login creates a new authenticated session for acct and destroys oldID
// (if any). Issuing a fresh ID and CSRF token on login prevents session
// fixation. If oldID is an anonymous session, the new session takes over its
// diagnostics buffer, so what was recorded while logging in survives the login,
// with the limits of a session (diag.SessionLimits, FR-36). Otherwise, with no
// old session or an authenticated one (an account switch without a logout), it
// starts with an empty buffer with those limits.
func (s *Store) Login(oldID string, acct domain.Account) (Session, error) {
	id, e := s.newEntry()
	plain, err := json.Marshal(acct) //nolint:gosec // G117: serialized only to be encrypted right below
	if err != nil {
		return Session{}, fmt.Errorf("session: encoding account: %w", err)
	}
	nonce := make([]byte, s.aead.NonceSize(), s.aead.NonceSize()+len(plain)+s.aead.Overhead())
	_, _ = rand.Read(nonce) // never fails since Go 1.24 (it crashes instead)
	e.sealed = s.aead.Seal(nonce, nonce, plain, []byte(id))
	clear(plain) // best effort: do not leave the password lying around
	e.username = acct.Username
	e.serverURL = acct.ServerURL
	e.expires = e.created.Add(s.opts.TTL)

	s.mu.Lock()
	defer s.mu.Unlock()
	if oldID != "" {
		k := hashID(oldID)
		// Only an anonymous session hands its buffer on: with an authenticated
		// one this is an account switch, and the report of the new session must
		// show only its own (FR-36, NFR-36).
		if old, ok := s.sessions[k]; ok && old.sealed == nil {
			e.diag = old.diag
		}
		s.removeLocked(k)
	}
	if len(s.sessions) >= s.opts.MaxSessions {
		return Session{}, ErrFull
	}
	e.diag.SetLimits(diag.SessionLimits)
	s.sessions[hashID(id)] = e
	return snapshot(id, e), nil
}

// Demote replaces the authenticated session id by a new anonymous one, for a
// session whose credentials the CalDAV server no longer accepts. The new
// session has a new ID and CSRF token, the anonymous lifetime and counts
// against MaxAnonymous like one from Create; id is gone. It holds none of the
// account, but a copy of the diagnostics buffer without what is not
// pseudonymous (diag.Buffer.WithoutObjects), so the problem report can still
// be downloaded after the forced logout (FR-36, NFR-36). The old buffer is left
// as it was.
//
// It fails with ErrNotFound or ErrExpired like Get, and with
// ErrNotAuthenticated for an anonymous session, which is left as it is.
func (s *Store) Demote(id string) (Session, error) {
	if !validID(id) {
		return Session{}, ErrNotFound
	}
	k := hashID(id)
	newID, e := s.newEntry()
	e.expires = e.created.Add(s.opts.AnonymousTTL)
	nk := hashID(newID)

	s.mu.Lock()
	defer s.mu.Unlock()
	old, ok := s.sessions[k]
	if !ok {
		return Session{}, ErrNotFound
	}
	if s.expired(old, s.opts.Now()) {
		s.removeLocked(k)
		return Session{}, ErrExpired
	}
	if old.sealed == nil {
		return Session{}, ErrNotAuthenticated
	}
	e.diag = old.diag.WithoutObjects()
	s.removeLocked(k) // frees its slot first, as Login does
	if err := s.addAnonymousLocked(nk, e); err != nil {
		return Session{}, err
	}
	return snapshot(newID, e), nil
}

// Delete destroys a session. Unknown IDs are ignored.
func (s *Store) Delete(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removeLocked(hashID(id))
}

// Len returns the number of stored sessions (including expired ones not yet
// collected).
func (s *Store) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.sessions)
}

// Cleanup removes all expired sessions and returns how many were removed.
func (s *Store) Cleanup() int {
	now := s.opts.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for k, e := range s.sessions {
		if s.expired(e, now) {
			s.removeLocked(k)
			n++
		}
	}
	return n
}

// Run calls Cleanup every interval until ctx is canceled.
func (s *Store) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Cleanup()
		}
	}
}

func (s *Store) lookup(id string) (*entry, error) {
	if !validID(id) {
		return nil, ErrNotFound
	}
	k := hashID(id)
	now := s.opts.Now()

	s.mu.RLock()
	e, ok := s.sessions[k]
	if ok && !s.expired(e, now) {
		e.lastSeen.Store(now.UnixNano())
		s.mu.RUnlock()
		return e, nil
	}
	s.mu.RUnlock()
	if !ok {
		return nil, ErrNotFound
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	// Re-check: the entry may have been replaced or removed meanwhile.
	if cur, ok := s.sessions[k]; ok && cur == e {
		s.removeLocked(k)
	}
	return nil, ErrExpired
}

func (s *Store) expired(e *entry, now time.Time) bool {
	if !now.Before(e.expires) {
		return true
	}
	return now.Sub(time.Unix(0, e.lastSeen.Load())) >= s.opts.IdleTimeout
}

func (s *Store) removeLocked(k hashKey) {
	e, ok := s.sessions[k]
	if !ok {
		return
	}
	if e.anonElem != nil {
		s.anon.Remove(e.anonElem)
	}
	delete(s.sessions, k)
}

// addAnonymousLocked stores the anonymous entry e under k. It first evicts the
// oldest anonymous sessions until there is room under MaxAnonymous, and fails
// with ErrFull if the store holds MaxSessions then.
func (s *Store) addAnonymousLocked(k hashKey, e *entry) error {
	for s.anon.Len() >= s.opts.MaxAnonymous {
		s.removeLocked(s.anon.Front().Value.(hashKey)) //nolint:forcetypeassert // list only holds hashKeys
	}
	if len(s.sessions) >= s.opts.MaxSessions {
		return ErrFull
	}
	e.anonElem = s.anon.PushBack(k)
	s.sessions[k] = e
	return nil
}

// newEntry returns a new ID and an entry with a fresh CSRF token and an empty
// diagnostics buffer with diag.AnonymousLimits (FR-36).
func (s *Store) newEntry() (string, *entry) {
	now := s.opts.Now()
	e := &entry{csrf: randomToken(tokenBytes), created: now, diag: diag.NewBuffer(diag.AnonymousLimits)}
	e.lastSeen.Store(now.UnixNano())
	return randomToken(idBytes), e
}

func snapshot(id string, e *entry) Session {
	return Session{
		ID:            id,
		CSRFToken:     e.csrf,
		Authenticated: e.sealed != nil,
		Username:      e.username,
		ServerURL:     e.serverURL,
		CreatedAt:     e.created,
		ExpiresAt:     e.expires,
	}
}

// randomToken returns n bytes from crypto/rand, base64url encoded.
func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b) // never fails since Go 1.24 (it crashes instead)
	return base64.RawURLEncoding.EncodeToString(b)
}

var idLen = base64.RawURLEncoding.EncodedLen(idBytes)

// validID rejects obviously malformed IDs before hashing (cheap DoS guard).
func validID(id string) bool {
	if len(id) != idLen {
		return false
	}
	for i := range len(id) {
		c := id[i]
		if !('A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func hashID(id string) hashKey { return sha256.Sum256([]byte(id)) }
