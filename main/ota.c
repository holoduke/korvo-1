#include "ota.h"

#include <string.h>
#include <sys/param.h>

#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "ota";

static const char *s_auth_token; /* required Bearer token for /update */

/* Verify the request carries "Authorization: Bearer <s_auth_token>". */
static bool ota_authorized(httpd_req_t *req)
{
    if (s_auth_token == NULL || strlen(s_auth_token) < 8) {
        return false; /* no valid token configured -> refuse OTA */
    }
    char hdr[256];
    if (httpd_req_get_hdr_value_str(req, "Authorization", hdr, sizeof(hdr)) != ESP_OK) {
        return false;
    }
    const char *p = hdr;
    if (strncmp(p, "Bearer ", 7) == 0) {
        p += 7;
    }
    /* Length-checked compare (not constant-time, but good enough on a LAN). */
    return strcmp(p, s_auth_token) == 0;
}

/* GET / : tiny status page + how to update. */
static esp_err_t root_get_handler(httpd_req_t *req)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    char buf[256];
    const esp_app_desc_t *desc = esp_app_get_description();
    snprintf(buf, sizeof(buf),
             "Korvo wall panel\nrunning: %s\nversion: %s\ncompiled: %s %s\n"
             "POST firmware to /update to flash OTA.\n",
             running ? running->label : "?", desc->version, desc->date, desc->time);
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_sendstr(req, buf);
}

/* POST /update : stream the firmware body into the inactive OTA slot. */
static esp_err_t update_post_handler(httpd_req_t *req)
{
    if (!ota_authorized(req)) {
        ESP_LOGW(TAG, "OTA rejected: missing/invalid token");
        httpd_resp_send_err(req, HTTPD_401_UNAUTHORIZED, "unauthorized");
        return ESP_FAIL;
    }
    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
    if (part == NULL) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no OTA partition");
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "OTA -> %s (%d bytes)", part->label, req->content_len);

    esp_ota_handle_t handle = 0;
    if (esp_ota_begin(part, OTA_SIZE_UNKNOWN, &handle) != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "ota_begin failed");
        return ESP_FAIL;
    }

    char *buf = malloc(4096);
    if (buf == NULL) {
        esp_ota_abort(handle);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no mem");
        return ESP_FAIL;
    }

    int remaining = req->content_len;
    esp_err_t err = ESP_OK;
    while (remaining > 0) {
        int r = httpd_req_recv(req, buf, MIN(remaining, 4096));
        if (r <= 0) {
            err = ESP_FAIL;
            break;
        }
        if (esp_ota_write(handle, buf, r) != ESP_OK) {
            err = ESP_FAIL;
            break;
        }
        remaining -= r;
    }
    free(buf);

    if (err != ESP_OK || esp_ota_end(handle) != ESP_OK) {
        if (err != ESP_OK) {
            esp_ota_abort(handle);
        }
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "ota write failed");
        return ESP_FAIL;
    }
    if (esp_ota_set_boot_partition(part) != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "set boot failed");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "OTA complete, rebooting into %s", part->label);
    httpd_resp_sendstr(req, "OK - rebooting into new firmware\n");
    vTaskDelay(pdMS_TO_TICKS(700));
    esp_restart();
    return ESP_OK;
}

esp_err_t ota_start_server(const char *auth_token)
{
    s_auth_token = auth_token;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.stack_size = 8192;
    config.lru_purge_enable = true;
    config.recv_wait_timeout = 20;
    config.send_wait_timeout = 20;

    httpd_handle_t server = NULL;
    esp_err_t err = httpd_start(&server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed: %s", esp_err_to_name(err));
        return err;
    }
    const httpd_uri_t root = { .uri = "/", .method = HTTP_GET, .handler = root_get_handler };
    const httpd_uri_t update = { .uri = "/update", .method = HTTP_POST,
                                 .handler = update_post_handler };
    httpd_register_uri_handler(server, &root);
    httpd_register_uri_handler(server, &update);
    ESP_LOGI(TAG, "OTA server ready: POST firmware to /update");
    return ESP_OK;
}
