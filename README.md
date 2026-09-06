# Korvo wall panel

Home Assistant wall panel firmware for the **ESP32-S31-Korvo-1** dev board
(4.3" 800×480 touch LCD). ESP-IDF 6.2 + LVGL 9; talks to Home Assistant over
its WebSocket API. Dutch UI.

- Tabs per zone: scene tiles (Beneden, Garage) or light tiles (Boven, Zolder),
  a per-zone brightness slider, an "Alle lampen" drawer with every individual
  lamp, long-press for brightness/colour.
- Header: 4-day Buienradar forecast, five room climate sensors coloured
  against comfort bands, clock, link status.
- Tap a header sensor for a 24 h temperature/humidity chart with min/max and
  a ventilation advice (absolute humidity indoors vs outdoors).
- Settings: Wi-Fi provisioning, screensaver timeout and mode ("Scherm uit" or
  the animated **AI oog**), six colour themes, connection and firmware
  diagnostics.
- Boot splash and screensaver artwork generated with xAI grok-imagine
  (`secrets/xai_key.txt`); assets live in `main/assets/` as raw RGB565.
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
| `tools/screenshot.py out.png [--tab N] [--drawer 0/1] [--settings 0/1] [--climate N] [--saver 0/1] [--theme N]` | Screenshot over Wi-Fi (bearer token); `--theme` restarts into a theme |
| `GET /api/status` | build hash, partition, uptime, reset reason, heap, display counters (`lcd_vsyncs`, `fb_recoveries`), screen state |
| `GET /api/intr`, `POST /api/reboot[?hard=1]`, `POST /api/panic` | interrupt table, clean restart, forced coredump (token) |
| `GET /api/tasks` | task table: state, priority, core, stack headroom, CPU share |
| `GET /api/metrics[?since=t]` | telemetry ring buffer (JSON) |
| `idf.py coredump-info -p <port>` | read a crash dump from the coredump partition |

## Safety nets

- **Full-chip resets**: on this ESP32-S31 (rev v0.0) a software reset leaves
  the RGB LCD controller and its DMA in a state where, in about half of the
  boots, no display interrupt ever reaches the CPU again (frozen or dark
  screen). Every restart therefore goes through the RTC watchdog (same effect
  as a power cycle); a boot arriving via any other reset does that once,
  after confirming a freshly updated image (`main/sys_reset.c`).

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
