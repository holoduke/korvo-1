/* 24-hour history of the header climate sensors (temperature + humidity) in
 * 5-minute slots, kept in PSRAM. Filled live from HA state updates and
 * backfilled from HA's history API after boot. Read by the Klimaat popup. */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <time.h>

#define CLIMATE_SLOT_S   300                    /* seconds per slot */
#define CLIMATE_SLOTS    (24 * 3600 / CLIMATE_SLOT_S) /* 288 = 24 h */
#define CLIMATE_KIND_TEMP 0
#define CLIMATE_KIND_HUM  1
#define CLIMATE_NONE     INT16_MIN              /* empty slot */

void climate_hist_init(void);

/* Store a reading (°C or %RH) for PANEL_TEMP_SENSORS[idx] taken at unix time t.
 * Values are kept as tenths. Safe to call from any task. */
void climate_hist_put(int idx, int kind, float value, time_t t);

/* Copy the last 24 h ending at `now` into out[CLIMATE_SLOTS] (oldest first,
 * tenths, CLIMATE_NONE for gaps). Returns the number of valid slots. */
int climate_hist_get(int idx, int kind, time_t now, int16_t *out);

/* Latest stored value (tenths) or CLIMATE_NONE; optionally the value about
 * `ago_s` seconds earlier for a trend. */
int16_t climate_hist_latest(int idx, int kind, time_t now, int ago_s);

/* Absolute humidity in g/m³ for a temperature (°C) and relative humidity (%). */
float climate_abs_humidity(float temp_c, float rh);

/* Wall clock is valid (SNTP synced) once the year is plausible. */
static inline bool climate_time_valid(time_t t)
{
    return t > 1700000000; /* 2023-11 */
}
