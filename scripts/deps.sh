#!/usr/bin/env bash
# Dependency maintenance, see "Updating dependencies" in CONTRIBUTING.md.
#
# Usage: scripts/deps.sh <command>
#   outdated                    direct dependencies with newer versions (majors
#                               included) and the platform versions to review
#   upgrade [go|web|flake|all]  upgrade direct dependencies (default: all)
#   go-support                  fail if the Go release in go.mod is unsupported
#   nix-hashes                  recompute vendorHash and pnpmDeps.hash in
#                               nix/package.nix (needs `nix build`)
#
# Only direct dependencies are upgraded. Transitive versions change only where
# an upgraded direct dependency requires it:
#   - Go: `go get <module>@latest` per direct module. Minimal version selection
#     raises an indirect module only to the minimum the new version requires;
#     `go get -u` would raise indirect modules on its own.
#   - pnpm: `pnpm update --depth 0` keeps every locked version that still
#     satisfies the new ranges; without `--depth 0` it re-resolves the whole
#     tree.
# Major versions stay a manual step: a new module path in Go,
# `pnpm --dir web update --latest <package>` in the frontend.
set -euo pipefail

CDPATH='' cd -- "$(dirname -- "$0")/.."

usage() {
  sed -n '4,10s/^# \{0,1\}//p' "$0" >&2
  exit 2
}

upgrade_go() {
  local modules
  modules="$(go list -m -f '{{if not (or .Indirect .Main)}}{{.Path}}{{end}}' all |
    awk 'NF { print $0 "@latest" }')"
  if [[ -n "$modules" ]]; then
    # shellcheck disable=SC2086 # one module per word
    go get $modules
  fi
  go mod tidy
}

upgrade_web() {
  pnpm --dir web update --depth 0
}

upgrade_flake() {
  if ! command -v nix >/dev/null; then
    echo "deps: nix not found, flake.lock left unchanged" >&2
    return 0
  fi
  nix flake update
}

# The Go project supports the two most recent major releases; the list of
# releases comes from the golang.org/toolchain module on the module proxy.
go_support() {
  local current supported
  current="$(go list -m -f '{{.GoVersion}}' | cut -d. -f1,2)"
  supported="$(go list -m -versions -f '{{range .Versions}}{{println .}}{{end}}' golang.org/toolchain |
    sed -nE 's/^v0\.0\.1-go(1\.[0-9]+)\.[0-9]+\.linux-amd64$/\1/p' |
    sort -uV | tail -n 2 | paste -sd ' ')"
  if [[ " $supported " != *" $current "* ]]; then
    echo "Go $current (go.mod) no longer gets security fixes; supported: $supported." >&2
    echo "Raise the go directive in go.mod." >&2
    return 1
  fi
  echo "Go $current (go.mod) is supported; supported: $supported."
}

outdated() {
  echo "== Go: direct modules"
  go list -m -u -f '{{if and .Update (not .Indirect) (not .Main)}}{{.Path}} {{.Version}} -> {{.Update.Version}}{{end}}' all
  echo
  echo "== Frontend: direct packages"
  # Exits non-zero whenever something is outdated.
  pnpm --dir web outdated || true
  echo
  echo "== Platform"
  go_support || true
  echo "golangci-lint $(sed -nE 's/^ *GOLANGCI_LINT_VERSION: (v[0-9.]+).*/\1/p' .github/workflows/ci.yml) in ci.yml," \
    "latest $(go list -m -f '{{.Version}}' github.com/golangci/golangci-lint/v2@latest)"
  echo "nixpkgs $(sed -nE 's|.*github:NixOS/nixpkgs/([^"]+)".*|\1|p' flake.nix) in flake.nix"
  echo "Node.js $(sed -nE 's/^ *NODE_VERSION: "?([0-9]+)"?.*/\1/p' .github/workflows/ci.yml) in CI," \
    "$(sed -nE 's/^ *"node": "([^"]+)".*/\1/p' web/package.json) in web/package.json"
  echo "Base image $(sed -nE 's/^FROM (.+)/\1/p' Dockerfile)"
}

# Recomputes a fixed-output hash in nix/package.nix: blank it, build the
# derivation and take the correct hash from the mismatch error. Blanking
# matters: with the old hash, Nix may reuse a stale output from the store.
nix_hash() {
  local key=$1 attr=$2 file=nix/package.nix out got
  sed -i -E "s|^( *$key = )\"[^\"]*\";|\1\"\";|" "$file"
  out="$(nix build --no-link ".#$attr" 2>&1)" || true
  got="$(sed -nE 's/.*got: *(sha256-[A-Za-z0-9+/=]+).*/\1/p' <<<"$out" | tail -n 1)"
  if [[ -z "$got" ]]; then
    printf '%s\n' "$out" >&2
    echo "deps: no hash for .#$attr in the build output" >&2
    return 1
  fi
  sed -i -E "s|^( *$key = )\"\";|\1\"$got\";|" "$file"
  echo "$key = \"$got\""
}

nix_hashes() {
  local backup
  backup="$(mktemp)"
  cp nix/package.nix "$backup"
  if ! { nix_hash hash lucid.web.pnpmDeps && nix_hash vendorHash lucid.goModules; }; then
    cp "$backup" nix/package.nix
    rm -f "$backup"
    exit 1
  fi
  rm -f "$backup"
}

case "${1:-}" in
  outdated) outdated ;;
  upgrade)
    case "${2:-all}" in
      go) upgrade_go ;;
      web) upgrade_web ;;
      flake) upgrade_flake ;;
      all)
        upgrade_go
        upgrade_web
        upgrade_flake
        ;;
      *) usage ;;
    esac
    ;;
  go-support) go_support ;;
  nix-hashes) nix_hashes ;;
  *) usage ;;
esac
