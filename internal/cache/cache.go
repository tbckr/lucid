package cache

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// CacheEntry holds cached data with expiration
type CacheEntry struct {
	Value     interface{}
	ExpiresAt time.Time
}

// InMemoryCache implements CacheProvider with in-memory storage
type InMemoryCache struct {
	data map[string]*CacheEntry
	mu   sync.RWMutex
}

// New creates a new InMemoryCache
func New() *InMemoryCache {
	cache := &InMemoryCache{
		data: make(map[string]*CacheEntry),
	}
	
	// Start cleanup goroutine
	go cache.cleanupExpired()
	
	return cache
}

// Get retrieves a value from cache
func (c *InMemoryCache) Get(ctx context.Context, key string) (interface{}, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	
	entry, exists := c.data[key]
	if !exists {
		return nil, fmt.Errorf("cache miss: %s", key)
	}
	
	// Check if expired
	if time.Now().After(entry.ExpiresAt) {
		return nil, fmt.Errorf("cache expired: %s", key)
	}
	
	return entry.Value, nil
}

// Set stores a value in cache with TTL
func (c *InMemoryCache) Set(ctx context.Context, key string, value interface{}, ttl time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	c.data[key] = &CacheEntry{
		Value:     value,
		ExpiresAt: time.Now().Add(ttl),
	}
	
	return nil
}

// Invalidate removes a key from cache
func (c *InMemoryCache) Invalidate(ctx context.Context, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	delete(c.data, key)
	return nil
}

// InvalidatePattern removes all keys matching a pattern
func (c *InMemoryCache) InvalidatePattern(ctx context.Context, pattern string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	for key := range c.data {
		if strings.HasPrefix(key, pattern) {
			delete(c.data, key)
		}
	}
	
	return nil
}

// Clear removes all entries from cache
func (c *InMemoryCache) Clear(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	c.data = make(map[string]*CacheEntry)
	return nil
}

// GetStats returns cache statistics
func (c *InMemoryCache) GetStats(ctx context.Context) (size int, expired int) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	
	size = len(c.data)
	now := time.Now()
	for _, entry := range c.data {
		if now.After(entry.ExpiresAt) {
			expired++
		}
	}
	
	return
}

// Private methods

func (c *InMemoryCache) cleanupExpired() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for range ticker.C {
		c.mu.Lock()
		now := time.Now()
		for key, entry := range c.data {
			if now.After(entry.ExpiresAt) {
				delete(c.data, key)
			}
		}
		c.mu.Unlock()
	}
}

// CTag cache specifically for CalDAV CTag-based caching
type CTagCache struct {
	data map[string]*CTagEntry
	mu   sync.RWMutex
}

// CTagEntry holds calendar data with CTag
type CTagEntry struct {
	CTag      string
	Events    interface{}
	ExpiresAt time.Time
}

// NewCTagCache creates a new CTag cache
func NewCTagCache() *CTagCache {
	return &CTagCache{
		data: make(map[string]*CTagEntry),
	}
}

// GetByID retrieves cache entry by calendar ID
func (c *CTagCache) GetByID(calendarID string) (*CTagEntry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	
	entry, exists := c.data[calendarID]
	if !exists {
		return nil, false
	}
	
	// Check if expired
	if time.Now().After(entry.ExpiresAt) {
		return nil, false
	}
	
	return entry, true
}

// Set stores a calendar entry with CTag
func (c *CTagCache) Set(calendarID, ctag string, events interface{}, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	c.data[calendarID] = &CTagEntry{
		CTag:      ctag,
		Events:    events,
		ExpiresAt: time.Now().Add(ttl),
	}
}

// InvalidateAll clears all entries
func (c *CTagCache) InvalidateAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	c.data = make(map[string]*CTagEntry)
}

// InvalidateCalendar clears a specific calendar entry
func (c *CTagCache) InvalidateCalendar(calendarID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	delete(c.data, calendarID)
}
