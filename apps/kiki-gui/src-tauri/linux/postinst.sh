#!/bin/sh
set -eu

# The bundled sidecar is the same SEA executable as the standalone CLI.
source=/usr/bin/kiki-server
link=/usr/local/bin/kiki
if [ ! -x "$source" ]; then
  echo "Kiki CLI sidecar is missing: $source" >&2
  exit 1
fi
if [ -L "$link" ] && [ "$(readlink "$link")" = "$source" ]; then
  exit 0
fi
if [ -e "$link" ] || [ -L "$link" ]; then
  echo "Leaving existing $link untouched; link $source manually to enable the CLI." >&2
  exit 0
fi
mkdir -p /usr/local/bin
ln -s "$source" "$link"
