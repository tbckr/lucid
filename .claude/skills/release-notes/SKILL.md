---
name: release-notes
description: Use when preparing a Lucid release or pre-release, before `just release` or `just prerelease`, or when asked to write or update release notes
---

# Release notes

Every Lucid release has hand-written notes in `.github/release-notes/`. `release.yml` publishes them instead of a commit list, and `just release` refuses a version without them. CONTRIBUTING.md ("Releases") says what goes into them; `.github/release-notes/v0.1.0.md` is an example.

## Steps

1. `just release-plan` names the next version, the file it needs and the commits since the last release.
2. Write that file from the commits' full messages (`git log <last release>..HEAD`), not their subjects alone. Check every claim against the code or the docs at HEAD: a variable's name, a default, an upgrade step.
3. Show the user the whole file, what you checked and what you are unsure of. Revise it until they approve it.
4. Only then commit it, as `docs: write the release notes for vX.Y.Z`. The user pushes and tags.

## The file

- One line per paragraph and per list item: a GitHub release page shows every line break.
- For users: what is new, what to do when upgrading, fixes worth knowing, what is untested or known to be broken. No commit hashes, no list of commits.
