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
docker run --rm --network host -v "$PWD":/config ghcr.io/esphome/esphome:stable run wtw-duco.yaml --device 192.168.2.200
# over USB, only when it is plugged into the server (never ttyUSB0: that is the smart meter's P1 cable)
docker run --rm -v "$PWD":/config --device=/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0:/dev/ttyUSB9 \
  ghcr.io/esphome/esphome:stable run wtw-duco.yaml --device /dev/ttyUSB9
```

The board's USB-C has no CC resistors: a USB-C to USB-C cable gives it no
power or data from a Mac. Use a USB-A to USB-C data cable.
