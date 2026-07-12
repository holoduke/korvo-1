/* Korvo-1 wall panel: LVGL touch UI controlling Home Assistant. */
#include <string.h>

#include "bsp/esp32_s31_korvo.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "freertos/FreeRTOS.h"
#include "nvs_flash.h"

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

/* Entities to subscribe to: every light tile + device + scene + weather. */
static const char *s_subscribed[PANEL_MAX_LIGHTS + 1];
static int s_subscribed_count;

/* Scene activation tracking: a scene's HA state is its last-activated timestamp,
 * so a change (after the initial value) means it was just activated. */
typedef struct {
    const char *id;
    char last[40];
    bool seen;
} scene_track_t;
static scene_track_t s_scenes[16];
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
        if (!s_scenes[k].seen) {
            s_scenes[k].seen = true;
        } else if (strcmp(s_scenes[k].last, state) != 0) {
            panel_ui_set_scene_active(entity_id);
        }
        strlcpy(s_scenes[k].last, state, sizeof(s_scenes[k].last));
        return;
    }
}

static void on_ha_state(const char *entity_id, const char *state,
                        float temperature, int brightness_pct)
{
    if (strcmp(entity_id, PANEL_WEATHER_ENTITY) == 0) {
        panel_ui_set_weather(state, temperature);
    } else if (strncmp(entity_id, "scene.", 6) == 0) {
        handle_scene_state(entity_id, state);
    } else {
        panel_ui_set_light_state(entity_id, state);
        if (brightness_pct >= 0) {
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

static void on_wifi_status(bool connected)
{
    s_wifi_up = connected;
    panel_ui_set_link_status(s_wifi_up, s_ha_up);

    char ssid[33] = {0};
    wifi_mgr_get_ssid(ssid, sizeof(ssid));
    panel_ui_set_wifi_connected(connected, ssid);

    static bool services_started;
    if (connected && !services_started) {
        services_started = true;

        setenv("TZ", PANEL_TIMEZONE, 1);
        tzset();
        esp_sntp_config_t sntp_cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG(PANEL_SNTP_SERVER);
        esp_err_t err = esp_netif_sntp_init(&sntp_cfg);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "SNTP init failed: %s", esp_err_to_name(err));
        }

        ha_client_set_forecast_cb(on_ha_forecast);
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
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    collect_subscribed_entities();

    /* Triple-buffer tear avoidance + PPA hardware acceleration for smooth,
     * tear-free rendering (the ESP32-S31 has a Pixel Processing Accelerator). */
    bsp_display_config_t display_cfg = BSP_DISPLAY_DEFAULT_CONFIG();
    display_cfg.tear_avoid_mode = ESP_LV_ADAPTER_TEAR_AVOID_MODE_TRIPLE_PARTIAL;
    /* PPA + dual-core SW rendering overflow the PPA fill queue under load, so
     * rely on dual-core parallel software rendering instead (LV_DRAW_SW_DRAW_UNIT_CNT=2).
     * The panel refreshes at ~60 Hz and LVGL is capped at 15 ms, so this reaches
     * the refresh ceiling without the PPA queue hazard. */
    display_cfg.enable_ppa_accel = false;
    display_cfg.task_stack_size = 8192;
    lv_display_t *disp = bsp_display_start_with_config(&display_cfg);
    if (disp == NULL) {
        ESP_LOGE(TAG, "Display init failed");
        return;
    }
    bsp_display_backlight_on();

    if (bsp_display_lock(-1)) {
        panel_ui_create(on_light_tap, on_scene_tap, on_brightness);
        panel_ui_set_color_callbacks(on_set_color, on_set_warmth);
        bsp_display_unlock();
    }

    /* Start telemetry sampling into the PSRAM ring buffer (served by the web
     * dashboard once Wi-Fi + the HTTP server are up). */
    metrics_start(disp);

    err = wifi_mgr_start(SECRET_WIFI_SSID, SECRET_WIFI_PASS, on_wifi_status);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Wi-Fi failed to start: %s", esp_err_to_name(err));
    }

    char ssid[33] = {0};
    wifi_mgr_get_ssid(ssid, sizeof(ssid));
    panel_ui_set_wifi_callback(on_wifi_settings, ssid);
    panel_ui_set_scan_callback(on_scan_request);

    ESP_LOGI(TAG, "Wall panel running");
}
