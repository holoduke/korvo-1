/* Korvo-1 wall panel: LVGL touch UI controlling Home Assistant. */
#include <string.h>

#include "bsp/esp32_s31_korvo.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "freertos/FreeRTOS.h"
#include "nvs_flash.h"

#include "ha_client.h"
#include "panel_config.h"
#include "panel_ui.h"
#include "secrets.h"
#include "wifi_mgr.h"

static const char *TAG = "app_main";

static bool s_wifi_up;
static bool s_ha_up;

/* Entities to subscribe to: every light tile on every tab + the weather header. */
static const char *s_subscribed[PANEL_MAX_LIGHTS + 1];
static int s_subscribed_count;

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
    }
    s_subscribed[s_subscribed_count++] = PANEL_WEATHER_ENTITY;
}

static void on_ha_state(const char *entity_id, const char *state, float temperature)
{
    if (strcmp(entity_id, PANEL_WEATHER_ENTITY) == 0) {
        panel_ui_set_weather(state, temperature);
    } else {
        panel_ui_set_light_state(entity_id, state);
    }
}

static void on_ha_conn(bool connected)
{
    s_ha_up = connected;
    panel_ui_set_link_status(s_wifi_up, s_ha_up);
}

static void on_wifi_status(bool connected)
{
    s_wifi_up = connected;
    panel_ui_set_link_status(s_wifi_up, s_ha_up);

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

        err = ha_client_start(HA_WEBSOCKET_URI, SECRET_HA_TOKEN,
                              s_subscribed, s_subscribed_count,
                              on_ha_state, on_ha_conn);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "HA client failed to start: %s", esp_err_to_name(err));
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

static void on_brightness(const panel_entity_t *targets, int count, int step_pct)
{
    const char *ids[PANEL_MAX_LIGHTS];
    int n = 0;
    for (int i = 0; i < count && n < PANEL_MAX_LIGHTS; i++) {
        ids[n++] = targets[i].entity_id;
    }
    ESP_LOGI(TAG, "Brightness step %+d%% on %d lights", step_pct, n);
    if (ha_client_brightness_step(ids, n, step_pct) != ESP_OK) {
        ESP_LOGW(TAG, "Brightness step failed (not connected?)");
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
    /* Keep the BSP default buffer_height: larger stripes starve internal DMA RAM
     * and break Wi-Fi init, and we already hit the 60 Hz panel ceiling anyway. */
    display_cfg.task_stack_size = 8192;
    lv_display_t *disp = bsp_display_start_with_config(&display_cfg);
    if (disp == NULL) {
        ESP_LOGE(TAG, "Display init failed");
        return;
    }
    bsp_display_backlight_on();

    if (bsp_display_lock(-1)) {
        panel_ui_create(on_light_tap, on_scene_tap, on_brightness);
        bsp_display_unlock();
    }

    err = wifi_mgr_start(SECRET_WIFI_SSID, SECRET_WIFI_PASS, on_wifi_status);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Wi-Fi failed to start: %s", esp_err_to_name(err));
    }

    ESP_LOGI(TAG, "Wall panel running");
}
