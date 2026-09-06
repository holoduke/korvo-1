/* Korvo-1 wall panel: LVGL touch UI controlling Home Assistant. */
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "bsp/esp32_s31_korvo.h"
#include "esp_core_dump.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "nvs_flash.h"

#include "climate_hist.h"
#include "ha_client.h"
#include "metrics.h"
#include "ota.h"
#include "panel_config.h"
#include "panel_ui.h"
#include "secrets.h"
#include "wifi_mgr.h"

static const char *TAG = "app_main";

static bool s_wifi_up;
static bool s_ha_up;
static bool s_ui_ready;         /* panel_ui_create() has run */
static bool s_services_started; /* HA client + OTA/web server are up */
static portMUX_TYPE s_svc_mux = portMUX_INITIALIZER_UNLOCKED;

/* Entities to subscribe to: every light tile + device + scene + weather +
 * the header temperature sensors. */
static const char *s_subscribed[PANEL_MAX_LIGHTS + 1 + 2 * PANEL_TEMP_SENSOR_COUNT];
static int s_subscribed_count;

/* Scene activation tracking: a scene's HA state is its last-activated timestamp,
 * so a change (after the initial value) means it was just activated. */
typedef struct {
    const char *id;
    char last[40];
    bool seen;
} scene_track_t;
static scene_track_t s_scenes[32];
static int s_scene_count;

static void add_subscribed(const char *id)
{
    for (int k = 0; k < s_subscribed_count; k++) {
        if (strcmp(s_subscribed[k], id) == 0) {
            return;
        }
    }
    if (s_subscribed_count < PANEL_MAX_LIGHTS) {
        s_subscribed[s_subscribed_count++] = id;
    }
}

static void track_scene(const char *id)
{
    for (int k = 0; k < s_scene_count; k++) {
        if (strcmp(s_scenes[k].id, id) == 0) {
            return;
        }
    }
    if (s_scene_count < (int)(sizeof(s_scenes) / sizeof(s_scenes[0]))) {
        s_scenes[s_scene_count].id = id;
        s_scenes[s_scene_count].seen = false;
        s_scene_count++;
    }
}

static void collect_subscribed_entities(void)
{
    for (int t = 0; t < (int)PANEL_TAB_COUNT; t++) {
        const panel_tab_t *tab = &PANEL_TABS[t];
        for (int i = 0; i < tab->light_count; i++) {
            add_subscribed(tab->lights[i].entity_id);
        }
        for (int i = 0; i < tab->device_count; i++) {
            add_subscribed(tab->devices[i].entity_id);
        }
        for (int i = 0; i < tab->scene_count; i++) {
            add_subscribed(tab->scenes[i].entity_id);
            track_scene(tab->scenes[i].entity_id);
        }
    }
    s_subscribed[s_subscribed_count++] = PANEL_WEATHER_ENTITY;
    for (int i = 0; i < (int)PANEL_TEMP_SENSOR_COUNT; i++) {
        s_subscribed[s_subscribed_count++] = PANEL_TEMP_SENSORS[i].temp_id;
        if (PANEL_TEMP_SENSORS[i].humidity_id) {
            s_subscribed[s_subscribed_count++] = PANEL_TEMP_SENSORS[i].humidity_id;
        }
    }
}

static bool is_temp_sensor(const char *entity_id)
{
    for (int i = 0; i < (int)PANEL_TEMP_SENSOR_COUNT; i++) {
        if (strcmp(PANEL_TEMP_SENSORS[i].temp_id, entity_id) == 0) {
            return true;
        }
    }
    return false;
}

/* Index into PANEL_TEMP_SENSORS + kind for a climate entity id, or -1. */
static int climate_index(const char *entity_id, int *kind)
{
    for (int i = 0; i < (int)PANEL_TEMP_SENSOR_COUNT; i++) {
        if (strcmp(PANEL_TEMP_SENSORS[i].temp_id, entity_id) == 0) {
            *kind = CLIMATE_KIND_TEMP;
            return i;
        }
        if (PANEL_TEMP_SENSORS[i].humidity_id &&
            strcmp(PANEL_TEMP_SENSORS[i].humidity_id, entity_id) == 0) {
            *kind = CLIMATE_KIND_HUM;
            return i;
        }
    }
    *kind = -1;
    return -1;
}

