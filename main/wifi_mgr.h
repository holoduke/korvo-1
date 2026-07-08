/* Minimal Wi-Fi station manager with auto-reconnect. */
#pragma once

#include <stdbool.h>
#include "esp_err.h"

typedef void (*wifi_mgr_status_cb_t)(bool connected);

/**
 * Connect to the configured network. The callback fires on every
 * connect/disconnect transition (from the system event task).
 */
esp_err_t wifi_mgr_start(const char *ssid, const char *password, wifi_mgr_status_cb_t cb);
