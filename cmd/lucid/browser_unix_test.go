//go:build unix

package main

import "testing"

func TestDetachedProcAttr(t *testing.T) {
	t.Parallel()
	attr := detachedProcAttr()
	if attr == nil || !attr.Setsid {
		t.Errorf("detachedProcAttr() = %+v, want Setsid", attr)
	}
}
