//go:build !unix

package main

import "syscall"

// detachedProcAttr is nil off Unix, where there is no Setsid.
func detachedProcAttr() *syscall.SysProcAttr { return nil }
