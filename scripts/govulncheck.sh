#!/usr/bin/env bash
# govulncheck of the source for every OS Lucid is released for (NFR-11,
# NFR-35). The scan follows GOOS: code that only one OS builds, such as
# golang.org/x/sys/windows or prometheus/procfs on Linux, is only checked in
# that OS's scan.
#
# Usage: scripts/govulncheck.sh
#
# CGO_ENABLED=0 as in the release builds (.goreleaser.yaml), which also keeps
# a C compiler from being asked to build for another OS.
set -euo pipefail

bin="$(mktemp -d)"
trap 'rm -rf "$bin"' EXIT
# Installed once for this machine: with GOOS set, `go run` would build
# govulncheck for that OS instead.
GOBIN="$bin" go install golang.org/x/vuln/cmd/govulncheck@latest

status=0
for goos in linux darwin windows; do
  echo "== GOOS=$goos"
  GOOS="$goos" CGO_ENABLED=0 "$bin/govulncheck" ./... || status=1
done
exit "$status"
