/* Route every LVGL heap allocation to PSRAM.
 *
 * LVGL (with LV_USE_CLIB_MALLOC) calls malloc() for each object, style and
 * string. Those are small, so IDF's allocator prefers internal RAM for them,
 * and the ~500 objects of this UI drain the internal heap to zero at boot
 * (low-water mark measured: 12 bytes) before spilling over into PSRAM. That
 * internal RAM is exactly what Wi-Fi, lwIP and DMA need.
 *
 * The linker wraps LVGL's three allocator hooks (see main/CMakeLists.txt) so
 * they land in PSRAM instead; the LVGL data structures don't need internal
 * memory and the octal PSRAM sits behind the cache anyway. */
#include <stddef.h>

#include "esp_heap_caps.h"

#define LV_PSRAM_CAPS (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)

void *__wrap_lv_malloc_core(size_t size)
{
    void *p = heap_caps_malloc(size, LV_PSRAM_CAPS);
    return p ? p : heap_caps_malloc(size, MALLOC_CAP_8BIT); /* PSRAM full: fall back */
}

void *__wrap_lv_realloc_core(void *p, size_t new_size)
{
    void *n = heap_caps_realloc(p, new_size, LV_PSRAM_CAPS);
    return n ? n : heap_caps_realloc(p, new_size, MALLOC_CAP_8BIT);
}

void __wrap_lv_free_core(void *p)
{
    heap_caps_free(p);
}
