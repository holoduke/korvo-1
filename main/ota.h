/* Over-the-air firmware update: a small HTTP server that accepts a firmware
 * image POSTed to /update, writes it to the inactive OTA slot, and reboots. */
#pragma once

#include <stdbool.h>

#include "esp_err.h"

/* Start the OTA HTTP server (call after Wi-Fi is up). Flashing via POST /update
 * requires an "Authorization: Bearer <auth_token>" header matching auth_token. */
esp_err_t ota_start_server(const char *auth_token);

/* True while a firmware upload is being written; other subsystems must not
 * reboot the device meanwhile (e.g. the HA link watchdog). */
bool ota_in_progress(void);
