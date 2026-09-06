/* Restart policy for the ESP32-S31 wall panel.
 *
 * Measured on this board (ESP32-S31 chip revision v0.0, IDF v6.2 master,
 * 2026-09-06): after a *software* reset (esp_restart(), panic) the RGB LCD
 * controller and its AXI-DMA channel keep running with their old state, and
 * in roughly half of those boots neither the LCD VSYNC interrupt nor the DMA
 * events ever reach the CPU again (0 events per boot versus ~60 per second).
 * The LVGL frame pipeline then starves. After a *full-chip* reset (power-on,
 * RTC watchdog) the display came up correctly on every single boot.
 *
 * So: every restart goes through the RTC watchdog (digital + RTC domains, the
 * same effect as a power cycle), and a boot that arrives via any other reset
 * source is turned into one, once, before anything else initialises. The
 * bootloader's OTA rollback logic is unaffected (it does not look at the
 * reset reason). */
#include "sys_reset.h"

#include "esp_attr.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal/wdt_hal.h"

static const char *TAG = "sys_reset";

/* Survives resets (RTC memory, not zeroed at boot): set right before the
 * forced hard reset so the next boot knows it already happened. */
static RTC_NOINIT_ATTR uint32_t s_hard_reset_pending;
#define HARD_RESET_MAGIC 0x48525354u /* "HRST" */
static bool s_boot_dirty;            /* this boot came from a software reset */

void sys_hard_reset(void)
{
    wdt_hal_context_t rwdt = RWDT_HAL_CONTEXT_DEFAULT();
    wdt_hal_init(&rwdt, WDT_RWDT, 0, false);
    wdt_hal_write_protect_disable(&rwdt);
    wdt_hal_config_stage(&rwdt, WDT_STAGE0, 50, WDT_STAGE_ACTION_RESET_RTC);
    wdt_hal_enable(&rwdt);
    wdt_hal_write_protect_enable(&rwdt);
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

/* esp_restart() is wrapped at link time (main/CMakeLists.txt) so OTA, the
 * theme switch, the HA watchdog and /api/reboot all take the clean path. */
void __real_esp_restart(void);
void __wrap_esp_restart(void)
{
    ESP_LOGW(TAG, "restart -> full-chip reset");
    sys_hard_reset();
    __real_esp_restart(); /* not reached */
}

static bool image_pending_verify(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    esp_ota_img_states_t st;
    return run && esp_ota_get_state_partition(run, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY;
}

bool sys_reset_ensure_clean_boot(void)
{
    const esp_reset_reason_t why = esp_reset_reason();
    const bool clean = why == ESP_RST_POWERON || why == ESP_RST_WDT || why == ESP_RST_BROWNOUT ||
                       why == ESP_RST_DEEPSLEEP;
    if (clean) {
        s_hard_reset_pending = 0;
        return true;
    }
    s_boot_dirty = true;
    if (s_hard_reset_pending == HARD_RESET_MAGIC) {
        /* We already forced one and still arrived here: do not loop. */
        ESP_LOGW(TAG, "reset reason %d after a forced hard reset; continuing", (int)why);
        s_hard_reset_pending = 0;
        return false;
    }
    if (image_pending_verify()) {
        /* First boot of a new OTA image: a reset now would make the bootloader
         * roll it back as "never confirmed". Run dirty, confirm, then reset
         * (sys_reset_after_confirm). */
        ESP_LOGW(TAG, "reset reason %d on an unconfirmed image: confirm first, then full-chip reset",
                 (int)why);
        return false;
    }
    ESP_LOGW(TAG, "reset reason %d leaves the LCD/DMA state dirty -> full-chip reset", (int)why);
    s_hard_reset_pending = HARD_RESET_MAGIC;
    sys_hard_reset();
    return false; /* not reached */
}

void sys_reset_after_confirm(void)
{
    if (s_boot_dirty && s_hard_reset_pending != HARD_RESET_MAGIC) {
        ESP_LOGW(TAG, "image confirmed on a dirty boot -> full-chip reset");
        s_hard_reset_pending = HARD_RESET_MAGIC;
        sys_hard_reset();
    }
}
