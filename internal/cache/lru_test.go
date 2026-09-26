package cache

import (
	"fmt"
	"sync"
	"testing"
)

func TestLRU(t *testing.T) {
	t.Parallel()

	type op struct {
		kind  string // "add", "get", "remove"
		key   string
		value int
		want  int
		found bool
	}
	tests := []struct {
		name    string
		size    int
		ops     []op
		wantLen int
	}{
		{
			name: "get missing",
			size: 2,
			ops:  []op{{kind: "get", key: "a", found: false}},
		},
		{
			name: "add and get",
			size: 2,
			ops: []op{
				{kind: "add", key: "a", value: 1},
				{kind: "get", key: "a", want: 1, found: true},
			},
			wantLen: 1,
		},
		{
			name: "replace value",
			size: 2,
			ops: []op{
				{kind: "add", key: "a", value: 1},
				{kind: "add", key: "a", value: 2},
				{kind: "get", key: "a", want: 2, found: true},
			},
			wantLen: 1,
		},
		{
			name: "evicts least recently used",
			size: 2,
			ops: []op{
				{kind: "add", key: "a", value: 1},
				{kind: "add", key: "b", value: 2},
				{kind: "get", key: "a", want: 1, found: true}, // a is now most recent
				{kind: "add", key: "c", value: 3},             // evicts b
				{kind: "get", key: "b", found: false},
				{kind: "get", key: "a", want: 1, found: true},
				{kind: "get", key: "c", want: 3, found: true},
			},
			wantLen: 2,
		},
		{
			name: "remove",
			size: 2,
			ops: []op{
				{kind: "add", key: "a", value: 1},
				{kind: "remove", key: "a", found: true},
				{kind: "remove", key: "a", found: false},
				{kind: "get", key: "a", found: false},
			},
		},
		{
			name: "size below one is clamped",
			size: 0,
			ops: []op{
				{kind: "add", key: "a", value: 1},
				{kind: "add", key: "b", value: 2},
				{kind: "get", key: "a", found: false},
				{kind: "get", key: "b", want: 2, found: true},
			},
			wantLen: 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			c := New[string, int](tt.size)
			for i, o := range tt.ops {
				switch o.kind {
				case "add":
					c.Add(o.key, o.value)
				case "get":
					got, ok := c.Get(o.key)
					if ok != o.found || got != o.want {
						t.Fatalf("op %d: Get(%q) = %d, %v; want %d, %v", i, o.key, got, ok, o.want, o.found)
					}
				case "remove":
					if ok := c.Remove(o.key); ok != o.found {
						t.Fatalf("op %d: Remove(%q) = %v; want %v", i, o.key, ok, o.found)
					}
				}
			}
			if got := c.Len(); got != tt.wantLen {
				t.Fatalf("Len() = %d; want %d", got, tt.wantLen)
			}
		})
	}
}

func TestLRUConcurrent(t *testing.T) {
	t.Parallel()
	c := New[string, int](16)
	var wg sync.WaitGroup
	for g := range 8 {
		wg.Go(func() {
			for i := range 1000 {
				key := fmt.Sprintf("k%d", (g*i)%32)
				c.Add(key, i)
				c.Get(key)
				if i%7 == 0 {
					c.Remove(key)
				}
			}
		})
	}
	wg.Wait()
	if n := c.Len(); n > 16 {
		t.Fatalf("Len() = %d exceeds size", n)
	}
}
