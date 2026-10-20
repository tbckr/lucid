package main

import (
	"slices"
	"testing"
)

func TestBrowserCommand(t *testing.T) {
	t.Parallel()
	const u = "http://127.0.0.1:3456/"
	tests := []struct {
		goos, name string
		args       []string
	}{
		{"darwin", "open", []string{u}},
		{"windows", "rundll32", []string{"url.dll,FileProtocolHandler", u}},
		{"linux", "xdg-open", []string{u}},
		{"freebsd", "xdg-open", []string{u}},
	}
	for _, tt := range tests {
		t.Run(tt.goos, func(t *testing.T) {
			t.Parallel()
			name, args := browserCommand(tt.goos, u)
			if name != tt.name || !slices.Equal(args, tt.args) {
				t.Errorf("browserCommand(%q) = %q %q, want %q %q", tt.goos, name, args, tt.name, tt.args)
			}
		})
	}
}

func TestKeepWindowOpen(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		goos string
		addr string
		want bool
	}{
		{"windows, local mode", "windows", "", true},
		{"windows, blank LUCID_ADDR counts as unset", "windows", "  ", true},
		{"windows, server mode", "windows", ":8080", false},
		{"linux, local mode", "linux", "", false},
		{"darwin, local mode", "darwin", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			getenv := envFunc(map[string]string{"LUCID_ADDR": tt.addr})
			if got := keepWindowOpen(tt.goos, getenv); got != tt.want {
				t.Errorf("keepWindowOpen(%q, LUCID_ADDR=%q) = %v, want %v", tt.goos, tt.addr, got, tt.want)
			}
		})
	}
}
