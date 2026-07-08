#include "ha_client.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_websocket_client.h"

static const char *TAG = "ha_client";

#define HA_RX_BUFFER_SIZE (64 * 1024) /* initial subscribe payload can be large */
#define HA_WS_BUFFER_SIZE (16 * 1024)

static esp_websocket_client_handle_t s_client;
static ha_state_cb_t s_state_cb;
static ha_conn_cb_t s_conn_cb;
static const char *s_token;
static const char *const *s_entity_ids;
static int s_entity_count;
static int s_msg_id = 1;

static char *s_rx_buf;
static size_t s_rx_len;

static esp_err_t send_json(cJSON *root)
{
    char *text = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    ESP_RETURN_ON_FALSE(text != NULL, ESP_ERR_NO_MEM, TAG, "print json");

    const int sent = esp_websocket_client_send_text(s_client, text, strlen(text),
                                                    pdMS_TO_TICKS(5000));
    free(text);
    ESP_RETURN_ON_FALSE(sent >= 0, ESP_FAIL, TAG, "ws send failed");
    return ESP_OK;
}

static void send_auth(void)
{
    cJSON *msg = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "type", "auth");
    cJSON_AddStringToObject(msg, "access_token", s_token);
    if (send_json(msg) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to send auth");
    }
}

static void send_subscribe(void)
{
    cJSON *msg = cJSON_CreateObject();
    cJSON_AddNumberToObject(msg, "id", s_msg_id++);
    cJSON_AddStringToObject(msg, "type", "subscribe_entities");
    cJSON *ids = cJSON_AddArrayToObject(msg, "entity_ids");
    for (int i = 0; i < s_entity_count; i++) {
        cJSON_AddItemToArray(ids, cJSON_CreateString(s_entity_ids[i]));
    }
    if (send_json(msg) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to subscribe");
    }
}

static float read_temperature_attr(const cJSON *attrs)
{
    const cJSON *temp = cJSON_GetObjectItem(attrs, "temperature");
    return cJSON_IsNumber(temp) ? (float)temp->valuedouble : NAN;
}

/* Entity payload shapes (subscribe_entities):
 *   added:   {"a": {"<entity>": {"s": "on", "a": {...attrs}}}}
 *   changed: {"c": {"<entity>": {"+": {"s": "off", "a": {...attrs}}}}}
 */
static void handle_entity_object(const cJSON *entities, bool changed)
{
    const cJSON *entity;
    cJSON_ArrayForEach(entity, entities) {
        const cJSON *body = changed ? cJSON_GetObjectItem(entity, "+") : entity;
        if (body == NULL) {
            continue;
        }
        const cJSON *state = cJSON_GetObjectItem(body, "s");
        const cJSON *attrs = cJSON_GetObjectItem(body, "a");
        const float temperature = attrs ? read_temperature_attr(attrs) : NAN;
        if ((cJSON_IsString(state) || !isnan(temperature)) && s_state_cb) {
            s_state_cb(entity->string,
                       cJSON_IsString(state) ? state->valuestring : NULL,
                       temperature);
        }
    }
}

static void handle_message(const char *data, size_t len)
{
    cJSON *root = cJSON_ParseWithLength(data, len);
    if (root == NULL) {
        ESP_LOGW(TAG, "Unparseable message (%u bytes)", (unsigned)len);
        return;
    }

    const cJSON *type = cJSON_GetObjectItem(root, "type");
    if (!cJSON_IsString(type)) {
        cJSON_Delete(root);
        return;
    }

    if (strcmp(type->valuestring, "auth_required") == 0) {
        send_auth();
    } else if (strcmp(type->valuestring, "auth_ok") == 0) {
        ESP_LOGI(TAG, "Authenticated with Home Assistant");
        send_subscribe();
        if (s_conn_cb) {
            s_conn_cb(true);
        }
    } else if (strcmp(type->valuestring, "auth_invalid") == 0) {
        ESP_LOGE(TAG, "Auth REJECTED - check secrets/ha_token.txt");
    } else if (strcmp(type->valuestring, "event") == 0) {
        const cJSON *event = cJSON_GetObjectItem(root, "event");
        const cJSON *added = cJSON_GetObjectItem(event, "a");
        const cJSON *changes = cJSON_GetObjectItem(event, "c");
        if (added) {
            handle_entity_object(added, false);
        }
        if (changes) {
            handle_entity_object(changes, true);
        }
    } else if (strcmp(type->valuestring, "result") == 0) {
        const cJSON *ok = cJSON_GetObjectItem(root, "success");
        if (!cJSON_IsTrue(ok)) {
            char *txt = cJSON_PrintUnformatted(root);
            ESP_LOGW(TAG, "Command failed: %s", txt ? txt : "?");
            free(txt);
        }
    }
    cJSON_Delete(root);
}

