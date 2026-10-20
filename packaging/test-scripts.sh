#!/usr/bin/env bash
# Tests the maintainer scripts of the Linux packages (packaging/scripts) with
# the arguments dpkg, rpm and pacman pass them, against a systemctl stub that
# records its calls. The scripts only act where systemd runs, so this needs a
# host booted with systemd (/run/systemd/system), like the CI runner.
#
# Usage: packaging/test-scripts.sh
set -euo pipefail

scripts="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/scripts"

if [[ ! -d /run/systemd/system ]]; then
  echo "test-scripts: needs a host booted with systemd (/run/systemd/system)" >&2
  exit 1
fi

stub="$(mktemp -d)"
trap 'rm -rf "$stub"' EXIT
cat >"$stub/systemctl" <<'EOF'
#!/bin/sh
echo "$*" >>"$CALLS"
[ -z "${SYSTEMCTL_FAILS:-}" ]
EOF
chmod +x "$stub/systemctl"

failed=0

# check SCRIPT EXPECTED [ARG...]: runs SCRIPT with ARGs and compares the
# systemctl calls, one per line, with EXPECTED ("" for none).
check() {
  local script=$1 expected=$2
  shift 2
  local calls="$stub/calls"
  : >"$calls"
  if ! PATH="$stub:$PATH" CALLS="$calls" sh "$scripts/$script.sh" "$@"; then
    echo "FAIL: $script $*: exited non-zero"
    failed=1
    return
  fi
  if [[ "$(cat "$calls")" != "$expected" ]]; then
    echo "FAIL: $script $*: got [$(paste -sd ';' "$calls")], want [${expected//$'\n'/;}]"
    failed=1
  fi
}

# tolerates SCRIPT [ARG...]: SCRIPT must succeed although every systemctl
# call fails, e.g. a service that does not start again after an upgrade: a
# failed maintainer script would leave the package half-installed.
tolerates() {
  local script=$1
  shift
  if ! PATH="$stub:$PATH" CALLS=/dev/null SYSTEMCTL_FAILS=1 sh "$scripts/$script.sh" "$@"; then
    echo "FAIL: $script $*: exited non-zero when systemctl failed"
    failed=1
  fi
}

reload=daemon-reload
restart=$'daemon-reload\ntry-restart lucid.service'
stop='disable --now lucid.service'

# deb postinst: configure [<old version>]
check postinstall "$reload" configure
check postinstall "$restart" configure 1.2.2
# rpm %post: 1 on install, 2 on upgrade
check postinstall "$reload" 1
check postinstall "$restart" 2
# Arch post_install <new>, post_upgrade <new> <old>
check postinstall "$reload" 0:1.2.3-1
check postinstall "$restart" 0:1.2.3-1 0:1.2.2-1

# deb prerm: remove | upgrade <new> | failed-upgrade <old>
check preremove "$stop" remove
check preremove "" upgrade 1.2.4
check preremove "" failed-upgrade 1.2.2
# rpm %preun: 0 on removal, 1 on upgrade
check preremove "$stop" 0
check preremove "" 1
# Arch pre_remove <old>, on removal only
check preremove "$stop" 0:1.2.3-1

# deb postrm remove, rpm %postun 0
check postremove "$reload" remove
check postremove "$reload" 0

tolerates postinstall configure 1.2.2
tolerates postinstall 2
tolerates preremove remove
tolerates postremove remove

if [[ $failed -ne 0 ]]; then
  exit 1
fi
echo "test-scripts: all cases passed"
