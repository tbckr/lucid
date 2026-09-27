# Security Policy

Lucid handles CalDAV credentials and proxies requests to user-supplied
servers, so we take security reports seriously.

## Supported versions

Lucid follows Semantic Versioning. Security fixes are released for the latest
minor version. Before 1.0.0 only the most recent release is supported.

| Version | Supported |
|---------|-----------|
| latest release | yes |
| older releases | no — please upgrade |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions or pull requests.**

Report them privately via GitHub's
[private vulnerability reporting](https://github.com/tbckr/lucid/security/advisories/new)
("Security" tab → "Report a vulnerability").

Please include:

- the affected version (`lucid --version`) and deployment type
  (binary, container, reverse proxy in use),
- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any suggested mitigation.

## What to expect

- Acknowledgement within **5 working days**.
- An initial assessment and severity rating within **14 days**.
- We aim to release a fix within **90 days**, faster for critical issues, and
  will coordinate the disclosure date with you.
- Fixed vulnerabilities are published as GitHub Security Advisories (with a
  CVE where appropriate). Reporters are credited unless they prefer otherwise.

## Scope

In scope, for example:

- authentication and session handling, credential exposure,
- SSRF bypasses (reaching internal networks despite the safe transport),
- CSRF, XSS, injection (XML/iCalendar), open redirects,
- rate-limit bypasses with security impact,
- issues in the published binaries or container images.

Out of scope:

- deployments without TLS or with `LUCID_COOKIE_INSECURE=true`,
  `LUCID_ALLOW_PRIVATE_NETWORKS=true` or `LUCID_TRUST_PROXY_HEADERS=true`
  in an unprotected setup (these are documented as unsafe),
- logouts on restart (documented known limitation),
- vulnerabilities in the CalDAV server itself,
- `cmd/lucid-mockdav`, which is a development tool and not shipped.

## Vulnerabilities in dependencies

Dependencies are scanned daily, on `main` and in the latest release,
including its binary and container image (see
[Updating dependencies](CONTRIBUTING.md#updating-dependencies)). A
vulnerability that affects Lucid is handled like a reported one, with a patch
release and a GitHub Security Advisory. Scanner reports about dependencies
are welcome when they show that Lucid is affected, for example with
`govulncheck` output; a vulnerable version alone does not mean Lucid calls
the vulnerable code.

## Supply chain

- Releases and images are signed (cosign keyless) and come with SBOMs.
- CI actions are pinned to commit SHAs.
- `govulncheck` and `pnpm audit` check the shipped packages daily, on `main`
  and on the latest release; a malware check covers all frontend packages.
- CI runs weekly against the newest direct dependencies.
- The release job runs no dependency code next to the signing identity.
- CodeQL analyzes the code, and Grype scans the container image on every
  release and daily for the latest one and its current base image.

## Verifying releases

Pushing a tag `vX.Y.Z` runs [GoReleaser](https://goreleaser.com/) in GitHub
Actions, which publishes:

- archives for Linux, macOS and Windows (amd64/arm64) with SPDX SBOMs,
- `checksums.txt` signed with [cosign](https://github.com/sigstore/cosign)
  (keyless, GitHub OIDC) — bundle `checksums.txt.sigstore.json`,
- multi-arch images `ghcr.io/tbckr/lucid:X.Y.Z` (plus `X.Y`, `X`, `latest`),
  signed with cosign and carrying an SBOM attestation,
- GitHub build-provenance attestations for archives and images.

The release is published only once all of this exists. Releases are
immutable: after publication, neither the tag nor the assets can change.

```sh
VERSION=1.2.3   # without the leading "v"
IDENTITY='^https://github\.com/tbckr/lucid/\.github/workflows/release\.yml@refs/tags/v'
ISSUER=https://token.actions.githubusercontent.com

# 1. Verify the signed checksum file, then the archive against it
cosign verify-blob \
  --bundle checksums.txt.sigstore.json \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER" \
  checksums.txt
sha256sum --ignore-missing -c checksums.txt

# 2. Verify the container image signature
cosign verify "ghcr.io/tbckr/lucid:${VERSION}" \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER"

# 3. Optional: verify GitHub build provenance
gh attestation verify "lucid_${VERSION}_linux_amd64.tar.gz" --repo tbckr/lucid
gh attestation verify "oci://ghcr.io/tbckr/lucid:${VERSION}" --repo tbckr/lucid
```