static void on_ha_history(const char *entity_id, float value, time_t t)
{
    int kind;
    const int idx = climate_index(entity_id, &kind);
    if (idx >= 0) {
        climate_hist_put(idx, kind, value, t);
    }
}

/* Backfill the 24 h climate history once HA is up and the clock is set. The
 * requests are sent from a throwaway task (socket sends can block briefly;
 * the esp_timer task must not). */
static bool s_history_backfilled;
static void history_task(void *arg)
{
    (void)arg;
    for (int i = 0; i < (int)PANEL_TEMP_SENSOR_COUNT; i++) {
        ha_client_request_history(PANEL_TEMP_SENSORS[i].temp_id, 24);
        if (PANEL_TEMP_SENSORS[i].humidity_id) {
            ha_client_request_history(PANEL_TEMP_SENSORS[i].humidity_id, 24);
        }
        vTaskDelay(pdMS_TO_TICKS(150)); /* let HA answer one before the next */
    }
    ESP_LOGI(TAG, "requested 24 h climate history");
    vTaskDelete(NULL);
}

static void history_backfill_cb(void *arg)
{
    (void)arg;
    if (s_history_backfilled || !s_ha_up || !climate_time_valid(time(NULL))) {
        return;
    }
    s_history_backfilled = true;
    xTaskCreate(history_task, "history", 4096, NULL, 4, NULL);
}

static bool is_humidity_sensor(const char *entity_id)
{
    for (int i = 0; i < (int)PANEL_TEMP_SENSOR_COUNT; i++) {
        if (PANEL_TEMP_SENSORS[i].humidity_id &&
            strcmp(PANEL_TEMP_SENSORS[i].humidity_id, entity_id) == 0) {
            return true;
        }
    }
    return false;
}

/* A sensor's state is its reading as a string ("24.19"), or
 * "unavailable"/"unknown" -> NAN so the UI shows a placeholder. */
static float parse_sensor_value(const char *state)
{
    if (state == NULL) {
        return NAN;
    }
    char *end = NULL;
    const float v = strtof(state, &end);
    return (end != state) ? v : NAN;
}

static const char *scene_last_seen(const char *id)
{
    for (int k = 0; k < s_scene_count; k++) {
        if (strcmp(s_scenes[k].id, id) == 0) {
            return s_scenes[k].seen ? s_scenes[k].last : NULL;
        }
    }
    return NULL;
}

/* At boot, HA's initial dump gives every scene's last-activated timestamp
 * (ISO 8601, UTC, so lexical order = time order; "unknown" never sorts as
 * newest since it doesn't start with a digit). The newest one on the tab that
 * owns entity_id is shown as the active scene, so the panel doesn't start blank. */
static void show_newest_scene_on_tab(const char *entity_id)
{
    for (int t = 0; t < (int)PANEL_TAB_COUNT; t++) {
        const panel_tab_t *tab = &PANEL_TABS[t];
        bool owns = false;
        for (int i = 0; i < tab->scene_count; i++) {
            if (strcmp(tab->scenes[i].entity_id, entity_id) == 0) {
                owns = true;
                break;
            }
        }
        if (!owns) {
            continue;
        }
        const char *best_id = NULL, *best_ts = NULL;
        for (int i = 0; i < tab->scene_count; i++) {
            const char *ts = scene_last_seen(tab->scenes[i].entity_id);
            if (ts == NULL || ts[0] < '0' || ts[0] > '9') {
                continue;
            }
            if (best_ts == NULL || strcmp(ts, best_ts) > 0) {
                best_ts = ts;
                best_id = tab->scenes[i].entity_id;
            }
        }
        if (best_id) {
            panel_ui_set_scene_active(best_id);
        }
        return;
    }
}

/* A scene's state is a timestamp; if it changes after we've seen it once, the
 * scene was just activated (by a schedule, the app, a switch, or us). */
static void handle_scene_state(const char *entity_id, const char *state)
{
    if (state == NULL) {
        return;
    }
    for (int k = 0; k < s_scene_count; k++) {
        if (strcmp(s_scenes[k].id, entity_id) != 0) {
            continue;
        }
        const bool first = !s_scenes[k].seen;
        const bool changed = !first && strcmp(s_scenes[k].last, state) != 0;
        s_scenes[k].seen = true;
        strlcpy(s_scenes[k].last, state, sizeof(s_scenes[k].last));
        if (changed) {
            panel_ui_set_scene_active(entity_id);
        } else if (first) {
            show_newest_scene_on_tab(entity_id);
        }
        return;
    }
}

