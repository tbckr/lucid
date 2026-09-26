# syntax=docker/dockerfile:1
#
# Runtime image for Lucid. This Dockerfile does NOT compile anything: GoReleaser
# (dockers_v2) builds the static binary and places it in the build context at
# $TARGETPLATFORM/lucid (e.g. linux/amd64/lucid).
#
# Local image build:  goreleaser release --snapshot --clean --skip=sign,sbom
#
# distroless/static: no shell, no package manager, CA certificates and tzdata
# included. The :nonroot variant runs as UID/GID 65532 (NFR-21).
FROM gcr.io/distroless/static-debian12:nonroot

ARG TARGETPLATFORM

LABEL org.opencontainers.image.title="lucid" \
      org.opencontainers.image.description="Modern CalDAV web client for calendars and tasks" \
      org.opencontainers.image.source="https://github.com/tbckr/lucid" \
      org.opencontainers.image.url="https://github.com/tbckr/lucid" \
      org.opencontainers.image.licenses="GPL-3.0-only"

COPY --chmod=0555 ${TARGETPLATFORM}/lucid /usr/local/bin/lucid

USER 65532:65532

ENV LUCID_ADDR=":8080"
EXPOSE 8080

# No shell/curl in distroless: the binary checks its own /healthz endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/lucid", "healthcheck"]

ENTRYPOINT ["/usr/local/bin/lucid"]
