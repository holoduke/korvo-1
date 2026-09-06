/* Home Assistant WebSocket API client.
 *
 * Authenticates with a long-lived token, subscribes to the configured
 * entities, and reports state changes. Also sends service calls
 * (light toggle, scene activation). Reconnects automatically.
 */
#pragma once

#include <stdbool.h>
#include <time.h>
#include "esp_err.h"

/* State update for one entity. temperature is NAN unless the entity carries a
 * temperature attribute (e.g. weather); brightness_pct is -1 unless the entity
 * carries a brightness attribute (lights). */
typedef void (*ha_state_cb_t)(const char *entity_id, const char *state,
                              float temperature, int brightness_pct);

/* Media player update: state ("playing"/"paused"/...) and media_title /
 * media_artist. Any argument may be NULL when the update did not carry it
 * (HA sends only changed attributes); keep the previous value then. */
typedef void (*ha_media_cb_t)(const char *entity_id, const char *state, const char *title,
                              const char *artist);
void ha_client_set_media_cb(ha_media_cb_t cb);

/* Fires on auth success (true) and on disconnect (false). */
typedef void (*ha_conn_cb_t)(bool connected);

/* Light colour capabilities (bit flags), derived from supported_color_modes. */
#define HA_LIGHT_COLOR  0x1  /* hs/rgb/xy: full colour */
#define HA_LIGHT_WARMTH 0x2  /* color_temp: tunable white */
/* Reports a light's capabilities + colour-temp range (kelvin) once known. */
typedef void (*ha_caps_cb_t)(const char *entity_id, int caps, int min_kelvin, int max_kelvin);
void ha_client_set_caps_cb(ha_caps_cb_t cb);

/* Set a light's colour (hue 0-359, saturation 0-100) or warmth (kelvin). */
esp_err_t ha_client_set_color_hs(const char *entity_id, int hue, int sat);
esp_err_t ha_client_set_color_temp(const char *entity_id, int kelvin);

/* One day of daily forecast. day[0] is today. */
typedef struct {
    char condition[24];
    float temp; /* daily high */
} ha_forecast_day_t;
typedef void (*ha_forecast_cb_t)(const ha_forecast_day_t *days, int count);

/* Register a callback for daily-forecast results. */
void ha_client_set_forecast_cb(ha_forecast_cb_t cb);

/* One historical numeric state: value at unix time t (from history/history_during_period). */
typedef void (*ha_history_cb_t)(const char *entity_id, float value, time_t t);
void ha_client_set_history_cb(ha_history_cb_t cb);
/* Ask HA for the last `hours` of a numeric sensor; points arrive via the
 * history callback (unparseable states such as "unavailable" are skipped).
 * entity_id must stay valid until the result arrives (config strings do). */
esp_err_t ha_client_request_history(const char *entity_id, int hours);

/* Request a fresh daily forecast for the given weather entity (result arrives
 * via the forecast callback). The entity is cached and re-fetched periodically. */
esp_err_t ha_client_request_forecast(const char *weather_entity_id);

esp_err_t ha_client_start(const char *uri, const char *token,
                          const char *const *entity_ids, int entity_count,
                          ha_state_cb_t state_cb, ha_conn_cb_t conn_cb);

/* Toggle a light (or any toggleable entity in the light domain). */
esp_err_t ha_client_toggle_light(const char *entity_id);

/* Activate a scene. */
esp_err_t ha_client_activate_scene(const char *entity_id);

/* Set the brightness of several lights to an absolute percentage (0-100).
 * Applies to all given entities at once. */
esp_err_t ha_client_set_brightness(const char *const *entity_ids, int count, int brightness_pct);