static void on_ws_event(void *arg, esp_event_base_t base, int32_t event_id, void *event_data)
{
    const esp_websocket_event_data_t *ev = event_data;

    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "WebSocket connected, waiting for auth_required");
        s_rx_len = 0;
        break;

    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
        ESP_LOGW(TAG, "WebSocket disconnected");
        if (s_conn_cb) {
            s_conn_cb(false);
        }
        break;

    case WEBSOCKET_EVENT_DATA:
        /* Only text frames (opcode 1) and their continuations (opcode 0). */
        if (ev->op_code != 1 && ev->op_code != 0) {
            break;
        }
        if (ev->payload_offset == 0) {
            s_rx_len = 0;
        }
        if (ev->data_len > 0) {
            if (s_rx_len + ev->data_len > HA_RX_BUFFER_SIZE) {
                ESP_LOGE(TAG, "Message exceeds %d bytes, dropping", HA_RX_BUFFER_SIZE);
                s_rx_len = 0;
                break;
            }
            memcpy(s_rx_buf + s_rx_len, ev->data_ptr, ev->data_len);
            s_rx_len += ev->data_len;
        }
        if (ev->payload_offset + ev->data_len >= ev->payload_len && s_rx_len > 0) {
            handle_message(s_rx_buf, s_rx_len);
            s_rx_len = 0;
        }
        break;

    default:
        break;
    }
}

static esp_err_t call_service(const char *domain, const char *service, const char *entity_id)
{
    ESP_RETURN_ON_FALSE(s_client != NULL && esp_websocket_client_is_connected(s_client),
                        ESP_ERR_INVALID_STATE, TAG, "not connected");

    cJSON *msg = cJSON_CreateObject();
    cJSON_AddNumberToObject(msg, "id", s_msg_id++);
    cJSON_AddStringToObject(msg, "type", "call_service");
    cJSON_AddStringToObject(msg, "domain", domain);
    cJSON_AddStringToObject(msg, "service", service);
    cJSON *target = cJSON_AddObjectToObject(msg, "target");
    cJSON_AddStringToObject(target, "entity_id", entity_id);
    return send_json(msg);
}

esp_err_t ha_client_toggle_light(const char *entity_id)
{
    return call_service("light", "toggle", entity_id);
}

esp_err_t ha_client_activate_scene(const char *entity_id)
{
    return call_service("scene", "turn_on", entity_id);
}

esp_err_t ha_client_start(const char *uri, const char *token,
                          const char *const *entity_ids, int entity_count,
                          ha_state_cb_t state_cb, ha_conn_cb_t conn_cb)
{
    ESP_RETURN_ON_FALSE(token != NULL && strlen(token) > 20 && strcmp(token, "MISSING") != 0,
                        ESP_ERR_INVALID_ARG, TAG,
                        "HA token missing; see secrets/README.md");
    ESP_RETURN_ON_FALSE(s_client == NULL, ESP_ERR_INVALID_STATE, TAG, "already started");

    s_token = token;
    s_entity_ids = entity_ids;
    s_entity_count = entity_count;
    s_state_cb = state_cb;
    s_conn_cb = conn_cb;

    s_rx_buf = heap_caps_malloc(HA_RX_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    ESP_RETURN_ON_FALSE(s_rx_buf != NULL, ESP_ERR_NO_MEM, TAG, "rx buffer alloc");

    const esp_websocket_client_config_t cfg = {
        .uri = uri,
        .buffer_size = HA_WS_BUFFER_SIZE,
        .reconnect_timeout_ms = 5000,
        .network_timeout_ms = 10000,
        .task_stack = 6144,
    };
    s_client = esp_websocket_client_init(&cfg);
    ESP_RETURN_ON_FALSE(s_client != NULL, ESP_FAIL, TAG, "ws client init");

    ESP_RETURN_ON_ERROR(esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY,
                                                      on_ws_event, NULL),
                        TAG, "register events");
    ESP_RETURN_ON_ERROR(esp_websocket_client_start(s_client), TAG, "ws start");
    ESP_LOGI(TAG, "Connecting to %s", uri);
    return ESP_OK;
}
