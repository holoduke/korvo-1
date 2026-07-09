/* Over-the-air firmware update: a small HTTP server that accepts a firmware
 * image POSTed to /update, writes it to the inactive OTA slot, and reboots. */
#pragma once

#include "esp_err.h"

/* Start the OTA HTTP server (call after Wi-Fi is up). */
esp_err_t ota_start_server(void);
