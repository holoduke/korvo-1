#include "metrics.h"

#include <string.h>

#include "driver/temperature_sensor.h"
#include "esp_heap_caps.h"
#include "esp_lv_adapter.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "wifi_mgr.h"

static const char *TAG = "metrics";

#define METRICS_INTERVAL_S 5
/* 12 hours of history at one sample / 5 s. ~207 KB in PSRAM. */
#define METRICS_CAP (12 * 3600 / METRICS_INTERVAL_S)

static metric_sample_t *s_ring;    /* PSRAM-backed ring buffer */
static int s_head;                 /* next write slot */
static int s_count;                /* valid samples (<= METRICS_CAP) */
static SemaphoreHandle_t s_lock;
static temperature_sensor_handle_t s_tsens;
static lv_display_t *s_disp;
static esp_timer_handle_t s_timer;

static uint32_t uptime_s(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000000);
}

static void take_sample(void)
{
    metric_sample_t s = {
        .t = uptime_s(),
        .heap_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        .heap_min = heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
        .psram_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
        .rssi = (int16_t)wifi_mgr_get_rssi(),
        .temp_dc = INT16_MIN,
        .fps = 0,
    };

    if (s_tsens != NULL) {
        float c = 0.0f;
        if (temperature_sensor_get_celsius(s_tsens, &c) == ESP_OK) {
            s.temp_dc = (int16_t)(c * 10.0f);
        }
    }
    if (s_disp != NULL) {
        uint32_t fps = 0;
        if (esp_lv_adapter_get_fps(s_disp, &fps) == ESP_OK) {
            s.fps = (uint16_t)fps;
        }
        esp_lv_adapter_fps_stats_reset(s_disp); /* average over the next window */
    }

    if (xSemaphoreTake(s_lock, portMAX_DELAY) == pdTRUE) {
        s_ring[s_head] = s;
        s_head = (s_head + 1) % METRICS_CAP;
        if (s_count < METRICS_CAP) {
            s_count++;
        }
        xSemaphoreGive(s_lock);
    }
}

static void sample_timer_cb(void *arg)
{
    (void)arg;
    take_sample();
}

void metrics_start(void *display)
{
    if (s_ring != NULL) {
        return; /* already started */
    }
    s_disp = (lv_display_t *)display;

    s_ring = heap_caps_malloc(sizeof(metric_sample_t) * METRICS_CAP, MALLOC_CAP_SPIRAM);
    if (s_ring == NULL) {
        ESP_LOGE(TAG, "ring alloc failed (%d bytes) - telemetry disabled",
                 (int)(sizeof(metric_sample_t) * METRICS_CAP));
        return;
    }
    s_lock = xSemaphoreCreateMutex();
    if (s_lock == NULL) {
        ESP_LOGE(TAG, "mutex alloc failed - telemetry disabled");
        heap_caps_free(s_ring);
        s_ring = NULL;
        return;
    }

    /* Range must fit one predefined sensor range; 20..100 °C suits a warm SoC. */
    temperature_sensor_config_t tcfg = TEMPERATURE_SENSOR_CONFIG_DEFAULT(20, 100);
    if (temperature_sensor_install(&tcfg, &s_tsens) == ESP_OK &&
        temperature_sensor_enable(s_tsens) == ESP_OK) {
        ESP_LOGI(TAG, "chip temperature sensor ready");
    } else {
        s_tsens = NULL;
        ESP_LOGW(TAG, "temperature sensor unavailable");
    }

    if (s_disp != NULL) {
        esp_lv_adapter_fps_stats_enable(s_disp, true);
    }

    take_sample(); /* seed so the graph isn't empty at first fetch */

    const esp_timer_create_args_t targs = {
        .callback = sample_timer_cb,
        .name = "metrics",
    };
    if (esp_timer_create(&targs, &s_timer) == ESP_OK) {
        esp_timer_start_periodic(s_timer, (uint64_t)METRICS_INTERVAL_S * 1000000);
    }
    ESP_LOGI(TAG, "telemetry sampling every %ds, %d-sample history in PSRAM",
             METRICS_INTERVAL_S, METRICS_CAP);
}

void metrics_get_meta(metrics_meta_t *out)
{
    if (out == NULL) {
        return;
    }
    out->interval_s = METRICS_INTERVAL_S;
    out->now_s = uptime_s();
    out->heap_total = heap_caps_get_total_size(MALLOC_CAP_INTERNAL);
    out->psram_total = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
    out->count = 0;
    if (s_lock != NULL && xSemaphoreTake(s_lock, pdMS_TO_TICKS(500)) == pdTRUE) {
        out->count = s_count;
        xSemaphoreGive(s_lock);
    }
}

int metrics_capacity(void)
{
    return METRICS_CAP;
}

int metrics_copy(metric_sample_t *dst, int max_samples)
{
    if (s_ring == NULL || dst == NULL || max_samples <= 0) {
        return 0;
    }
    int n = 0;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(1000)) == pdTRUE) {
        n = s_count < max_samples ? s_count : max_samples;
        int oldest = (s_head - s_count + METRICS_CAP) % METRICS_CAP;
        int skip = s_count - n; /* drop the oldest if capped by max_samples */
        int idx = (oldest + skip) % METRICS_CAP;
        for (int i = 0; i < n; i++) {
            dst[i] = s_ring[idx];
            idx = (idx + 1) % METRICS_CAP;
        }
        xSemaphoreGive(s_lock);
    }
    return n;
}
