#include "web_ui.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "bsp/display.h"
#include "metrics.h"
#include "panel_ui.h"

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
    /* Always reset len: after a failed send (client went away) the writer must
     * turn into a no-op, never keep appending past the buffer. */
    if (!w->failed && w->len > 0 &&
        httpd_resp_send_chunk(w->req, w->buf, w->len) != ESP_OK) {
        w->failed = true;
    }
    w->len = 0;
}

static void jw_raw(json_writer_t *w, const char *s, int n)
{
    if (w->failed || n > (int)sizeof(w->buf)) {
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
    esp_ota_img_states_t st = ESP_OTA_IMG_UNDEFINED;
    if (running) {
        esp_ota_get_state_partition(running, &st);
    }
    char buf[400];
    int n = snprintf(buf, sizeof(buf),
                     "{\"version\":\"%s\",\"partition\":\"%s\",\"compiled\":\"%s %s\","
                     "\"idf\":\"%s\",\"uptime\":%llu,\"reset_reason\":%d,"
                     "\"pending_verify\":%s,\"heap_free\":%u,\"heap_min\":%u,"
                     "\"touch_recoveries\":%lu}",
                     desc->version, running ? running->label : "?",
                     desc->date, desc->time, desc->idf_ver,
                     esp_timer_get_time() / 1000000ULL, (int)esp_reset_reason(),
                     st == ESP_OTA_IMG_PENDING_VERIFY ? "true" : "false",
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned long)bsp_touch_get_recoveries());
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
    for (int i = 0; i < n && !w->failed; i++) {
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

/* ---- GET /api/metrics[?since=<t>] ---------------------------------------- */
/* Full history (~340 KB for 12 h) or, with since=<uptime s>, only the samples
 * newer than that so the dashboard's 5 s poll stays small. */
static int query_int(httpd_req_t *req, const char *key, int dflt);

static esp_err_t metrics_get(httpd_req_t *req)
{
    int cap = metrics_capacity();
    metric_sample_t *samples =
        heap_caps_malloc(sizeof(metric_sample_t) * cap, MALLOC_CAP_SPIRAM);
    json_writer_t *wp = heap_caps_malloc(sizeof(json_writer_t), MALLOC_CAP_SPIRAM);
    if (samples == NULL || wp == NULL) {
        heap_caps_free(samples);
        heap_caps_free(wp);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no mem");
        return ESP_FAIL;
    }
    int n = metrics_copy(samples, cap);
    const long since = query_int(req, "since", -1);
    if (since >= 0) { /* samples are in time order: skip the prefix <= since */
        int skip = 0;
        while (skip < n && samples[skip].t <= (uint32_t)since) {
            skip++;
        }
        if (skip > 0) {
            memmove(samples, samples + skip, sizeof(metric_sample_t) * (n - skip));
            n -= skip;
        }
    }

    metrics_meta_t meta;
    metrics_get_meta(&meta);

    httpd_resp_set_type(req, "application/json");
    memset(wp, 0, sizeof(*wp));
    wp->req = req;
    jw_str(wp, "{");
    jw_str(wp, "\"interval\":");
    jw_int(wp, meta.interval_s);
    jw_str(wp, ",\"now\":");
    jw_int(wp, meta.now_s);
    jw_str(wp, ",\"heap_total\":");
    jw_int(wp, meta.heap_total);
    jw_str(wp, ",\"psram_total\":");
    jw_int(wp, meta.psram_total);
    jw_str(wp, ",");
    emit_column(wp, "\"t\"", samples, n, col_t, NULL);
    jw_str(wp, ",");
    emit_column(wp, "\"heap\"", samples, n, col_heap, NULL);
    jw_str(wp, ",");
    emit_column(wp, "\"heap_min\"", samples, n, col_heap_min, NULL);
    jw_str(wp, ",");
    emit_column(wp, "\"psram\"", samples, n, col_psram, NULL);
    jw_str(wp, ",");
    emit_column(wp, "\"rssi\"", samples, n, col_rssi, null_rssi);
    jw_str(wp, ",");
    emit_column(wp, "\"temp\"", samples, n, col_temp, null_temp);
    jw_str(wp, ",");
    emit_column(wp, "\"fps\"", samples, n, col_fps, NULL);
    jw_str(wp, "}");
    jw_flush(wp);

    const bool failed = wp->failed;
    heap_caps_free(samples);
    heap_caps_free(wp);
    if (!failed) {
        httpd_resp_send_chunk(req, NULL, 0); /* terminate chunked response */
    }
    return failed ? ESP_FAIL : ESP_OK;
}

/* ---- GET /api/screen ----------------------------------------------------- */
/* Verification aid: returns the composited screen as raw little-endian RGB565
 * behind a one-line text header "RGB565 <w> <h>\n". Query options drive the UI
 * first: tab=N, drawer=0|1, settings=0|1 (each optional), scale=2 halves the
 * output. tools/screenshot.py turns it into a PNG. */
static int query_int(httpd_req_t *req, const char *key, int dflt)
{
    char q[96], v[16];
    if (httpd_req_get_url_query_str(req, q, sizeof(q)) != ESP_OK ||
        httpd_query_key_value(q, key, v, sizeof(v)) != ESP_OK) {
        return dflt;
    }
    return atoi(v);
}

static esp_err_t screen_get(httpd_req_t *req)
{
    const int tab = query_int(req, "tab", -1);
    const int drawer = query_int(req, "drawer", -1);
    const int settings = query_int(req, "settings", -1);
    const int scale = query_int(req, "scale", 1) == 2 ? 2 : 1;
    if (tab >= 0 || drawer >= 0 || settings >= 0) {
        panel_ui_debug_select(tab, drawer, settings);
        vTaskDelay(pdMS_TO_TICKS(600)); /* let slide animations finish */
    }
    lv_draw_buf_t *snap = panel_ui_capture();
    if (snap == NULL) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "capture failed");
        return ESP_FAIL;
    }
    const int w = snap->header.w / scale, h = snap->header.h / scale;
    char hdr[32];
    const int hn = snprintf(hdr, sizeof(hdr), "RGB565 %d %d\n", w, h);
    httpd_resp_set_type(req, "application/octet-stream");
    esp_err_t err = httpd_resp_send_chunk(req, hdr, hn);
    uint16_t *row = heap_caps_malloc(w * 2 * 8, MALLOC_CAP_SPIRAM); /* 8 rows per chunk */
    for (int y = 0; y < h && err == ESP_OK && row; y += 8) {
        int rows = 0;
        for (; rows < 8 && y + rows < h; rows++) {
            const uint16_t *src =
                (const uint16_t *)(snap->data + (y + rows) * scale * snap->header.stride);
            uint16_t *dst = row + rows * w;
            for (int x = 0; x < w; x++) {
                dst[x] = src[x * scale];
            }
        }
        err = httpd_resp_send_chunk(req, (const char *)row, rows * w * 2);
    }
    heap_caps_free(row);
    lv_draw_buf_destroy(snap);
    if (err == ESP_OK) {
        httpd_resp_send_chunk(req, NULL, 0);
    }
    return err;
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
        { .uri = "/api/screen", .method = HTTP_GET, .handler = screen_get },
    };
    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        httpd_register_uri_handler(server, &routes[i]);
    }
    ESP_LOGI(TAG, "dashboard ready at GET /");
}
