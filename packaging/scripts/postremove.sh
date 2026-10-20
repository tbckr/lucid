#!/bin/sh
# After removing the lucid package (NFR-35): deb postrm, rpm %postun and Arch
# post_remove. systemd forgets the removed unit.
[ -d /run/systemd/system ] || exit 0
systemctl daemon-reload || true
