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

## Verifying releases

All release artifacts and container images are signed with cosign (keyless).
See [Verifying releases](README.md#verifying-releases).
