#!/bin/sh
set -eu

case "${1:-}" in
  remove|purge) ;;
  *) exit 0 ;;
esac

link=/usr/local/bin/kiki
if [ -L "$link" ] && [ "$(readlink "$link")" = /usr/bin/kiki-server ]; then
  rm "$link"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
