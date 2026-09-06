#include "wifi_mgr.h"

#include <string.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs.h"

static const char *TAG = "wifi_mgr";
#define WIFI_NVS_NS "wifi"

#define WIFI_SCAN_MAX 20

static wifi_mgr_status_cb_t s_status_cb;
static char s_ssid[33];
static char s_pass[65];

static wifi_mgr_scan_cb_t s_scan_cb;
static bool s_scanning;
static bool s_connected;
static bool s_have_creds;
static char s_scan_ssids[WIFI_SCAN_MAX][33];
static const char *s_scan_ptrs[WIFI_SCAN_MAX];
static int8_t s_scan_rssi[WIFI_SCAN_MAX];

/* Reconnect with exponential backoff (1 s .. 32 s) instead of hammering the AP
 * from the event task; a pending retry is held back while a scan runs (a scan
 * fails with ESP_ERR_WIFI_STATE while the driver is mid-connect). */
static esp_timer_handle_t s_retry_timer;
static int s_retry_n;

static void retry_cb(void *arg)
{
    (void)arg;
    if (!s_connected && !s_scanning && s_have_creds) {
        esp_wifi_connect();
    }
}

static void schedule_retry(bool immediate)
{
    if (s_retry_timer == NULL || !s_have_creds) {
        return;
    }
    esp_timer_stop(s_retry_timer);
    uint32_t ms = 0;
    if (!immediate) {
        ms = 1000u << (s_retry_n < 5 ? s_retry_n : 5);
        if (s_retry_n < 5) {
            s_retry_n++;
        }
    }
    esp_timer_start_once(s_retry_timer, (uint64_t)ms * 1000ULL + 1000ULL);
}

static void handle_scan_done(void)
{
    uint16_t num = 0;
    esp_wifi_scan_get_ap_num(&num);
    static wifi_ap_record_t recs[WIFI_SCAN_MAX];
    if (num > WIFI_SCAN_MAX) {
        num = WIFI_SCAN_MAX;
    }
    if (esp_wifi_scan_get_ap_records(&num, recs) != ESP_OK) {
        num = 0;
    }
    int out = 0;
    for (int i = 0; i < num && out < WIFI_SCAN_MAX; i++) {
        const char *ssid = (const char *)recs[i].ssid;
        if (ssid[0] == '\0') {
            continue;
        }
        bool dup = false;
        for (int j = 0; j < out; j++) {
            if (strcmp(s_scan_ssids[j], ssid) == 0) {
                dup = true;
                break;
            }
        }
        if (dup) {
            continue;
        }
        strlcpy(s_scan_ssids[out], ssid, sizeof(s_scan_ssids[out]));
        s_scan_ptrs[out] = s_scan_ssids[out];
        s_scan_rssi[out] = recs[i].rssi;
        out++;
    }
    s_scanning = false;
    ESP_LOGI(TAG, "Scan done: %d networks", out);
    if (s_scan_cb) {
        s_scan_cb(s_scan_ptrs, s_scan_rssi, out);
    }
    if (!s_connected) {
        schedule_retry(true); /* resume the reconnect we held back for the scan */
    }
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        if (s_have_creds) {
            esp_wifi_connect();
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *ev = data;
        const bool was_up = s_connected;
        s_connected = false;
        ESP_LOGW(TAG, "Disconnected (reason %d), retry in %u s", ev ? ev->reason : -1,
                 (unsigned)(1u << (s_retry_n < 5 ? s_retry_n : 5)));
        if (was_up && s_status_cb) {
            s_status_cb(false);
        }
        schedule_retry(false);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        handle_scan_done();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *ev = data;
        ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&ev->ip_info.ip));
        s_connected = true;
        s_retry_n = 0;
        if (s_status_cb) {
            s_status_cb(true);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_LOST_IP) {
        ESP_LOGW(TAG, "Lost IP");
        s_connected = false;
        if (s_status_cb) {
            s_status_cb(false);
        }
    }
}

/* Load saved credentials from NVS into s_ssid/s_pass; returns true if found. */
static bool load_saved_credentials(void)
{
    nvs_handle_t h;
    if (nvs_open(WIFI_NVS_NS, NVS_READONLY, &h) != ESP_OK) {
        return false;
    }
    size_t sl = sizeof(s_ssid), pl = sizeof(s_pass);
    bool ok = nvs_get_str(h, "ssid", s_ssid, &sl) == ESP_OK &&
              nvs_get_str(h, "pass", s_pass, &pl) == ESP_OK && strlen(s_ssid) > 0;
    nvs_close(h);
    return ok;
}

