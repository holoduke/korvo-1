# Korvo wall panel

Home Assistant wall panel firmware for the **ESP32-S31-Korvo-1** dev board
(4.3" 800×480 touch LCD). ESP-IDF 6.2 + LVGL 9; talks to Home Assistant over
its WebSocket API. Dutch UI.

- Tabs per zone: scene tiles (Beneden, Garage) or light tiles (Boven, Zolder),
  a per-zone brightness slider, an "Alle lampen" drawer with every individual
  lamp, long-press for brightness/colour.
- Header: 4-day Buienradar forecast, five room climate sensors coloured
  against comfort bands, clock, link status.
- Settings: Wi-Fi provisioning, screen-off timeout, connection and firmware
  diagnostics.
- On-device web dashboard with 12 h telemetry (`http://<panel>/`).

## Build

```sh
. ~/esp/esp-idf/export.sh          # ESP-IDF master (v6.2), esp32s31 is a preview target
idf.py --preview build
idf.py --preview -p /dev/cu.usbserial-XXXX -b 460800 flash
```

Secrets live in `secrets/` (gitignored, see `secrets/README.md`). The board
support package is vendored in `components/esp32_s31_korvo`; registry
dependencies are pinned in `main/idf_component.yml` and `dependencies.lock`
is tracked — bump one at a time and test on the board.

Configuration of tabs, scenes and sensors: `main/panel_config.h`.

## Deploy and verify

| Tool | Purpose |
|---|---|
| `tools/ota_push.sh [ip]` | OTA update (bearer token), waits for the reboot and confirms |
| `tools/screenshot.py out.png [--tab N] [--drawer 0/1] [--settings 0/1]` | Screenshot over Wi-Fi |
| `GET /api/status` | version, partition, uptime, reset reason, heap, touch recoveries |
| `GET /api/tasks` | task table: state, priority, core, stack headroom, CPU share |
| `GET /api/metrics[?since=t]` | telemetry ring buffer (JSON) |
| `idf.py coredump-info -p <port>` | read a crash dump from the coredump partition |

## Safety nets

- **Bootloader rollback**: a new image confirms itself once the HTTP server is
  up; otherwise it is rolled back (task watchdog panics a stuck core; a
  5-minute deadline covers a hang that keeps HTTP down).
- **Wi-Fi before UI**: Wi-Fi initialises first so it always gets internal RAM;
  LVGL allocations are routed to PSRAM (`main/lv_mem_psram.c`).
- **Software SHA**: the S31 hardware SHA engine hung the WPA handshake.
- **Touch I2C supervision**: finite transfer timeout plus bus reset after
  repeated failures (the GT1151 can lock the bus).
- **LVGL task watchdog**: a blocked UI task panics into a coredump and reboots.
- **HA link**: reconnects after HA restarts, re-subscribes if no states arrive,
  reboots after three fruitless reconnects (never during an OTA).
