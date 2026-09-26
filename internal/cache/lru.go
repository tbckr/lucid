// Package cache provides a small, generic, thread-safe LRU cache.
package cache

import (
	"container/list"
	"sync"
)

// LRU is a fixed-size least-recently-used cache. It is safe for concurrent
// use. The zero value is not usable; create instances with New.
type LRU[K comparable, V any] struct {
	mu    sync.Mutex
	size  int
	ll    *list.List // front = most recently used
	items map[K]*list.Element
}

type entry[K comparable, V any] struct {
	key   K
	value V
}

// New returns an LRU holding at most size entries. A size < 1 is treated as 1.
func New[K comparable, V any](size int) *LRU[K, V] {
	size = max(size, 1)
	return &LRU[K, V]{
		size:  size,
		ll:    list.New(),
		items: make(map[K]*list.Element, size),
	}
}

// Get returns the value for key and marks it as recently used.
func (c *LRU[K, V]) Get(key K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[key]
	if !ok {
		var zero V
		return zero, false
	}
	c.ll.MoveToFront(el)
	return el.Value.(*entry[K, V]).value, true
}

// Add inserts or replaces the value for key and evicts the least recently
// used entry if the cache is full.
func (c *LRU[K, V]) Add(key K, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		el.Value.(*entry[K, V]).value = value
		c.ll.MoveToFront(el)
		return
	}
	c.items[key] = c.ll.PushFront(&entry[K, V]{key: key, value: value})
	if c.ll.Len() > c.size {
		oldest := c.ll.Back()
		c.ll.Remove(oldest)
		delete(c.items, oldest.Value.(*entry[K, V]).key)
	}
}

// Remove deletes key from the cache. It reports whether the key was present.
func (c *LRU[K, V]) Remove(key K) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[key]
	if !ok {
		return false
	}
	c.ll.Remove(el)
	delete(c.items, key)
	return true
}

// Len returns the number of cached entries.
func (c *LRU[K, V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}