static esp_err_t apply_and_connect(void)
{
    wifi_config_t cfg = { 0 };
    strlcpy((char *)cfg.sta.ssid, s_ssid, sizeof(cfg.sta.ssid));
    strlcpy((char *)cfg.sta.password, s_pass, sizeof(cfg.sta.password));
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &cfg), TAG, "set config");
    ESP_LOGI(TAG, "Connecting to '%s'...", s_ssid);
    return ESP_OK;
}

esp_err_t wifi_mgr_start(const char *ssid, const char *password, wifi_mgr_status_cb_t cb)
{
    s_status_cb = cb;

    /* Bring the stack up even without credentials, so the Settings screen can
     * scan and provision on a fresh device; only the initial connect is skipped. */
    s_have_creds = load_saved_credentials();
    if (!s_have_creds && ssid && password && strlen(ssid) > 0 && strcmp(ssid, "MISSING") != 0) {
        strlcpy(s_ssid, ssid, sizeof(s_ssid));
        strlcpy(s_pass, password, sizeof(s_pass));
        s_have_creds = true;
    }
    if (!s_have_creds) {
        ESP_LOGW(TAG, "No Wi-Fi credentials yet; set them in Settings");
    }

    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "netif init");
    ESP_RETURN_ON_ERROR(esp_event_loop_create_default(), TAG, "event loop");
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init_cfg), TAG, "wifi init");

    ESP_RETURN_ON_ERROR(esp_event_handler_instance_register(
                            WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL, NULL),
                        TAG, "wifi handler");
    ESP_RETURN_ON_ERROR(esp_event_handler_instance_register(
                            IP_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL, NULL),
                        TAG, "ip handler");

    const esp_timer_create_args_t targs = { .callback = retry_cb, .name = "wifi_retry" };
    ESP_RETURN_ON_ERROR(esp_timer_create(&targs, &s_retry_timer), TAG, "retry timer");

    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "set mode");
    if (s_have_creds) {
        ESP_RETURN_ON_ERROR(apply_and_connect(), TAG, "apply");
    }
    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "wifi start");
    return ESP_OK;
}

esp_err_t wifi_mgr_set_credentials(const char *ssid, const char *password)
{
    ESP_RETURN_ON_FALSE(ssid && password && strlen(ssid) > 0, ESP_ERR_INVALID_ARG,
                        TAG, "empty ssid");
    strlcpy(s_ssid, ssid, sizeof(s_ssid));
    strlcpy(s_pass, password, sizeof(s_pass));

    nvs_handle_t h;
    if (nvs_open(WIFI_NVS_NS, NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_str(h, "ssid", s_ssid);
        nvs_set_str(h, "pass", s_pass);
        nvs_commit(h);
        nvs_close(h);
    }

    /* New config first, then drop the link: the DISCONNECTED handler schedules
     * a reconnect with the new credentials. If we weren't associated, connect
     * right away. */
    s_have_creds = true;
    s_retry_n = 0;
    ESP_RETURN_ON_ERROR(apply_and_connect(), TAG, "apply");
    if (s_connected) {
        esp_wifi_disconnect();
    } else {
        schedule_retry(true);
    }
    return ESP_OK;
}

void wifi_mgr_get_ssid(char *out, int out_len)
{
    strlcpy(out, s_ssid, out_len);
}

int wifi_mgr_get_rssi(void)
{
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        return ap.rssi;
    }
    return 0; /* not associated */
}

esp_err_t wifi_mgr_scan_start(wifi_mgr_scan_cb_t cb)
{
    s_scan_cb = cb;
    if (s_scanning) {
        return ESP_OK;
    }
    s_scanning = true;
    if (s_retry_timer) {
        esp_timer_stop(s_retry_timer); /* don't start a connect under the scan */
    }
    wifi_scan_config_t sc = { .show_hidden = false };
    esp_err_t err = esp_wifi_scan_start(&sc, false);
    if (err == ESP_ERR_WIFI_STATE && !s_connected) {
        /* Mid-connect attempt: abort it and scan instead. */
        esp_wifi_disconnect();
        err = esp_wifi_scan_start(&sc, false);
    }
    if (err != ESP_OK) {
        s_scanning = false;
        ESP_LOGW(TAG, "Scan start failed: %s", esp_err_to_name(err));
        if (!s_connected) {
            schedule_retry(false);
        }
    }
    return err;
}
