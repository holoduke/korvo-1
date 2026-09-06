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
