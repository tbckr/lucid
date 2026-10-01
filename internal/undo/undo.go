// Package undo keeps a short-lived, in-memory record of a todo's resource
// bytes from just before a write, so a recurring task change can be undone
// exactly (FR-17). The store itself never keeps raw owner strings (normally
// a session ID): entries are keyed by SHA-256(owner), as internal/session
// keys sessions, so a memory dump of the map alone does not yield usable
// session IDs.
package undo

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"sync"
	"time"

	"github.com/tbckr/lucid/internal/domain"
)

// Defaults for Options.
const (
	DefaultTTL         = 2 * time.Minute
	DefaultPerOwner    = 8
	DefaultMaxBytes    = 64 << 20
	DefaultMaxSnapshot = 1 << 20
)

const tokenBytes = 32 // 256-bit undo tokens

// Options configures a Store.
type Options struct {
	// TTL is how long a snapshot stays undoable after it was taken
	// (domain.TodoSnapshot.TakenAt). Default DefaultTTL.
	TTL time.Duration
	// PerOwner caps the number of snapshots kept per owner; a Put beyond it
	// evicts that owner's oldest. Default DefaultPerOwner.
	PerOwner int
	// MaxBytes caps the total size of all stored snapshot Data; a Put beyond
	// it evicts the store's oldest snapshots, regardless of owner, until it
	// fits. Default DefaultMaxBytes.
	MaxBytes int64
	// MaxSnapshot caps the size of a single snapshot's Data; Put refuses
	// anything larger. Default DefaultMaxSnapshot.
	MaxSnapshot int64
	// Now is the clock. Default time.Now.
	Now func() time.Time
}

type hashKey [sha256.Size]byte

// Store is an in-memory, single-use undo-snapshot store, safe for
// concurrent use.
type Store struct {
	opts Options

	mu     sync.Mutex
	owners map[hashKey]map[string]domain.TodoSnapshot // owner hash -> token -> snapshot
	bytes  int64                                      // total size of all stored Data
}

