/* Bounded, self-healing wait for a free frame buffer in the esp_lvgl_adapter
 * display pipeline (TRIPLE_PARTIAL tear-avoid mode), with diagnostics.
 *
 * The adapter's display_bridge_pipeline_wait_free_buf() blocks the LVGL task
 * with an infinite task-notification wait until the LCD vsync ISR moves a
 * buffer from the busy list to the free pool. A coredump of a frozen panel
 * (2026-09-06) showed the LVGL task parked exactly there while the panel kept
 * scanning out: the release was lost, and with it the LVGL lock, the UI and
 * every setter that needs the lock.
 *
 * Linked with --wrap (main/CMakeLists.txt). After ~300 ms without a release
 * this logs the full pipeline state (which buffer is in which list, whether
 * the vsync ISR is still running, how often the jitter shield skipped) so the
 * root cause can be pinned down from the log, performs the release the ISR
 * should have done, and carries on. Counts are exposed on /api/status. */
#include <limits.h>
#include <stdint.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "adapter_internal.h" /* esp_lv_adapter_display_pipeline_t, display_pipeline_buf */
#include "display_bridge_common.h"

static const char *TAG = "lv_guard";

static uint32_t s_recoveries;
static uint32_t s_lost;
/* vsync ISR statistics (written from IRAM ISR context). */
static volatile uint32_t s_vsync_count;
static volatile uint32_t s_vsync_skipped;
static volatile int64_t s_vsync_last_us;

uint32_t lv_pipeline_guard_recoveries(void)
{
    return s_recoveries;
}

uint32_t lv_pipeline_guard_lost(void)
{
    return s_lost;
}

uint32_t lv_pipeline_guard_vsyncs(void)
{
    return s_vsync_count;
}

/* The RGB driver asks the DMA for a "link switch done" indication on every
 * frame-buffer switch; the adapter's frame-complete callback rides on that
 * interrupt. Count the requests and remember the last result so a dead
 * callback can be attributed: no requests / failed requests (driver) versus
 * requests without events (DMA hardware). */
#include "esp_err.h"
typedef struct gdma_channel_t *gdma_channel_handle_t;
esp_err_t __real_gdma_request_link_switch_event(gdma_channel_handle_t chan);
static uint32_t s_ls_requests;
static esp_err_t s_ls_last_err;
esp_err_t __wrap_gdma_request_link_switch_event(gdma_channel_handle_t chan)
{
    const esp_err_t err = __real_gdma_request_link_switch_event(chan);
    s_ls_requests++;
    s_ls_last_err = err;
    return err;
}

/* Record whether the adapter managed to register its frame callbacks with the
 * RGB panel driver (a failed registration = no frame events, silently). */
#include "esp_lcd_panel_rgb.h"
esp_err_t __real_esp_lcd_rgb_panel_register_event_callbacks(esp_lcd_panel_handle_t panel,
                                                            const esp_lcd_rgb_panel_event_callbacks_t *cbs,
                                                            void *user_ctx);
static esp_err_t s_reg_err = ESP_ERR_NOT_FOUND; /* never called */
static int s_reg_has_frame_cb = -1, s_reg_has_vsync_cb = -1, s_reg_has_bounce_cb = -1;
static volatile uint32_t s_lcd_vsyncs; /* LCD controller VSYNC_END interrupts (separate from the DMA) */

static bool IRAM_ATTR lcd_vsync_probe(esp_lcd_panel_handle_t panel, const esp_lcd_rgb_panel_event_data_t *edata,
                                      void *user_ctx)
{
    (void)panel; (void)edata; (void)user_ctx;
    s_lcd_vsyncs++;
    return false;
}

uint32_t lv_pipeline_guard_lcd_vsyncs(void)
{
    return s_lcd_vsyncs;
}

