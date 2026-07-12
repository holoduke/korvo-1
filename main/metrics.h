/* On-device telemetry sampler.
 *
 * Periodically samples panel-health metrics (internal-RAM + PSRAM capacity,
 * Wi-Fi RSSI, render FPS, chip temperature) into a PSRAM ring buffer so the web
 * dashboard can chart them over a long window. All storage lives in PSRAM; the
 * sampler is a lightweight periodic esp_timer callback. */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* One time-series point. Sentinels: rssi==0 means "not associated";
 * temp_dc==INT16_MIN means "temperature unavailable". */
typedef struct {
    uint32_t t;          /* seconds since boot at sample time */
    uint32_t heap_free;  /* free internal RAM, bytes */
    uint32_t heap_min;   /* min-ever free internal RAM, bytes (low-water) */
    uint32_t psram_free; /* free PSRAM, bytes */
    int16_t  rssi;       /* Wi-Fi RSSI, dBm */
    int16_t  temp_dc;    /* chip temperature, deci-degrees Celsius */
    uint16_t fps;        /* render frames-per-second over the last interval */
} metric_sample_t;

typedef struct {
    uint32_t interval_s;  /* sampling period, seconds */
    uint32_t now_s;       /* current uptime, seconds */
    uint32_t heap_total;  /* total internal RAM, bytes */
    uint32_t psram_total; /* total PSRAM, bytes */
    int      count;       /* samples currently stored */
} metrics_meta_t;

/* Allocate the ring buffer and start sampling. `display` is the lv_display_t*
 * used for FPS stats (may be NULL to skip FPS). Safe to call once, early. */
void metrics_start(void *display);

/* Fill `out` with current metadata (thread-safe). */
void metrics_get_meta(metrics_meta_t *out);

/* Ring-buffer capacity in samples (use to size a metrics_copy() destination). */
int metrics_capacity(void);

/* Copy up to `max_samples` of the most-recent history into `dst`, oldest-first.
 * Returns the number copied. Thread-safe (snapshots under lock). */
int metrics_copy(metric_sample_t *dst, int max_samples);
