/* LVGL user interface for the wall panel. */
#pragma once

#include <stdbool.h>

#include "panel_config.h"

typedef void (*panel_ui_light_cb_t)(const char *entity_id);
typedef void (*panel_ui_scene_cb_t)(const char *entity_id);
/* Step brightness of a set of light entities by step_pct (may be negative). */
typedef void (*panel_ui_brightness_cb_t)(const panel_entity_t *targets, int count, int step_pct);

/* Build the UI. Call once, with the LVGL lock held. */
void panel_ui_create(panel_ui_light_cb_t light_cb, panel_ui_scene_cb_t scene_cb,
                     panel_ui_brightness_cb_t brightness_cb);

/* Thread-safe updates (they take the LVGL lock themselves). */
void panel_ui_set_light_state(const char *entity_id, const char *state);
void panel_ui_set_weather(const char *condition, float temperature);
void panel_ui_set_link_status(bool wifi_up, bool ha_up);