static void on_ha_state(const char *entity_id, const char *state,
                        float temperature, int brightness_pct)
{
    if (strcmp(entity_id, PANEL_WEATHER_ENTITY) == 0) {
        panel_ui_set_weather(state, temperature);
    } else if (is_temp_sensor(entity_id) || is_humidity_sensor(entity_id)) {
        if (state != NULL) { /* attribute-only updates carry no reading */
            const float v = parse_sensor_value(state);
            int kind;
            const int idx = climate_index(entity_id, &kind);
            if (kind == CLIMATE_KIND_TEMP) {
                panel_ui_set_temp_sensor(entity_id, v);
            } else {
                panel_ui_set_humidity(entity_id, v);
            }
            climate_hist_put(idx, kind, v, time(NULL));
        }
    } else if (strncmp(entity_id, "scene.", 6) == 0) {
        handle_scene_state(entity_id, state);
    } else {
        panel_ui_set_light_state(entity_id, state);
        if (brightness_pct >= 0) {
            panel_ui_set_light_brightness(entity_id, brightness_pct);
            panel_ui_set_area_brightness(entity_id, brightness_pct);
        }
    }
}

static void on_ha_forecast(const ha_forecast_day_t *days, int count)
{
    for (int i = 0; i < count; i++) {
        panel_ui_set_forecast_day(i, days[i].condition, days[i].temp);
    }
}

static void on_light_caps(const char *entity_id, int caps, int min_k, int max_k)
{
    panel_ui_set_light_caps(entity_id, caps, min_k, max_k);
}

static void on_set_color(const char *entity_id, int hue, int sat)
{
    ha_client_set_color_hs(entity_id, hue, sat);
}

static void on_set_warmth(const char *entity_id, int kelvin)
{
    ha_client_set_color_temp(entity_id, kelvin);
}

static void on_ha_conn(bool connected)
{
    s_ha_up = connected;
    panel_ui_set_link_status(s_wifi_up, s_ha_up);
    if (connected) {
        ha_client_request_forecast(PANEL_WEATHER_ENTITY);
    }
}

static void on_scan_done(const char *const *ssids, const int8_t *rssi, int count)
{
    panel_ui_set_networks(ssids, rssi, count);
}

static void on_scan_request(void)
{
    wifi_mgr_scan_start(on_scan_done);
}

/* Runs once in its own task: starting SNTP, the HA client and the HTTP server
 * is too heavy for the system event task. */
static void services_task(void *arg)
{
    (void)arg;
    setenv("TZ", PANEL_TIMEZONE, 1);
    tzset();
    esp_sntp_config_t sntp_cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG(PANEL_SNTP_SERVER);
    esp_err_t err = esp_netif_sntp_init(&sntp_cfg);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SNTP init failed: %s", esp_err_to_name(err));
    }

    ha_client_set_forecast_cb(on_ha_forecast);
    ha_client_set_history_cb(on_ha_history);
    ha_client_set_caps_cb(on_light_caps);
    err = ha_client_start(HA_WEBSOCKET_URI, SECRET_HA_TOKEN,
                          s_subscribed, s_subscribed_count,
                          on_ha_state, on_ha_conn);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "HA client failed to start: %s", esp_err_to_name(err));
    }

    if (ota_start_server(SECRET_HA_TOKEN) != ESP_OK) {
        ESP_LOGW(TAG, "OTA server failed to start");
    }
    vTaskDelete(NULL);
}

/* The network services need both Wi-Fi (obviously) and the finished UI (so
 * HA's initial state dump lands on real tiles instead of being lost). Wi-Fi is
 * started before the UI is built, so whichever of the two comes second kicks
 * this off; the spinlock makes the start-once decision race-free between the
 * main task and the Wi-Fi event task. */
static void start_services_if_ready(void)
{
    bool go = false;
    portENTER_CRITICAL(&s_svc_mux);
    if (s_wifi_up && s_ui_ready && !s_services_started) {
        s_services_started = true;
        go = true;
    }
    portEXIT_CRITICAL(&s_svc_mux);
    if (go) {
        xTaskCreate(services_task, "services", 6144, NULL, 5, NULL);
    }
}

