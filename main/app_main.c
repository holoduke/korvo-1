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

static void collect_subscribed_entities(void)
{
    for (int t = 0; t < (int)PANEL_TAB_COUNT; t++) {
        const panel_tab_t *tab = &PANEL_TABS[t];
        for (int i = 0; i < tab->light_count; i++) {
            const char *id = tab->lights[i].entity_id;
            bool seen = false;
            for (int k = 0; k < s_subscribed_count && !seen; k++) {
                seen = strcmp(s_subscribed[k], id) == 0;
            }
            if (!seen && s_subscribed_count < PANEL_MAX_LIGHTS) {
                s_subscribed[s_subscribed_count++] = id;
            }
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

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    collect_subscribed_entities();

    lv_display_t *disp = bsp_display_start();
    if (disp == NULL) {
        ESP_LOGE(TAG, "Display init failed");
        return;
    }
    bsp_display_backlight_on();

    if (bsp_display_lock(-1)) {
        panel_ui_create(on_light_tap, on_scene_tap);
        bsp_display_unlock();
    }

    err = wifi_mgr_start(SECRET_WIFI_SSID, SECRET_WIFI_PASS, on_wifi_status);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Wi-Fi failed to start: %s", esp_err_to_name(err));
    }

    ESP_LOGI(TAG, "Wall panel running");
}
