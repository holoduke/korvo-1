# ESPHome devices

## wtw-duco — the WTW (DucoBox Energy Comfort) with its own screen

`wtw-duco.yaml`: an ESP32-3248S035R "Cheap Yellow Display" on the Duco's
Connectivity header (UART 57600, 3.3 V; wiring in the file's header). It reads
and sets the Duco through kokx's component (esphome/esphome#7993) and shows the
stand, flow, temperatures, bypass and filter on its 3.5" touch screen, with
Auto · 1 · 2 · 3 buttons. Home Assistant has it through the ESPHome integration
(host 192.168.2.200, encrypted API).

Secrets live in `esphome/secrets.yaml` (gitignored): `wifi_ssid`,
`wifi_password`, `api_key`, `ota_password`, `fallback_password`. The keys are
also in `secrets/wtw_*.txt`.

### Build and update (from the HA server, ESPHome's Docker image)

```sh
scp esphome/wtw-duco.yaml esphome/secrets.yaml gillis@192.168.2.111:esphome-wtw/
ssh gillis@192.168.2.111
cd ~/esphome-wtw
# over Wi-Fi (the usual way)
docker run --rm --network host -v "$PWD":/config ghcr.io/esphome/esphome:2026.9.1 run wtw-duco.yaml --device 192.168.2.200
# over USB, only when it is plugged into the server (never ttyUSB0: that is the smart meter's P1 cable)
docker run --rm -v "$PWD":/config --device=/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0:/dev/ttyUSB9 \
  ghcr.io/esphome/esphome:2026.9.1 run wtw-duco.yaml --device /dev/ttyUSB9
```

Build with ESPHome **2026.9.1**, not `stable`: 2026.10.0 no longer loads the
Duco component (its `CONF_DISABLE_CRC` import fails), found 2026-10-22. The
component's source is pinned with `refresh: never` for the same reason.

The Duco CO2 room sensor (UCCO2, node 2) was added on 2026-10-22: in AUTO the
box follows it, so the flow rises with the CO2 (`sensor.wtw_co2`, ppm, and its
temperature).

The board's USB-C has no CC resistors: a USB-C to USB-C cable gives it no
power or data from a Mac. Use a USB-A to USB-C data cable.

## nibe-gw — the warmtepomp (NIBE F1253) locally, without myUplink

`nibe-gw.yaml`: a LilyGo T-CAN485 on the pump's accessory bus (AA3-X4 pins
9-12, where a MODBUS 40 would go; wiring in the file's header) that plays the
MODBUS 40 accessory (elupus/esphome-nibe v4.1.2). Home Assistant reads and
writes the pump through it with its own Nibe Heat Pump integration: connection
NibeGW, model F1155/F1255, the board's IP, ports 9999 (read) / 10000 (write),
listening port 9999. On 2026-10-22, 79 of the 108 points myUplink shows for
this pump had the same register and meaning in the F1155/F1255 list.

It also is a virtual room unit (RMU 40 on S1) fed with
`sensor.woonkamer_temperatuur` (package warmtepomp.yaml), so the pump can
regulate on the living rooms instead of its own BT50, which hangs warm.

Order on the day: flash the board (USB first, then OTA as below with
`esphome-nibe/` and `nibe-gw.yaml`), power the pump down, wire it, power up,
then menu 5.2.4: tick MODBUS 40 and RMU 40 S1. Then add the integration in HA.
Secrets: `nibe_api_key` in `esphome/secrets.yaml` (also `secrets/nibe_api_key.txt`).
Compiled clean with ESPHome 2026.9.1 on 2026-10-22.
