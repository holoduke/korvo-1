#!/usr/bin/env bash
# Push the built firmware to the wall panel over the air (authenticated).
#
# Usage:
#   tools/ota_push.sh [panel-ip]
#
# The panel IP defaults to $PANEL_IP or 192.168.2.160 (it's DHCP, so pass the
# current IP if it changed). The OTA endpoint requires the HA token as a Bearer
# token; it's read from secrets/ha_token.txt.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IP="${1:-${PANEL_IP:-192.168.2.160}}"
BIN="$REPO/build/korvo_wall_panel.bin"
TOKEN_FILE="$REPO/secrets/ha_token.txt"

[ -f "$BIN" ] || { echo "error: $BIN not found — run 'idf.py build' first"; exit 1; }
[ -f "$TOKEN_FILE" ] || { echo "error: $TOKEN_FILE not found"; exit 1; }
TOKEN="$(tr -d '\n\r ' < "$TOKEN_FILE")"

SIZE=$(wc -c < "$BIN" | tr -d ' ')
echo "Pushing $BIN ($SIZE bytes) to http://$IP/update ..."

# Show the running version first (unauthenticated status JSON).
curl -s -m 5 "http://$IP/api/status" | sed 's/^/  /' || true; echo

code=$(curl -s -m 120 -o /tmp/ota_resp.txt -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary "@$BIN" \
  "http://$IP/update")

echo "HTTP $code — $(cat /tmp/ota_resp.txt)"
case "$code" in
  200) echo "OK: panel is rebooting into the new firmware." ;;
  401) echo "Rejected: bad/missing token (check secrets/ha_token.txt)."; exit 1 ;;
  *)   echo "Failed (is the panel reachable at $IP?)."; exit 1 ;;
esac

# Wait for the new image to come up and confirm itself (bootloader rollback is
# armed until the HTTP server is listening; see ota.c confirm_running_image).
echo -n "Waiting for the panel to come back"
for i in $(seq 1 40); do
  sleep 3
  if st=$(curl -s -m 3 "http://$IP/api/status"); then
    echo; echo "  $st"
    case "$st" in
      *'"pending_verify":false'*) echo "Confirmed: new firmware is running and validated."; exit 0 ;;
      *) echo "Up, but still pending verification (it confirms itself within seconds)."; exit 0 ;;
    esac
  fi
  echo -n "."
done
echo; echo "Panel did not come back within 2 minutes. If it hung, the bootloader rolls"
echo "back to the previous image on the next reset (task watchdog reboots it)."
exit 1
