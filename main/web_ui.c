#include "web_ui.h"

#include <stdio.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_timer.h"

#include "metrics.h"

static const char *TAG = "web_ui";

/* dashboard.html embedded via EMBED_TXTFILES (see main/CMakeLists.txt). */
extern const char dashboard_html_start[] asm("_binary_dashboard_html_start");
extern const char dashboard_html_end[] asm("_binary_dashboard_html_end");

/* ---- Chunked JSON writer ------------------------------------------------- */
/* Buffers output and flushes in ~2 KB chunks so a multi-thousand-point response
 * never needs one giant allocation. */
typedef struct {
    httpd_req_t *req;
    char buf[2048];
    int len;
    bool failed;
} json_writer_t;

static void jw_flush(json_writer_t *w)
{
    if (w->len > 0 && !w->failed) {
        if (httpd_resp_send_chunk(w->req, w->buf, w->len) != ESP_OK) {
            w->failed = true;
        }
        w->len = 0;
    }
}

static void jw_raw(json_writer_t *w, const char *s, int n)
{
    if (n > (int)sizeof(w->buf)) {
        return; /* single token never exceeds the buffer in practice */
    }
    if (w->len + n > (int)sizeof(w->buf)) {
        jw_flush(w);
    }
    memcpy(w->buf + w->len, s, n);
    w->len += n;
}

static void jw_str(json_writer_t *w, const char *s)
{
    jw_raw(w, s, (int)strlen(s));
}

static void jw_int(json_writer_t *w, long v)
{
    char t[16];
    jw_raw(w, t, snprintf(t, sizeof(t), "%ld", v));
}

/* ---- GET / --------------------------------------------------------------- */
static esp_err_t dashboard_get(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, dashboard_html_start,
                           dashboard_html_end - dashboard_html_start - 1);
}

/* ---- GET /api/status ----------------------------------------------------- */
static esp_err_t status_get(httpd_req_t *req)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_app_desc_t *desc = esp_app_get_description();
    char buf[320];
    int n = snprintf(buf, sizeof(buf),
                     "{\"version\":\"%s\",\"partition\":\"%s\",\"compiled\":\"%s %s\","
                     "\"idf\":\"%s\",\"uptime\":%llu}",
                     desc->version, running ? running->label : "?",
                     desc->date, desc->time, desc->idf_ver,
                     esp_timer_get_time() / 1000000ULL);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, buf, n);
}

/* Emit one columnar array: "name":[v0,v1,...]. `get` maps a sample to a value;
 * a NULL return from `is_null` writes JSON null for that point. */
static void emit_column(json_writer_t *w, const char *name,
                        const metric_sample_t *s, int n,
                        long (*get)(const metric_sample_t *),
                        bool (*is_null)(const metric_sample_t *))
{
    jw_str(w, name);
    jw_str(w, ":[");
    for (int i = 0; i < n; i++) {
        if (i) {
            jw_str(w, ",");
        }
        if (is_null && is_null(&s[i])) {
            jw_str(w, "null");
        } else {
            jw_int(w, get(&s[i]));
        }
    }
    jw_str(w, "]");
}

static long col_t(const metric_sample_t *s) { return s->t; }
static long col_heap(const metric_sample_t *s) { return s->heap_free; }
static long col_heap_min(const metric_sample_t *s) { return s->heap_min; }
static long col_psram(const metric_sample_t *s) { return s->psram_free; }
static long col_rssi(const metric_sample_t *s) { return s->rssi; }
static long col_temp(const metric_sample_t *s) { return s->temp_dc; }
static long col_fps(const metric_sample_t *s) { return s->fps; }
static bool null_rssi(const metric_sample_t *s) { return s->rssi == 0; }
static bool null_temp(const metric_sample_t *s) { return s->temp_dc == INT16_MIN; }

/* ---- GET /api/metrics ---------------------------------------------------- */
static esp_err_t metrics_get(httpd_req_t *req)
{
    int cap = metrics_capacity();
    metric_sample_t *samples =
        heap_caps_malloc(sizeof(metric_sample_t) * cap, MALLOC_CAP_SPIRAM);
    if (samples == NULL) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no mem");
        return ESP_FAIL;
    }
    int n = metrics_copy(samples, cap);

    metrics_meta_t meta;
    metrics_get_meta(&meta);

    httpd_resp_set_type(req, "application/json");
    json_writer_t w = { .req = req };

    jw_str(&w, "{");
    jw_str(&w, "\"interval\":");
    jw_int(&w, meta.interval_s);
    jw_str(&w, ",\"now\":");
    jw_int(&w, meta.now_s);
    jw_str(&w, ",\"heap_total\":");
    jw_int(&w, meta.heap_total);
    jw_str(&w, ",\"psram_total\":");
    jw_int(&w, meta.psram_total);
    jw_str(&w, ",");
    emit_column(&w, "\"t\"", samples, n, col_t, NULL);
    jw_str(&w, ",");
    emit_column(&w, "\"heap\"", samples, n, col_heap, NULL);
    jw_str(&w, ",");
    emit_column(&w, "\"heap_min\"", samples, n, col_heap_min, NULL);
    jw_str(&w, ",");
    emit_column(&w, "\"psram\"", samples, n, col_psram, NULL);
    jw_str(&w, ",");
    emit_column(&w, "\"rssi\"", samples, n, col_rssi, null_rssi);
    jw_str(&w, ",");
    emit_column(&w, "\"temp\"", samples, n, col_temp, null_temp);
    jw_str(&w, ",");
    emit_column(&w, "\"fps\"", samples, n, col_fps, NULL);
    jw_str(&w, "}");
    jw_flush(&w);

    heap_caps_free(samples);
    httpd_resp_send_chunk(req, NULL, 0); /* terminate chunked response */
    return w.failed ? ESP_FAIL : ESP_OK;
}

void web_ui_register(httpd_handle_t server)
{
    if (server == NULL) {
        return;
    }
    const httpd_uri_t routes[] = {
        { .uri = "/", .method = HTTP_GET, .handler = dashboard_get },
        { .uri = "/api/status", .method = HTTP_GET, .handler = status_get },
        { .uri = "/api/metrics", .method = HTTP_GET, .handler = metrics_get },
    };
    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        httpd_register_uri_handler(server, &routes[i]);
    }
    ESP_LOGI(TAG, "dashboard ready at GET /");
}
