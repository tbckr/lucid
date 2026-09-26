#!/usr/bin/env bash
# Coverage gate (NFR-05): fail if statement coverage of the business-logic
# packages drops below the threshold.
#
# Business logic = every package under internal/ except test helpers
# (internal/caldav/caldavtest). cmd/ and web/ are wiring and are not counted.
#
# Usage: scripts/coverage-gate.sh [coverage.out]
#   COVERAGE_MIN      minimum percentage (default: 80)
#   COVERAGE_EXCLUDE  extended regex of import paths to exclude
#                     (default: internal/caldav/caldavtest)
#
# The profile must come from `go test -coverprofile=... ./...` (Go >= 1.22
# reports packages without tests as 0%, so untested packages count against
# the total).
set -euo pipefail

profile="${1:-coverage.out}"
min="${COVERAGE_MIN:-80}"
module="$(go list -m)"
include="^${module}/internal/"
exclude="${COVERAGE_EXCLUDE:-/internal/caldav/caldavtest/}"

if [[ ! -s "$profile" ]]; then
  echo "coverage-gate: profile '$profile' not found or empty" >&2
  exit 2
fi

filtered="$(mktemp)"
trap 'rm -f "$filtered"' EXIT

# Keep the mode line, then only lines of business-logic packages.
head -n 1 "$profile" >"$filtered"
tail -n +2 "$profile" | grep -E "$include" | grep -Ev "$exclude" >>"$filtered" || true

if [[ "$(wc -l <"$filtered")" -le 1 ]]; then
  echo "coverage-gate: no business-logic packages found in '$profile'" >&2
  exit 2
fi

report="$(go tool cover -func="$filtered")"

# Per-package summary (statement-weighted) for a readable CI log.
echo "Per-package statement coverage (business logic):"
tail -n +2 "$filtered" | awk '
  {
    split($1, a, ":"); file = a[1]
    pkg = file; sub(/\/[^\/]*$/, "", pkg)
    stmts[pkg] += $2
    if ($3 > 0) covered[pkg] += $2
  }
  END {
    for (p in stmts) printf "  %6.1f%%  %s\n", (stmts[p] ? 100 * covered[p] / stmts[p] : 0), p
  }' | sort -k2

total="$(awk '/^total:/ { sub(/%/, "", $NF); print $NF }' <<<"$report")"
echo "Total business-logic coverage: ${total}% (minimum ${min}%)"

if awk -v t="$total" -v m="$min" 'BEGIN { exit !(t + 0 < m + 0) }'; then
  echo "coverage-gate: FAIL - coverage ${total}% is below ${min}%" >&2
  exit 1
fi
echo "coverage-gate: OK"