/* Settings-screen diagnostics: IP, RSSI, HA link. Cheap; runs every 5 s.
 * Doubles as the UI-lock watchdog: if the LVGL lock cannot be taken for 30 s
 * in a row the UI is dead while everything else runs; abort() then writes a
 * coredump of every task (the evidence) and the reboot restores the panel. */
static void net_details_cb(void *arg)
{
    (void)arg;
    static int lock_fails;
    if (bsp_display_lock(200)) {
        bsp_display_unlock();
        lock_fails = 0;
    } else if (++lock_fails >= 6) {
        ESP_LOGE(TAG, "LVGL lock stuck for 30 s -> coredump + reboot");
        abort();
    }
    char ip[16] = "";
    if (s_wifi_up) {
        esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
        esp_netif_ip_info_t info;
        if (sta && esp_netif_get_ip_info(sta, &info) == ESP_OK) {
            snprintf(ip, sizeof(ip), IPSTR, IP2STR(&info.ip));
        }
    }
    panel_ui_set_net_details(s_wifi_up ? ip : NULL, wifi_mgr_get_rssi(), s_ha_up);
}

/* Rollback safety net: a new image that never brings up the HTTP server (which
 * is what confirms it, see ota.c) is rolled back by rebooting into the
 * previous one instead of sitting there unreachable forever. */
static void rollback_deadline_cb(void *arg)
{
    (void)arg;
    const esp_partition_t *run = esp_ota_get_running_partition();
    esp_ota_img_states_t st;
    if (run && esp_ota_get_state_partition(run, &st) == ESP_OK &&
        st == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGE(TAG, "New firmware never came online -> rolling back");
        esp_ota_mark_app_invalid_rollback_and_reboot();
    }
}

static void on_wifi_status(bool connected)
{
    s_wifi_up = connected;
    /* Both UI setters are no-ops until the UI exists. */
    panel_ui_set_link_status(s_wifi_up, s_ha_up);

    char ssid[33] = {0};
    wifi_mgr_get_ssid(ssid, sizeof(ssid));
    panel_ui_set_wifi_connected(connected, ssid);

    if (connected) {
        start_services_if_ready();
    }
}

static void on_light_tap(const char *entity_id)
{
    ESP_LOGI(TAG, "Toggle %s", entity_id);
    if (ha_client_toggle_light(entity_id) != ESP_OK) {
        ESP_LOGW(TAG, "Toggle failed (not connected?)");
    }
}

static void on_scene_tap(const char *entity_id)
{
    ESP_LOGI(TAG, "Activate %s", entity_id);
    if (ha_client_activate_scene(entity_id) != ESP_OK) {
        ESP_LOGW(TAG, "Scene activation failed (not connected?)");
    }
}

static void on_wifi_settings(const char *ssid, const char *password)
{
    ESP_LOGI(TAG, "Wi-Fi settings -> reconnecting to '%s'", ssid);
    wifi_mgr_set_credentials(ssid, password);
}

static void on_brightness(const panel_entity_t *targets, int count, int brightness_pct)
{
    const char *ids[PANEL_MAX_LIGHTS];
    int n = 0;
    for (int i = 0; i < count && n < PANEL_MAX_LIGHTS; i++) {
        ids[n++] = targets[i].entity_id;
    }
    ESP_LOGI(TAG, "Set brightness %d%% on %d lights", brightness_pct, n);
    if (ha_client_set_brightness(ids, n, brightness_pct) != ESP_OK) {
        ESP_LOGW(TAG, "Set brightness failed (not connected?)");
    }
}