// New creates a Store.
func New(opts Options) *Store {
	if opts.TTL <= 0 {
		opts.TTL = DefaultTTL
	}
	if opts.PerOwner <= 0 {
		opts.PerOwner = DefaultPerOwner
	}
	if opts.MaxBytes <= 0 {
		opts.MaxBytes = DefaultMaxBytes
	}
	if opts.MaxSnapshot <= 0 {
		opts.MaxSnapshot = DefaultMaxSnapshot
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Store{
		opts:   opts,
		owners: make(map[hashKey]map[string]domain.TodoSnapshot),
	}
}

// Put stores snap under owner and returns a token to retrieve it. It reports
// ok=false, storing nothing, when snap.Data exceeds MaxSnapshot.
func (s *Store) Put(owner string, snap domain.TodoSnapshot) (token string, ok bool) {
	size := int64(len(snap.Data))
	if size > s.opts.MaxSnapshot {
		return "", false
	}
	tok := randomToken()
	k := hashOwner(owner)

	s.mu.Lock()
	defer s.mu.Unlock()

	for len(s.owners[k]) >= s.opts.PerOwner {
		s.evictOwnerOldestLocked(k, s.owners[k])
	}
	for s.bytes+size > s.opts.MaxBytes {
		if !s.evictGlobalOldestLocked() {
			break
		}
	}
	// Re-fetch: an eviction above may have emptied and removed this owner's
	// bucket from the map.
	bucket := s.owners[k]
	if bucket == nil {
		bucket = make(map[string]domain.TodoSnapshot)
		s.owners[k] = bucket
	}
	bucket[tok] = snap
	s.bytes += size
	return tok, true
}

// Get returns the snapshot stored for owner under token. It reports ok=false
// when the token is malformed, unknown, expired, or was stored under another
// owner. An expired entry is left for Cleanup/Run to remove, so Get alone
// never mutates the store.
func (s *Store) Get(owner, token string) (domain.TodoSnapshot, bool) {
	if !validToken(token) {
		return domain.TodoSnapshot{}, false
	}
	k := hashOwner(owner)
	now := s.opts.Now()

	s.mu.Lock()
	defer s.mu.Unlock()
	bucket, ok := s.owners[k]
	if !ok {
		return domain.TodoSnapshot{}, false
	}
	snap, ok := bucket[token]
	if !ok || s.expired(snap, now) {
		return domain.TodoSnapshot{}, false
	}
	return snap, true
}

// Delete removes one snapshot. Unknown owner/token pairs are ignored.
func (s *Store) Delete(owner, token string) {
	if !validToken(token) {
		return
	}
	k := hashOwner(owner)

	s.mu.Lock()
	defer s.mu.Unlock()
	if bucket, ok := s.owners[k]; ok {
		s.removeLocked(k, bucket, token)
	}
}

// DeleteOwner removes all of an owner's snapshots, for example on logout.
func (s *Store) DeleteOwner(owner string) {
	k := hashOwner(owner)

	s.mu.Lock()
	defer s.mu.Unlock()
	bucket, ok := s.owners[k]
	if !ok {
		return
	}
	for tok := range bucket {
		s.bytes -= int64(len(bucket[tok].Data))
	}
	delete(s.owners, k)
}

// Cleanup removes all expired snapshots and returns how many were removed.
func (s *Store) Cleanup() int {
	now := s.opts.Now()

	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for k, bucket := range s.owners {
		for token := range bucket {
			if s.expired(bucket[token], now) {
				s.removeLocked(k, bucket, token)
				n++
			}
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

// ownerKeys returns the owner hash keys currently holding snapshots. It
// exists for tests that check the store keeps no raw owner string.
func (s *Store) ownerKeys() []hashKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := make([]hashKey, 0, len(s.owners))
	for k := range s.owners {
		keys = append(keys, k)
	}
	return keys
}

func (s *Store) expired(snap domain.TodoSnapshot, now time.Time) bool {
	return !now.Before(snap.TakenAt.Add(s.opts.TTL))
}

// evictOwnerOldestLocked removes the oldest (by TakenAt) entry of one
// owner's bucket.
func (s *Store) evictOwnerOldestLocked(k hashKey, bucket map[string]domain.TodoSnapshot) {
	token, _, found := oldestInBucket(bucket)
	if !found {
		return
	}
	s.removeLocked(k, bucket, token)
}

// evictGlobalOldestLocked removes the oldest (by TakenAt) entry across all
// owners. It reports whether an entry was removed.
func (s *Store) evictGlobalOldestLocked() bool {
	var (
		oldestKey   hashKey
		oldestToken string
		oldestAt    time.Time
		found       bool
	)
	for k, bucket := range s.owners {
		token, at, ok := oldestInBucket(bucket)
		if !ok {
			continue
		}
		if !found || at.Before(oldestAt) {
			oldestKey, oldestToken, oldestAt, found = k, token, at, true
		}
	}
	if !found {
		return false
	}
	s.removeLocked(oldestKey, s.owners[oldestKey], oldestToken)
	return true
}

func oldestInBucket(bucket map[string]domain.TodoSnapshot) (token string, at time.Time, found bool) {
	for tok := range bucket {
		ts := bucket[tok].TakenAt
		if !found || ts.Before(at) {
			token, at, found = tok, ts, true
		}
	}
	return token, at, found
}

// removeLocked deletes one entry and keeps the byte budget and owner map
// consistent. bucket must be s.owners[k].
func (s *Store) removeLocked(k hashKey, bucket map[string]domain.TodoSnapshot, token string) {
	snap, ok := bucket[token]
	if !ok {
		return
	}
	delete(bucket, token)
	s.bytes -= int64(len(snap.Data))
	if len(bucket) == 0 {
		delete(s.owners, k)
	}
}

func hashOwner(owner string) hashKey {
	return sha256.Sum256([]byte(owner))
}

// randomToken returns tokenBytes of crypto/rand, base64url encoded without
// padding (43 characters).
func randomToken() string {
	b := make([]byte, tokenBytes)
	_, _ = rand.Read(b) // never fails since Go 1.24 (it crashes instead)
	return base64.RawURLEncoding.EncodeToString(b)
}

var tokenLen = base64.RawURLEncoding.EncodedLen(tokenBytes)

// validToken rejects obviously malformed tokens before hashing (cheap DoS
// guard), the same way internal/session validates session IDs.
func validToken(token string) bool {
	if len(token) != tokenLen {
		return false
	}
	for i := range len(token) {
		c := token[i]
		if !('A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
