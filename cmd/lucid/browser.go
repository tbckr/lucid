package main

import (
	"context"
	"os/exec"
	"runtime"
	"strings"
)

// browserCommand returns the command that opens url in the default browser on
// goos (FR-35).
func browserCommand(goos, url string) (name string, args []string) {
	switch goos {
	case "darwin":
		return "open", []string{url}
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", url}
	default:
		return "xdg-open", []string{url}
	}
}

// openBrowser opens url in the default browser. It returns once the launcher
// has started, not once the page has loaded.
func openBrowser(ctx context.Context, url string) error {
	name, args := browserCommand(runtime.GOOS, url)
	// The command is fixed per OS and the URL is Lucid's own loopback URL.
	cmd := exec.CommandContext(ctx, name, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }() // reap the launcher so it does not stay a zombie
	return nil
}

// keepWindowOpen reports whether main should wait for Enter before exiting
// after an error. Local mode on Windows starts from a double click, where the
// console window closes with the process and takes the error message along.
func keepWindowOpen(goos string, getenv func(string) string) bool {
	return goos == "windows" && strings.TrimSpace(getenv("LUCID_ADDR")) == ""
}
