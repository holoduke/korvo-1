/* LVGL user interface for the wall panel. */
#pragma once

#include <stdbool.h>

#include "panel_config.h"

typedef void (*panel_ui_light_cb_t)(const char *entity_id);
typedef void (*panel_ui_scene_cb_t)(const char *entity_id);
/* Set brightness of a set of light entities to an absolute percentage (0-100). */
typedef void (*panel_ui_brightness_cb_t)(const panel_entity_t *targets, int count, int brightness_pct);

/* Build the UI. Call once, with the LVGL lock held. */
void panel_ui_create(panel_ui_light_cb_t light_cb, panel_ui_scene_cb_t scene_cb,
                     panel_ui_brightness_cb_t brightness_cb);

/* Thread-safe updates (they take the LVGL lock themselves). */
void panel_ui_set_light_state(const char *entity_id, const char *state);
/* Highlight the scene chip for entity_id (clears the others on its tab). */
void panel_ui_set_scene_active(const char *entity_id);
/* Reflect a light's brightness on the area slider (if entity_id is a tab's
 * representative light and the user isn't dragging). */
void panel_ui_set_area_brightness(const char *entity_id, int brightness_pct);
void panel_ui_set_weather(const char *condition, float temperature);
void panel_ui_set_link_status(bool wifi_up, bool ha_up);
