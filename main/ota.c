#include "ota.h"

#include <string.h>
#include <sys/param.h>

#include "esp_app_desc.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "sys_reset.h"
#include "web_ui.h"

static const char *TAG = "ota";

static const char *s_auth_token; /* required Bearer token for /update */
static volatile bool s_ota_busy;

bool ota_in_progress(void)
{
    return s_ota_busy;
}

/* Verify the request carries "Authorization: Bearer <s_auth_token>". */
static bool ota_authorized(httpd_req_t *req)
{
    if (s_auth_token == NULL || strlen(s_auth_token) < 8) {
        return false; /* no valid token configured -> refuse OTA */
    }
    char hdr[512];
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

bool ota_request_authorized(httpd_req_t *req)
{
    return ota_authorized(req);
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
    if (req->content_len <= 0 || req->content_len > part->size) {
        ESP_LOGW(TAG, "OTA rejected: bad length %d", req->content_len);
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad content length");
        return ESP_FAIL;
    }
    if (s_ota_busy) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "update already in progress");
        return ESP_FAIL;
    }
    s_ota_busy = true;
    ESP_LOGI(TAG, "OTA -> %s (%d bytes)", part->label, req->content_len);

    /* Sequential writes: erase sector by sector as data arrives instead of a
     * multi-second whole-partition erase up front (which stalls the socket). */
    esp_ota_handle_t handle = 0;
    esp_err_t err = esp_ota_begin(part, OTA_WITH_SEQUENTIAL_WRITES, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin: %s", esp_err_to_name(err));
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "ota_begin failed");
        s_ota_busy = false;
        return ESP_FAIL;
    }

    char *buf = malloc(4096);
    if (buf == NULL) {
        esp_ota_abort(handle);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no mem");
        s_ota_busy = false;
        return ESP_FAIL;
    }

    int remaining = req->content_len;
    int timeouts = 0;
    while (remaining > 0) {
        int r = httpd_req_recv(req, buf, MIN(remaining, 4096));
        if (r == HTTPD_SOCK_ERR_TIMEOUT && ++timeouts < 3) {
            continue; /* slow link: give the client another recv window */
        }
        if (r <= 0) {
            ESP_LOGW(TAG, "OTA recv failed (%d) with %d bytes left", r, remaining);
            err = ESP_FAIL;
            break;
        }
        timeouts = 0;
        if ((err = esp_ota_write(handle, buf, r)) != ESP_OK) {
            ESP_LOGE(TAG, "esp_ota_write: %s", esp_err_to_name(err));
            break;
        }
        remaining -= r;
    }
    free(buf);

    if (err != ESP_OK) {
        esp_ota_abort(handle);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "ota write failed");
        s_ota_busy = false;
        return ESP_FAIL;
    }
    if ((err = esp_ota_end(handle)) != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_end: %s", esp_err_to_name(err));
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "image validation failed");
        s_ota_busy = false;
        return ESP_FAIL;
    }
    /* Only accept images of this project: a stray factory demo .bin would
     * otherwise boot happily and strand the panel until a USB flash. */
    esp_app_desc_t nd;
    if (esp_ota_get_partition_description(part, &nd) != ESP_OK ||
        strcmp(nd.project_name, esp_app_get_description()->project_name) != 0) {
        ESP_LOGW(TAG, "OTA rejected: image is '%s', expected '%s'", nd.project_name,
                 esp_app_get_description()->project_name);
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "wrong project image");
        s_ota_busy = false;
        return ESP_FAIL;
    }
    if (esp_ota_set_boot_partition(part) != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "set boot failed");
        s_ota_busy = false;
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "OTA complete (%s %s), rebooting into %s", nd.version, nd.time, part->label);
    httpd_resp_sendstr(req, "OK - rebooting into new firmware\n");
    vTaskDelay(pdMS_TO_TICKS(700));
    esp_restart();
    return ESP_OK;
}

/* With bootloader rollback enabled, a freshly flashed image boots as
 * PENDING_VERIFY. Once the HTTP server is listening the panel can receive a
 * fixed image again, which is the property we actually care about, so that is
 * the moment to confirm it. (esp_ota_begin also refuses to run while the
 * running image is still pending.) */
static void confirm_running_image(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    esp_ota_img_states_t st;
    if (run && esp_ota_get_state_partition(run, &st) == ESP_OK &&
        st == ESP_OTA_IMG_PENDING_VERIFY) {
        if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
            ESP_LOGI(TAG, "New firmware confirmed on %s (rollback cancelled)", run->label);
            sys_reset_after_confirm(); /* may not return */
        }
    }
}

esp_err_t ota_start_server(const char *auth_token)
{
    s_auth_token = auth_token;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.stack_size = 12288;      /* OTA image verification + 2 KB JSON writer */
    config.max_open_sockets = 4;    /* leave lwIP sockets for HA/SNTP/DNS (needs +3) */
    config.max_uri_handlers = 12;
    config.lru_purge_enable = true;
    config.recv_wait_timeout = 20;
    config.send_wait_timeout = 20;

    httpd_handle_t server = NULL;
    esp_err_t err = httpd_start(&server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed: %s", esp_err_to_name(err));
        return err;
    }
    const httpd_uri_t update = { .uri = "/update", .method = HTTP_POST,
                                 .handler = update_post_handler };
    httpd_register_uri_handler(server, &update);
    web_ui_register(server); /* GET / dashboard + /api/status + /api/metrics */
    ESP_LOGI(TAG, "HTTP server ready: dashboard at /, OTA at POST /update");
    confirm_running_image();
    return ESP_OK;
}
