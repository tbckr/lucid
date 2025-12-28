package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// Session represents a user session with encrypted CalDAV credentials
type Session struct {
	ID        string
	Token     string
	Username  string
	Password  string // Encrypted
	CalDAVURL string
	CreatedAt time.Time
	ExpiresAt time.Time
}

// SessionStore manages in-memory session storage
type SessionStore struct {
	sessions map[string]*Session
	mu       sync.RWMutex
	ttl      time.Duration
	encKey   [32]byte // 256-bit key for AES-256
}

// NewSessionStore creates a new SessionStore with the given TTL
func NewSessionStore(ttl time.Duration) *SessionStore {
	// In production, this key should be derived from a secure source (e.g., environment variable)
	// For now, using a derived key from a constant
	key := sha256.Sum256([]byte("lucid-default-encryption-key"))
	
	store := &SessionStore{
		sessions: make(map[string]*Session),
		ttl:      ttl,
		encKey:   key,
	}
	
	// Start cleanup goroutine
	go store.cleanupExpiredSessions()
	
	return store
}

// CreateSession creates a new session and stores it
func (s *SessionStore) CreateSession(username, password, caldavURL string) (*Session, error) {
	sessionID := generateSecureToken()
	sessionToken := generateSecureToken()
	
	// Encrypt password
	encryptedPassword, err := s.encryptPassword(password)
	if err != nil {
		return nil, fmt.Errorf("failed to encrypt password: %w", err)
	}
	
	now := time.Now()
	session := &Session{
		ID:        sessionID,
		Token:     sessionToken,
		Username:  username,
		Password:  encryptedPassword,
		CalDAVURL: caldavURL,
		CreatedAt: now,
		ExpiresAt: now.Add(s.ttl),
	}
	
	s.mu.Lock()
	s.sessions[sessionID] = session
	s.mu.Unlock()
	
	return session, nil
}

// GetSession retrieves a session by ID
func (s *SessionStore) GetSession(sessionID string) (*Session, error) {
	s.mu.RLock()
	session, exists := s.sessions[sessionID]
	s.mu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("session not found")
	}
	
	// Check if session is expired
	if time.Now().After(session.ExpiresAt) {
		s.DeleteSession(sessionID)
		return nil, fmt.Errorf("session expired")
	}
	
	return session, nil
}

// GetSessionByCookie retrieves a session from an HTTP request
func (s *SessionStore) GetSessionByCookie(r *http.Request) (*Session, error) {
	cookie, err := r.Cookie("session_id")
	if err != nil {
		return nil, fmt.Errorf("no session cookie: %w", err)
	}
	
	return s.GetSession(cookie.Value)
}

// DeleteSession removes a session
func (s *SessionStore) DeleteSession(sessionID string) {
	s.mu.Lock()
	delete(s.sessions, sessionID)
	s.mu.Unlock()
}

// UpdateSessionExpiry extends the session expiration time
func (s *SessionStore) UpdateSessionExpiry(sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	session, exists := s.sessions[sessionID]
	if !exists {
		return fmt.Errorf("session not found")
	}
	
	session.ExpiresAt = time.Now().Add(s.ttl)
	return nil
}

// SetSessionCookie sets a secure session cookie
func (s *SessionStore) SetSessionCookie(w http.ResponseWriter, sessionID string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "session_id",
		Value:    sessionID,
		Path:     "/",
		MaxAge:   int(s.ttl.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

// DecryptPassword decrypts a password
func (s *SessionStore) DecryptPassword(encrypted string) (string, error) {
	return s.decryptAES(encrypted)
}

// Private methods

func (s *SessionStore) encryptPassword(password string) (string, error) {
	return s.encryptAES(password)
}

func (s *SessionStore) encryptAES(plaintext string) (string, error) {
	block, err := aes.NewCipher(s.encKey[:])
	if err != nil {
		return "", err
	}
	
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func (s *SessionStore) decryptAES(ciphertext string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", err
	}
	
	block, err := aes.NewCipher(s.encKey[:])
	if err != nil {
		return "", err
	}
	
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	
	nonce, ciphertext_data := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext_data, nil)
	if err != nil {
		return "", err
	}
	
	return string(plaintext), nil
}

func (s *SessionStore) cleanupExpiredSessions() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for range ticker.C {
		s.mu.Lock()
		now := time.Now()
		for id, session := range s.sessions {
			if now.After(session.ExpiresAt) {
				delete(s.sessions, id)
			}
		}
		s.mu.Unlock()
	}
}

// Helper function to generate secure tokens
func generateSecureToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}
