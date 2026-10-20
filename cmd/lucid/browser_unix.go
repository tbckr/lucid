//go:build unix

package main

import "syscall"

// detachedProcAttr starts the browser launcher in its own session. On
// Linux and the BSDs xdg-open may leave the browser running as a descendant of
// Lucid; without its own session, closing Lucid's terminal (SIGHUP to the
// session) would close the person's whole browser, not just Lucid (FR-35).
func detachedProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
