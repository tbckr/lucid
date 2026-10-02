#!/usr/bin/env bash
# Mutation testing (gremlins) of the business-logic packages, with the
# settings in .gremlins.yaml.
#
# Usage: scripts/mutation.sh [ref]
#   without ref  mutate everything and fail if test efficacy, the share of the
#                mutants that tests run which they also kill, drops below the
#                floor, like scripts/coverage-gate.sh for statement coverage
#                MUTATION_EFFICACY_MIN  minimum percentage (default: 85)
#   with ref     for local development: mutate only the lines changed since
#                the merge base with ref (uncommitted changes count, untracked
#                files only after `git add -N`) and list the mutants there
#                that no test kills (LIVED) or runs (NOT COVERED); no floor
#
# The floor leaves room below the first full run (October 2026: 90.7 %), also
# for equivalent mutants, which no test can kill and which cannot be marked
# yet (go-gremlins/gremlins#279). Mutant coverage has no floor: a NOT COVERED
# mutant sits on a line no test runs, which the coverage gate already checks.
#
# Only Go is mutation-tested. For the frontend, Stryker is the tool, but its
# Vitest runner (@stryker-mutator/vitest-runner 10.0.0) does not work with
# Vitest 5: mutants run no tests and count as survivors. src/lib/dates.ts
# scored 20.6 % on Vitest 5 and 97.9 % on Vitest 4.1 with the same tests
# (stryker-mutator/stryker-js#6210, #6213; the fixes #6214 and #6220 were
# unmerged in October 2026). Stryker's generic command runner is correct, but
# starts Vitest for every mutant, about 20 s each: ~11 h for src/lib.
#
# Caveats of gremlins, measured here:
#   - It counts every failing `go test` as KILLED, a mutant that does not
#     compile included.
#   - In a diff hunk with several changes, it skips all but the first
#     (go-gremlins/gremlins#301). So the diff it parses has no context lines
#     and ignores the user's Git configuration (diff.noprefix and the like).
#   - It ignores its --threshold-* flags, and a threshold in .gremlins.yaml
#     would also apply to diff runs. So the floor is checked here, against
#     the test efficacy in gremlins' report.
#   - Each mutant leaves several MB in the Go build cache, so the run uses a
#     throwaway one; it copies the module root, web/node_modules included,
#     once per worker. A full run needs ~5 GB in TMPDIR.
set -euo pipefail

CDPATH='' cd -- "$(dirname -- "$0")/.."

gremlins_version=v0.6.0
ref="${1:-}"
min="${MUTATION_EFFICACY_MIN:-85}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

args=(--config .gremlins.yaml --output "$tmp/report.json")
if [[ -n "$ref" ]]; then
  if git diff --quiet --merge-base "$ref" -- 'internal/*.go' ':(exclude)*_test.go' \
    ':(exclude)internal/caldav/caldavtest'; then
    # gremlins would mutate everything on an empty diff.
    echo "mutation: no business-logic Go changes since $ref"
    exit 0
  fi
  args+=(--diff "$ref" --output-statuses lc)
fi

GOBIN="$tmp/bin" go install "github.com/go-gremlins/gremlins/cmd/gremlins@$gremlins_version"
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.context GIT_CONFIG_VALUE_0=0 \
  GOCACHE="$tmp/gocache" TMPDIR="$tmp" "$tmp/bin/gremlins" unleash "${args[@]}" .
if [[ -n "$ref" ]]; then
  exit 0
fi

efficacy="$(jq -r '.test_efficacy' "$tmp/report.json")"
echo "Test efficacy (business logic): $(printf '%.1f' "$efficacy")% (minimum ${min}%)"
if awk -v e="$efficacy" -v m="$min" 'BEGIN { exit !(e + 0 < m + 0) }'; then
  echo "mutation: FAIL - test efficacy is below ${min}%" >&2
  exit 1
fi
echo "mutation: OK"
