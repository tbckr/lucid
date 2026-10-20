#!/bin/sh
# Before removing the lucid package (NFR-35). Arguments:
#   deb prerm:   remove | upgrade <new> | failed-upgrade <old> | deconfigure ...
#   rpm %preun:  0 on removal, 1 on upgrade
#   Arch:        pre_remove <old>, on removal only
# On removal the service is stopped and disabled, so neither a running
# process nor an enablement link outlives the package.
[ -d /run/systemd/system ] || exit 0
case "${1:-}" in
  upgrade | failed-upgrade | 1) exit 0 ;;
esac
systemctl disable --now lucid.service || true
