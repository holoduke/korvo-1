/* LVGL user interface for the wall panel. */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "panel_config.h"

typedef void (*panel_ui_light_cb_t)(const char *entity_id);
typedef void (*panel_ui_scene_cb_t)(const char *entity_id);
/* Set brightness of a set of light entities to an absolute percentage (0-100). */
typedef void (*panel_ui_brightness_cb_t)(const panel_entity_t *targets, int count, int brightness_pct);
/* User adjusted a light's colour (hue 0-359, sat 0-100) or warmth (kelvin) in
 * the long-press popup. */
typedef void (*panel_ui_color_cb_t)(const char *entity_id, int hue, int sat);
typedef void (*panel_ui_warmth_cb_t)(const char *entity_id, int kelvin);

/* User entered new Wi-Fi credentials in the settings screen. */
typedef void (*panel_ui_wifi_cb_t)(const char *ssid, const char *password);
/* User tapped "select network"; the app should kick off a Wi-Fi scan and later
 * feed the results back via panel_ui_set_networks(). */
typedef void (*panel_ui_scan_cb_t)(void);

/* Register the Wi-Fi settings callback + prefill the current SSID. */
void panel_ui_set_wifi_callback(panel_ui_wifi_cb_t cb, const char *current_ssid);
/* Register the scan-request callback. */
void panel_ui_set_scan_callback(panel_ui_scan_cb_t cb);
/* Populate the network picker with scan results (thread-safe). */
void panel_ui_set_networks(const char *const *ssids, const int8_t *rssi, int count);
/* Update the Wi-Fi status shown in settings (thread-safe). */
void panel_ui_set_wifi_connected(bool connected, const char *ssid);

/* Build the UI. Call once, with the LVGL lock held. */
void panel_ui_create(panel_ui_light_cb_t light_cb, panel_ui_scene_cb_t scene_cb,
                     panel_ui_brightness_cb_t brightness_cb);

/* Bench helper: animate a tab switch (measures swipe rendering). */
void panel_ui_toggle_tab(void);

/* Diagnostic: snapshot the active screen and stream it (base64 RGB565) over the
 * serial console for host-side reconstruction. Call from a temporary trigger. */
void panel_ui_dump_screen(void);

/* Thread-safe updates (they take the LVGL lock themselves). */
void panel_ui_set_light_state(const char *entity_id, const char *state);
/* Highlight the scene chip for entity_id (clears the others on its tab). */
void panel_ui_set_scene_active(const char *entity_id);
/* Reflect a light's brightness on the area slider (if entity_id is a tab's
 * representative light and the user isn't dragging). */
void panel_ui_set_area_brightness(const char *entity_id, int brightness_pct);
/* Register colour/warmth callbacks for the long-press popup. */
void panel_ui_set_color_callbacks(panel_ui_color_cb_t color_cb, panel_ui_warmth_cb_t warmth_cb);
/* Report a light's colour capabilities (HA_LIGHT_* flags) + colour-temp range. */
void panel_ui_set_light_caps(const char *entity_id, int caps, int min_kelvin, int max_kelvin);

void panel_ui_set_weather(const char *condition, float temperature);
/* Set one day of the 3-day header forecast (idx 0 = today). */
void panel_ui_set_forecast_day(int idx, const char *condition, float temperature);
void panel_ui_set_link_status(bool wifi_up, bool ha_up);
