#!/usr/bin/env bash
# Deploy the web panel to Home Assistant's www folder, served at
#   http://<ha-host>:8123/local/panel/index.html
#
# Usage: tools/web_deploy.sh [ssh-target]   (default gillis@192.168.2.111)
#
# Regenerates web/js/config.js from the firmware headers first, stamps every
# asset URL with a version (git sha + time) so browsers never run a stale mix of
# old and new files, then swaps the folder in atomically inside the
# homeassistant container.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-gillis@192.168.2.111}"
HOST="${TARGET#*@}"

python3 "$REPO/tools/gen_web_config.py"

SHA="$(git -C "$REPO" rev-parse --short HEAD)"
git -C "$REPO" diff --quiet -- web tools/gen_web_config.py main/panel_config.h main/themes.h || SHA="$SHA-dirty"
VERSION="$SHA-$(date +%Y%m%d%H%M%S)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$REPO/web/." "$STAGE/"
sed -i '' "s/__VERSION__/$VERSION/g" "$STAGE/index.html"

echo "Deploying web panel $VERSION to $TARGET ..."
tar -C "$STAGE" -cf - . | ssh -o BatchMode=yes "$TARGET" \
  'docker exec -i homeassistant sh -c "set -e; cd /config/www; rm -rf panel.new panel.old; mkdir panel.new; tar -xf - -C panel.new; if [ -d panel ]; then mv panel panel.old; fi; mv panel.new panel; rm -rf panel.old"'

URL="http://$HOST:8123/local/panel/index.html"
if curl -fsS -m 10 "$URL" | grep -q "$VERSION"; then
  echo "OK: $URL serves $VERSION"
else
  echo "Deployed, but $URL does not serve $VERSION yet" >&2
  exit 1
fi
