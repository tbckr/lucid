#!/usr/bin/env bash
# Tags HEAD of main and pushes the tag, which starts .github/workflows/release.yml
# (NFR-14). The workflow tests, builds, signs and publishes. Immutable releases
# cannot change once published: a broken release gets a new version, not a
# moved tag.
#
# Usage: scripts/release.sh <kind> [version]
#   stable [VERSION]  a release, e.g. 1.2.0 or v1.2.0
#   pre [VERSION]     a pre-release, e.g. 1.2.0-rc.1: marked as pre-release on
#                     GitHub, and only the exact image tag is pushed (not latest,
#                     MAJOR or MAJOR.MINOR)
#   Without VERSION, the commits since the last release determine it.
#
# A computed version starts from the latest release reachable from HEAD.
# Pre-release tags never count as that base, so no version is skipped after
# vX.Y.Z-rc.N. Among the Conventional Commits since the base, a breaking change
# (type!: or a BREAKING CHANGE footer) bumps MAJOR, or MINOR while MAJOR is 0,
# so 1.0.0 is always an explicit choice. feat bumps MINOR, and any other commit
# PATCH. A pre-release appends -rc.N, counting up from 1.
#
# HEAD must be main, clean and equal to origin/main, and the tag must not exist.
# Build metadata (+...) is rejected because Docker image tags cannot contain "+".
set -euo pipefail

CDPATH='' cd -- "$(dirname -- "$0")/.."

usage() {
  sed -n '/^# Usage/,/^#$/{/^#$/d;s/^# \{0,1\}//;p}' "$0" >&2
  exit 2
}

die() {
  echo "release: $*" >&2
  exit 1
}

tag_exists() {
  git rev-parse --quiet --verify "refs/tags/$1" >/dev/null
}

# SemVer 2.0.0 without build metadata; release.yml accepts a superset.
core='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
ident='[0-9A-Za-z-]+'

# next_version sets version and why from the commits since the latest release
# (see the header). The logs are read into variables first: grep -q in a pipe
# can kill git log with SIGPIPE, which pipefail turns into a missed match.
next_version() {
  local base range major minor patch subjects bodies t n last=0
  base="$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' 2>/dev/null)" || base=""
  if [[ -n "$base" ]]; then
    [[ "${base#v}" =~ ^$core$ ]] || die "the latest release $base is not vMAJOR.MINOR.PATCH; pass the version"
    major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]} patch=${BASH_REMATCH[3]}
    range="$base..HEAD"
  else
    major=0 minor=0 patch=0 base="v0.0.0 (no release yet)"
    range=HEAD
  fi
  subjects="$(git log --format=%s "$range")"
  bodies="$(git log --format=%b "$range")"
  [[ -n "$subjects" ]] || die "no commits since $base; nothing to release"

  if grep -Eiq '^[a-z]+(\([^)]*\))?!:' <<<"$subjects" || grep -Eq '^BREAKING[ -]CHANGE:' <<<"$bodies"; then
    if ((major > 0)); then
      version="$((major + 1)).0.0" why="MAJOR over $base: breaking change"
    else
      version="0.$((minor + 1)).0" why="MINOR over $base: breaking change while MAJOR is 0"
    fi
  elif grep -Eiq '^feat(\([^)]*\))?:' <<<"$subjects"; then
    version="$major.$((minor + 1)).0" why="MINOR over $base: feat"
  else
    version="$major.$minor.$((patch + 1))" why="PATCH over $base: no feat or breaking change"
  fi
  [[ "$kind" == pre ]] || return 0

  t="$(git tag --points-at HEAD --list 'v[0-9]*-*')"
  [[ -z "$t" ]] || die "HEAD is already ${t%%$'\n'*}; a new pre-release needs new commits"
  while IFS= read -r t; do
    n=${t#"v$version-rc."}
    if [[ "$n" =~ ^(0|[1-9][0-9]*)$ ]] && ((n > last)); then
      last=$n
    fi
  done < <(git tag --list "v$version-rc.*")
  version="$version-rc.$((last + 1))"
}

[[ $# -eq 1 || $# -eq 2 ]] || usage
kind=$1
[[ "$kind" == stable || "$kind" == pre ]] || usage
version=${2-}
version=${version#v}
why=""

if [[ -n "$version" ]]; then
  tag="v$version"
  [[ "$version" != *+* ]] || die "$tag: build metadata (+...) is not allowed in Docker image tags"
  [[ "$version" =~ ^$core(-$ident(\.$ident)*)?$ ]] || die "$tag is not vMAJOR.MINOR.PATCH[-PRERELEASE]"
  case "$kind" in
    stable) [[ "$version" != *-* ]] || die "$tag is a pre-release; use \`just prerelease $version\`" ;;
    pre) [[ "$version" == *-* ]] || die "$tag has no pre-release suffix (e.g. $version-rc.1)" ;;
  esac
fi

branch="$(git symbolic-ref --quiet --short HEAD)" || die "HEAD is detached; check out main"
[[ "$branch" == main ]] || die "on branch $branch; releases are tagged on main"
[[ -z "$(git status --porcelain)" ]] || die "the working tree has uncommitted changes"

git fetch --quiet --tags origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] ||
  die "main and origin/main differ; push or pull first"
if [[ -z "$version" ]]; then
  next_version
fi
tag="v$version"
if tag_exists "$tag"; then
  die "$tag already exists"
fi
# A pre-release of an existing release would sort below it (SemVer 11.3).
if [[ "$kind" == pre ]] && tag_exists "v${version%%-*}"; then
  die "v${version%%-*} is already released; pick a higher version"
fi

echo "Release $tag ($kind) at $(git log -1 --format='%h %s')"
[[ -z "$why" ]] || echo "Computed: $why"
prev="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null)" || prev=""
if [[ -n "$prev" ]]; then
  echo "Commits since $prev:"
  git log --oneline --no-decorate "$prev..HEAD"
else
  echo "No earlier release: the changelog covers the whole history."
fi

answer=""
read -r -p "Push $tag? Once published, the release cannot change. [y/N] " answer || true
[[ "$answer" == [yY] ]] || die "aborted, nothing was tagged"

git tag -a "$tag" -m "$tag"
if ! git push --quiet origin "refs/tags/$tag"; then
  git tag -d "$tag" >/dev/null
  die "push failed; removed the local tag $tag"
fi
echo "Pushed $tag. Follow the release: https://github.com/tbckr/lucid/actions/workflows/release.yml"
