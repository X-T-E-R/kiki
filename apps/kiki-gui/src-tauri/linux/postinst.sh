#!/bin/sh
set -eu

# Refresh desktop MIME database for x-scheme-handler/kiki when available.
update_desktop_db() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
  fi
}

# The bundled sidecar is the same SEA executable as the standalone CLI.
source=/usr/bin/kiki-server
link=/usr/local/bin/kiki
if [ ! -x "$source" ]; then
  echo "Kiki CLI sidecar is missing: $source" >&2
  exit 1
fi

if [ -L "$link" ] && [ "$(readlink "$link")" = "$source" ]; then
  :
elif [ -e "$link" ] || [ -L "$link" ]; then
  echo "Leaving existing $link untouched; link $source manually to enable the CLI." >&2
else
  mkdir -p /usr/local/bin
  ln -s "$source" "$link"
fi

update_desktop_db
