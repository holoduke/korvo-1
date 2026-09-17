#!/usr/bin/env bash
# Deploy the web panel to Home Assistant's www folder (/config/www/panel), served
# with proper cache headers by the thuispaneel integration at
#   http://<ha-host>:8123/thuis/
# (also still reachable under /local/panel/, which HA caches for 31 days).
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
# Uncommitted work (unstaged, staged or untracked) deploys as "-dirty".
[ -z "$(git -C "$REPO" status --porcelain -- web tools/gen_web_config.py main/panel_config.h main/themes.h)" ] || SHA="$SHA-dirty"
VERSION="$SHA-$(date +%Y%m%d%H%M%S)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$REPO/web/." "$STAGE/"
sed "s/__VERSION__/$VERSION/g" "$REPO/web/index.html" > "$STAGE/index.html"
# Read by web/js/update.js past the HTTP cache: HA serves /local with a 31-day
# max-age, so open pages learn about a deploy from this file, not index.html.
printf '%s' "$VERSION" > "$STAGE/version.txt"
# A .gz next to each text asset: aiohttp's FileResponse (behind /thuis/ and
# /local/) serves it to a browser that accepts gzip, so the 550 KB of scripts
# and styles cross the Wi-Fi as about 130 KB. The originals stay for the rest.
find "$STAGE" -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.svg' \) -exec gzip -9 -k -n {} +

echo "Deploying web panel $VERSION to $TARGET ..."
tar -C "$STAGE" -cf - . | ssh -o BatchMode=yes "$TARGET" \
  'docker exec -i homeassistant sh -c "set -e; cd /config/www; rm -rf panel.new panel.old; mkdir panel.new; tar -xf - -C panel.new; if [ -d panel ]; then mv panel panel.old; fi; mv panel.new panel; rm -rf panel.old"'

# Served by the thuispaneel integration (ha/custom_components/thuispaneel) with
# no-cache on the page, so home-screen apps see the deploy on their next open.
URL="http://$HOST:8123/thuis/"
if curl -fsS -m 10 "$URL" | grep -q "$VERSION"; then
  echo "OK: $URL serves $VERSION"
else
  echo "Deployed, but $URL does not serve $VERSION yet" >&2
  exit 1
fi