esp_err_t __wrap_esp_lcd_rgb_panel_register_event_callbacks(esp_lcd_panel_handle_t panel,
                                                            const esp_lcd_rgb_panel_event_callbacks_t *cbs,
                                                            void *user_ctx)
{
    /* Probe: also ask for the controller's VSYNC interrupt if nobody else does. */
    esp_lcd_rgb_panel_event_callbacks_t mine = *cbs;
    if (mine.on_vsync == NULL) {
        mine.on_vsync = lcd_vsync_probe;
    }
    cbs = &mine;
    s_reg_err = __real_esp_lcd_rgb_panel_register_event_callbacks(panel, cbs, user_ctx);
    s_reg_has_frame_cb = cbs && cbs->on_frame_buf_complete != NULL;
    s_reg_has_vsync_cb = cbs && cbs->on_vsync != NULL;
    s_reg_has_bounce_cb = cbs && cbs->on_bounce_empty != NULL;
    ESP_LOGI(TAG, "rgb panel callbacks registered: %s (frame_complete=%d vsync=%d bounce=%d)",
             esp_err_to_name(s_reg_err), s_reg_has_frame_cb, s_reg_has_vsync_cb, s_reg_has_bounce_cb);
    return s_reg_err;
}

int lv_pipeline_guard_registration(esp_err_t *err)
{
    if (err) {
        *err = s_reg_err;
    }
    return s_reg_has_frame_cb;
}

uint32_t lv_pipeline_guard_link_switch_requests(esp_err_t *last_err)
{
    if (last_err) {
        *last_err = s_ls_last_err;
    }
    return s_ls_requests;
}

/* Every LCD vsync passes through here (wrapped); count it and note whether
 * the adapter's jitter shield told the ISR to skip the buffer release. */
bool __real_display_bridge_vsync_on_isr(esp_lv_adapter_vsync_timing_t *t);
bool IRAM_ATTR __wrap_display_bridge_vsync_on_isr(esp_lv_adapter_vsync_timing_t *t)
{
    const bool skip = __real_display_bridge_vsync_on_isr(t);
    s_vsync_count++;
    s_vsync_last_us = esp_timer_get_time();
    if (skip) {
        s_vsync_skipped++;
    }
    return skip;
}

static void log_pipeline_state(esp_lv_adapter_display_pipeline_t *p)
{
    char busy[32] = "", empty[32] = "";
    int nb = 0, ne = 0;
    struct display_pipeline_buf *e;
    STAILQ_FOREACH(e, &p->busy_list, entry) {
        nb += snprintf(busy + nb, sizeof(busy) - nb, "%d ", (int)(e - p->elems));
    }
    STAILQ_FOREACH(e, &p->empty_list, entry) {
        ne += snprintf(empty + ne, sizeof(empty) - ne, "%d ", (int)(e - p->elems));
    }
    const int64_t age_us = esp_timer_get_time() - s_vsync_last_us;
    ESP_LOGE(TAG, "pipeline stalled: %u buffers, busy=[%s] free=[%s]; vsync #%lu, last %lld ms ago, "
             "shield-skipped %lu; task %s",
             (unsigned)p->elem_count, busy, empty, (unsigned long)s_vsync_count,
             (long long)(age_us / 1000), (unsigned long)s_vsync_skipped,
             pcTaskGetName(NULL));
}

struct display_pipeline_buf *__wrap_display_bridge_pipeline_wait_free_buf(esp_lv_adapter_display_pipeline_t *p)
{
    if (!p) {
        return NULL;
    }
    /* Same protocol as the original: clear stale notifications, then check. */
    ulTaskNotifyValueClear(NULL, ULONG_MAX);
    struct display_pipeline_buf *next = display_bridge_pipeline_take_free_buf(p);
    int waits = 0;
    while (!next) {
        if (ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(50)) == 0 && ++waits >= 6) {
            /* ~300 ms is 18 vsyncs at 60 Hz: the release is not coming. */
            log_pipeline_state(p);
            display_bridge_pipeline_release_buf_isr(p);
            next = display_bridge_pipeline_take_free_buf(p);
            if (next) {
                s_recoveries++;
                ESP_LOGW(TAG, "recovered by releasing the oldest busy buffer (#%lu)",
                         (unsigned long)s_recoveries);
            } else {
                s_lost++;
                ESP_LOGE(TAG, "no busy buffer to release: flushing without swap (#%lu)",
                         (unsigned long)s_lost);
            }
            return next;
        }
        next = display_bridge_pipeline_take_free_buf(p);
    }
    return next;
}
