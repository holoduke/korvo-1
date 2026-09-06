#include "climate_hist.h"

#include <math.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"

#include "panel_config.h"

static const char *TAG = "climate";

#define N_SENSORS ((int)PANEL_TEMP_SENSOR_COUNT)

/* val[idx][kind][slot] holds tenths; stamp[idx][kind][slot] the slot number
 * (t / CLIMATE_SLOT_S) it belongs to, so a stale ring position is detectable. */
static int16_t (*s_val)[2][CLIMATE_SLOTS];
static uint32_t (*s_stamp)[2][CLIMATE_SLOTS];
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

void climate_hist_init(void)
{
    if (s_val) {
        return;
    }
    s_val = heap_caps_calloc(N_SENSORS, sizeof(*s_val), MALLOC_CAP_SPIRAM);
    s_stamp = heap_caps_calloc(N_SENSORS, sizeof(*s_stamp), MALLOC_CAP_SPIRAM);
    if (!s_val || !s_stamp) {
        ESP_LOGE(TAG, "history alloc failed");
        heap_caps_free(s_val);
        heap_caps_free(s_stamp);
        s_val = NULL;
        s_stamp = NULL;
        return;
    }
    ESP_LOGI(TAG, "24 h history for %d sensors (%d-s slots)", N_SENSORS, CLIMATE_SLOT_S);
}

void climate_hist_put(int idx, int kind, float value, time_t t)
{
    if (!s_val || idx < 0 || idx >= N_SENSORS || (kind != 0 && kind != 1) || isnan(value) ||
        !climate_time_valid(t)) {
        return;
    }
    const uint32_t slot = (uint32_t)(t / CLIMATE_SLOT_S);
    const int pos = (int)(slot % CLIMATE_SLOTS);
    const int16_t v = (int16_t)lroundf(value * 10.0f);
    portENTER_CRITICAL(&s_mux);
    s_val[idx][kind][pos] = v;
    s_stamp[idx][kind][pos] = slot;
    portEXIT_CRITICAL(&s_mux);
}

int climate_hist_get(int idx, int kind, time_t now, int16_t *out)
{
    int n = 0;
    for (int i = 0; i < CLIMATE_SLOTS; i++) {
        out[i] = CLIMATE_NONE;
    }
    if (!s_val || idx < 0 || idx >= N_SENSORS || (kind != 0 && kind != 1) ||
        !climate_time_valid(now)) {
        return 0;
    }
    const uint32_t newest = (uint32_t)(now / CLIMATE_SLOT_S);
    portENTER_CRITICAL(&s_mux);
    for (int i = 0; i < CLIMATE_SLOTS; i++) {
        const uint32_t slot = newest - (CLIMATE_SLOTS - 1) + i;
        const int pos = (int)(slot % CLIMATE_SLOTS);
        if (s_stamp[idx][kind][pos] == slot) {
            out[i] = s_val[idx][kind][pos];
            n++;
        }
    }
    portEXIT_CRITICAL(&s_mux);
    return n;
}

int16_t climate_hist_latest(int idx, int kind, time_t now, int ago_s)
{
    if (!s_val || idx < 0 || idx >= N_SENSORS || !climate_time_valid(now)) {
        return CLIMATE_NONE;
    }
    const uint32_t want = (uint32_t)((now - ago_s) / CLIMATE_SLOT_S);
    int16_t v = CLIMATE_NONE;
    portENTER_CRITICAL(&s_mux);
    /* Nearest filled slot at or before `want`, within 3 slots. */
    for (uint32_t k = 0; k < 3; k++) {
        const uint32_t slot = want - k;
        const int pos = (int)(slot % CLIMATE_SLOTS);
        if (s_stamp[idx][kind][pos] == slot) {
            v = s_val[idx][kind][pos];
            break;
        }
    }
    portEXIT_CRITICAL(&s_mux);
    return v;
}

float climate_abs_humidity(float t, float rh)
{
    /* Magnus formula: saturation vapour pressure (hPa) -> g/m³. */
    const float es = 6.112f * expf((17.62f * t) / (243.12f + t));
    const float e = es * rh / 100.0f;
    return 216.7f * e / (273.15f + t);
}
