#!/bin/sh
# After installing or upgrading the lucid package (NFR-35). Arguments:
#   deb postinst:  configure [<old version>]   (old version only on upgrade)
#   rpm %post:     1 on install, 2 on upgrade
#   Arch:          post_install <new>, post_upgrade <new> <old>
# The service is never enabled or started here; a running one is restarted
# on upgrade so it runs the new binary.
[ -d /run/systemd/system ] || exit 0
systemctl daemon-reload
if [ "${1:-}" = 2 ] || [ -n "${2:-}" ]; then
  systemctl try-restart lucid.service
fi
