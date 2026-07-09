/* Home Assistant WebSocket API client.
 *
 * Authenticates with a long-lived token, subscribes to the configured
 * entities, and reports state changes. Also sends service calls
 * (light toggle, scene activation). Reconnects automatically.
 */
#pragma once

#include <stdbool.h>
#include "esp_err.h"

/* State update for one entity. temperature is NAN unless the entity
 * carries a temperature attribute (e.g. weather). */
typedef void (*ha_state_cb_t)(const char *entity_id, const char *state, float temperature);

/* Fires on auth success (true) and on disconnect (false). */
typedef void (*ha_conn_cb_t)(bool connected);

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