void app_main(void)
{
    ESP_LOGW(TAG, "boot: reset reason %d, running %s", (int)esp_reset_reason(),
             esp_ota_get_running_partition() ? esp_ota_get_running_partition()->label : "?");
    {
        const esp_partition_t *run = esp_ota_get_running_partition();
        esp_ota_img_states_t st;
        if (run && esp_ota_get_state_partition(run, &st) == ESP_OK &&
            st == ESP_OTA_IMG_PENDING_VERIFY) {
            ESP_LOGW(TAG, "boot: image pending verification, rollback armed (5 min)");
            const esp_timer_create_args_t a = { .callback = rollback_deadline_cb,
                                                .name = "rollback" };
            esp_timer_handle_t t;
            if (esp_timer_create(&a, &t) == ESP_OK) {
                esp_timer_start_once(t, 5ULL * 60 * 1000000);
            }
        }
    }

    /* A never-written coredump partition holds random flash contents, which the
     * core dump component reports as a corrupt image at every boot. Erase it
     * once so a real crash dump is unambiguous. */
    if (esp_core_dump_image_check() != ESP_OK) {
        esp_core_dump_image_erase();
    }

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    collect_subscribed_entities();
    climate_hist_init();

    /* Wi-Fi FIRST: esp_wifi_init() needs a sizeable chunk of internal (DMA
     * capable) RAM and fails with ESP_ERR_NO_MEM if the LVGL UI has already
     * filled it (LVGL objects are small mallocs that prefer internal RAM; once
     * that's gone they spill over into PSRAM, which is fine for the UI but not
     * for Wi-Fi). Connecting runs in the background while the display comes up. */
    err = wifi_mgr_start(SECRET_WIFI_SSID, SECRET_WIFI_PASS, on_wifi_status);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Wi-Fi failed to start: %s", esp_err_to_name(err));
    }

    /* Triple-buffer tear avoidance + PPA hardware acceleration for smooth,
     * tear-free rendering (the ESP32-S31 has a Pixel Processing Accelerator). */
    bsp_display_config_t display_cfg = BSP_DISPLAY_DEFAULT_CONFIG();
    display_cfg.tear_avoid_mode = ESP_LV_ADAPTER_TEAR_AVOID_MODE_TRIPLE_PARTIAL;
    /* PPA + dual-core SW rendering overflow the PPA fill queue under load, so
     * rely on dual-core parallel software rendering instead (LV_DRAW_SW_DRAW_UNIT_CNT=2).
     * The panel refreshes at ~60 Hz and LVGL is capped at 15 ms, so this reaches
     * the refresh ceiling without the PPA queue hazard. */
    display_cfg.enable_ppa_accel = false;
    display_cfg.task_stack_size = 12288; /* 8 KB left only ~2.3 KB headroom (see /api/tasks) */
    ESP_LOGI(TAG, "before display: internal heap free %u, low-water %u bytes",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    lv_display_t *disp = bsp_display_start_with_config(&display_cfg);
    if (disp == NULL) {
        ESP_LOGE(TAG, "Display init failed");
        return;
    }
    ESP_LOGI(TAG, "display up: internal heap free %u, low-water %u bytes",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    bsp_display_backlight_on();

    if (bsp_display_lock(-1)) {
        panel_ui_create(on_light_tap, on_scene_tap, on_brightness);
        panel_ui_set_color_callbacks(on_set_color, on_set_warmth);
        bsp_display_unlock();
    }
    ESP_LOGI(TAG, "UI built; internal heap free %u, low-water %u bytes",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));

    char ssid[33] = {0};
    wifi_mgr_get_ssid(ssid, sizeof(ssid));
    panel_ui_set_wifi_callback(on_wifi_settings, ssid);
    panel_ui_set_scan_callback(on_scan_request);
    /* Reflect a Wi-Fi link that may have come up while the UI was being built. */
    panel_ui_set_link_status(s_wifi_up, s_ha_up);
    panel_ui_set_wifi_connected(s_wifi_up, ssid);

    s_ui_ready = true;
    start_services_if_ready();

    const esp_timer_create_args_t nargs = { .callback = net_details_cb, .name = "netinfo" };
    esp_timer_handle_t ntimer;
    if (esp_timer_create(&nargs, &ntimer) == ESP_OK) {
        esp_timer_start_periodic(ntimer, 5ULL * 1000000);
    }
    const esp_timer_create_args_t hargs = { .callback = history_backfill_cb, .name = "hist" };
    esp_timer_handle_t htimer;
    if (esp_timer_create(&hargs, &htimer) == ESP_OK) {
        esp_timer_start_periodic(htimer, 10ULL * 1000000); /* polls until HA + clock are up */
    }

    /* Start telemetry sampling into the PSRAM ring buffer (served by the web
     * dashboard once Wi-Fi + the HTTP server are up). */
    metrics_start(disp);

    ESP_LOGI(TAG, "Wall panel running");
}
