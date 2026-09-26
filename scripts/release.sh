#!/usr/bin/env bash
# Tags HEAD of main and pushes the tag, which starts .github/workflows/release.yml
# (NFR-14). The workflow tests, builds, signs and publishes. Immutable releases
# cannot change once published: a broken release gets a new version, not a
# moved tag.
#
# Usage: scripts/release.sh <kind> <version>
#   stable VERSION  a release, e.g. 1.2.0 or v1.2.0
#   pre VERSION     a pre-release, e.g. 1.2.0-rc.1: marked as pre-release on
#                   GitHub, and only the exact image tag is pushed (not latest,
#                   MAJOR or MAJOR.MINOR)
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

[[ $# -eq 2 ]] || usage
kind=$1
version=${2#v}
tag="v$version"

# SemVer 2.0.0 without build metadata; release.yml accepts a superset.
core='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
ident='[0-9A-Za-z-]+'
[[ "$version" != *+* ]] || die "$tag: build metadata (+...) is not allowed in Docker image tags"
[[ "$version" =~ ^$core(-$ident(\.$ident)*)?$ ]] || die "$tag is not vMAJOR.MINOR.PATCH[-PRERELEASE]"
case "$kind" in
  stable) [[ "$version" != *-* ]] || die "$tag is a pre-release; use \`just prerelease $version\`" ;;
  pre) [[ "$version" == *-* ]] || die "$tag has no pre-release suffix (e.g. $version-rc.1)" ;;
  *) usage ;;
esac

branch="$(git symbolic-ref --quiet --short HEAD)" || die "HEAD is detached; check out main"
[[ "$branch" == main ]] || die "on branch $branch; releases are tagged on main"
[[ -z "$(git status --porcelain)" ]] || die "the working tree has uncommitted changes"

git fetch --quiet --tags origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] ||
  die "main and origin/main differ; push or pull first"
if tag_exists "$tag"; then
  die "$tag already exists"
fi
# A pre-release of an existing release would sort below it (SemVer 11.3).
if [[ "$kind" == pre ]] && tag_exists "v${version%%-*}"; then
  die "v${version%%-*} is already released; pick a higher version"
fi

echo "Release $tag ($kind) at $(git log -1 --format='%h %s')"
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
