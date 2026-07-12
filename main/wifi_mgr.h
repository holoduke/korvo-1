/* Minimal Wi-Fi station manager with auto-reconnect. */
#pragma once

#include <stdbool.h>
#include "esp_err.h"

typedef void (*wifi_mgr_status_cb_t)(bool connected);

/** Delivers scan results: parallel arrays of SSID strings and RSSI, deduped. */
typedef void (*wifi_mgr_scan_cb_t)(const char *const *ssids, const int8_t *rssi, int count);

/**
 * Connect to the configured network. Credentials saved in NVS (via the settings
 * screen) take precedence over the compiled defaults passed here. The callback
 * fires on every connect/disconnect transition (from the system event task).
 */
esp_err_t wifi_mgr_start(const char *ssid, const char *password, wifi_mgr_status_cb_t cb);

/** Save new credentials to NVS and reconnect with them. */
esp_err_t wifi_mgr_set_credentials(const char *ssid, const char *password);

/** Copy the currently-configured SSID into out (out_len bytes). */
void wifi_mgr_get_ssid(char *out, int out_len);

/** Current AP signal strength in dBm, or 0 if not associated. */
int wifi_mgr_get_rssi(void);


/**
 * Start an asynchronous scan for nearby access points. When it completes, cb is
 * invoked once (from the Wi-Fi event task) with the deduped SSID list. Calling
 * again while a scan is in flight just updates the callback.
 */
esp_err_t wifi_mgr_scan_start(wifi_mgr_scan_cb_t cb);
