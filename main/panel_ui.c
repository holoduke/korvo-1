#include "panel_ui.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "bsp/esp32_s31_korvo.h"
#include "esp_log.h"
#include "lvgl.h"
#include "nvs.h"
#include "panel_config.h"
#include "climate_hist.h"
#include "themes.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_task_wdt.h"
#include "esp_ota_ops.h"
#include "esp_timer.h"
#ifdef PANEL_ENABLE_SCREEN_DUMP /* on-device screenshot helper (off by default) */
#include "esp_heap_caps.h"
#include "mbedtls/base64.h"
#endif

static const char *TAG = "panel_ui";

/* Boot splash: artwork embedded from main/assets (800x480 RGB565, 768 KB in
 * flash, drawn straight from the mapped image), a loader bar and a status
 * line. Shown on the top layer while the real UI is built underneath. */
extern const uint8_t splash_rgb565_start[] asm("_binary_splash_800x480_rgb565_start");
static const lv_image_dsc_t s_splash_img = {
    .header = { .magic = LV_IMAGE_HEADER_MAGIC, .cf = LV_COLOR_FORMAT_RGB565, .flags = 0,
                .w = 800, .h = 480, .stride = 800 * 2 },
    .data_size = 800 * 480 * 2,
    .data = NULL, /* set at create (points into the mapped flash image) */
};
static lv_image_dsc_t s_splash_dsc;
static lv_obj_t *s_splash;
static lv_obj_t *s_splash_bar;
static lv_obj_t *s_splash_status;
static uint32_t s_splash_shown_tick;
static int s_splash_target;       /* requested progress */
static bool s_splash_done;
#define SPLASH_MIN_MS 4000

/* Active theme: loaded from NVS in panel_ui_create() before any object is styled. */
static const panel_theme_t *s_theme = &PANEL_THEMES[0];
static int s_theme_idx;

/* Look colours come from the selected theme (themes.h); see s_theme below. */
#define COLOR_BG        lv_color_hex(s_theme->bg)
#define COLOR_TOOLBAR   lv_color_hex(s_theme->toolbar)
#define COLOR_TILE      lv_color_hex(s_theme->tile)
#define COLOR_TILE_OFF  lv_color_hex(s_theme->tile_off)
#define COLOR_TILE_ON   lv_color_hex(s_theme->tile_on)
#define COLOR_ON_TEXT   lv_color_hex(s_theme->on_text)
#define COLOR_ON_SUB    lv_color_hex(s_theme->on_sub)
#define COLOR_TEXT      lv_color_hex(s_theme->text)
#define COLOR_TEXT_DIM  lv_color_hex(s_theme->text_dim)
#define COLOR_TEXT_SOFT lv_color_hex(s_theme->text_soft)
#define COLOR_SCENE     lv_color_hex(s_theme->scene)
#define COLOR_SCENE_ON  lv_color_hex(s_theme->scene_on)
#define COLOR_SCENE_TEXT lv_color_hex(s_theme->scene_text)
#define COLOR_SCENE_SUB lv_color_hex(s_theme->scene_sub)
#define COLOR_ACCENT    lv_color_hex(s_theme->accent)
#define COLOR_GRID      lv_color_hex(s_theme->grid)
#define COLOR_OK        lv_color_hex(0x4dd06a)
#define COLOR_WARN      lv_color_hex(0xe0a555)
#define COLOR_BAD       lv_color_hex(0xe05555)
#define COLOR_COLD      lv_color_hex(0x6fb3ff)   /* below the comfort band */
#define COLOR_HUM       lv_color_hex(0x7fa8d0)   /* neutral humidity (outdoor) */

#define HEADER_H        84
#define TABBAR_H        46

#define TILE_CAP_COLOR  0x1
#define TILE_CAP_WARMTH 0x2

/* Rendered state category, to skip redundant re-styling of a tile. */
enum { TILE_STATE_UNKNOWN = 0, TILE_STATE_ON, TILE_STATE_OFF, TILE_STATE_UNAVAIL };

typedef struct {
    const panel_entity_t *entity;
    lv_obj_t *tile;
    lv_obj_t *icon;
    lv_obj_t *name_label;
    lv_obj_t *state_label;
    int caps;        /* TILE_CAP_* bit flags */
    int min_k;       /* colour-temp range (kelvin) */
    int max_k;
    int tab_idx;     /* which tab this tile belongs to (for snapshot invalidation) */
    int last_render; /* TILE_STATE_* last applied, to skip no-op updates */
    int brightness;  /* last known 0-100 from HA, 0 = unknown/off */
} light_tile_t;

static light_tile_t s_tiles[PANEL_MAX_LIGHTS];
static int s_tile_count;
static lv_obj_t *s_clock_label;
static lv_obj_t *s_status_dot;
static lv_obj_t *s_drawers[PANEL_TAB_COUNT];
static lv_obj_t *s_tabview;
/* Cached tab bitmaps so a swipe blits a pre-rendered image instead of
 * re-rasterizing every tile/glyph each frame. */
static lv_obj_t *s_tab_content[PANEL_TAB_COUNT];
static lv_draw_buf_t *s_tab_snap[PANEL_TAB_COUNT];
static bool s_snap_dirty[PANEL_TAB_COUNT];
static lv_obj_t *s_slide_ov;
static int s_slide_target;
static bool s_swiping;            /* release-snap animation running */
/* Finger-drag paging over the cached bitmaps. */
static lv_obj_t *s_drag_from_img;
static lv_obj_t *s_drag_to_img;
static bool s_drag_press;         /* a touch is down on the content */
static bool s_drag_on;            /* a real horizontal drag is in progress */
static bool s_drag_suppress_click;/* a drag happened -> swallow the tile click */
static int s_drag_x0;             /* touch-down x */
static int s_drag_from;
static int s_drag_to;
static int s_drag_last_dx;        /* previous poll's dx (for velocity) */
static int s_drag_vel;            /* recent px/tick, smoothed */
static lv_indev_t *s_drag_indev;
static bool s_drag_release_pending; /* RELEASED fired; waiting to rule out a glitch */
static uint32_t s_drag_release_tick;
#define DRAG_RELEASE_DEBOUNCE_MS 55 /* a fast drag can briefly drop the touch */
static void mark_snapshot_dirty(int tab);
static lv_obj_t *settings_label(lv_obj_t *parent, const char *txt,
                                const lv_font_t *font, lv_color_t color);
static void open_light_popup(const light_tile_t *tile);
static lv_obj_t *s_date_label;
static lv_obj_t *s_dow_label;     /* weekday, right cluster */
/* Forecast columns in the header (index 0 = today); 4 days leaves room for
 * five climate-sensor columns. */
#define FORECAST_DAYS 3
static lv_obj_t *s_fc_day[FORECAST_DAYS];
static lv_obj_t *s_fc_sun[FORECAST_DAYS];
static lv_obj_t *s_fc_cloud[FORECAST_DAYS];
static lv_obj_t *s_fc_temp[FORECAST_DAYS];
/* Climate readings in the header (index = PANEL_TEMP_SENSORS order). */
static lv_obj_t *s_temp_val[PANEL_TEMP_SENSOR_COUNT];
static lv_obj_t *s_hum_val[PANEL_TEMP_SENSOR_COUNT];
static lv_obj_t *s_sensor_name[PANEL_TEMP_SENSOR_COUNT]; /* name + trend arrow */
static float s_temp_now[PANEL_TEMP_SENSOR_COUNT];        /* latest readings (NAN = none) */
static float s_hum_now[PANEL_TEMP_SENSOR_COUNT];
/* Klimaat popup (24 h chart for one sensor). */
static lv_obj_t *s_clim;          /* backdrop */
static lv_obj_t *s_clim_title;
static lv_obj_t *s_clim_now;
static lv_obj_t *s_clim_chart;
static lv_chart_series_t *s_clim_ser_t;
static lv_chart_series_t *s_clim_ser_h;
static lv_obj_t *s_clim_range;
static lv_obj_t *s_clim_advice;
static lv_obj_t *s_clim_ymax, *s_clim_ymin, *s_clim_hmax, *s_clim_hmin;
static int32_t *s_clim_t_arr;     /* CLIMATE_SLOTS each, PSRAM */
static int32_t *s_clim_h_arr;
static int s_clim_idx = -1;
static void open_climate_popup(int idx);
static lv_obj_t *s_settings;      /* settings overlay */
static lv_obj_t *s_kb;
static lv_obj_t *s_pass_ta;
static panel_ui_wifi_cb_t s_wifi_cb;
static panel_ui_scan_cb_t s_scan_cb;
static lv_obj_t *s_wifi_sel_lbl;  /* settings-row value: SSID / "Niet verbonden" */
static lv_obj_t *s_net_lbl;       /* settings-row value: ip / rssi / HA state */
static lv_obj_t *s_fw_lbl;        /* settings-row value: version / partition / uptime */
static char s_net_ip[16];         /* last reported connection details */
static int s_net_rssi;
static bool s_net_ha_up;
static void render_net_details(void);
static lv_obj_t *s_wifi_btn_lbl;  /* settings-row button label: Verbinden / Wijzig */
static lv_obj_t *s_wifi_list;     /* scanned-network picker overlay */
static lv_obj_t *s_wifi_list_box; /* scrollable list inside the picker */
static lv_obj_t *s_wifi_pw;       /* password-entry panel inside the picker */
static lv_obj_t *s_wifi_pw_title;
static char s_wifi_sel_ssid[33];  /* SSID chosen in the picker */
static char s_net_ssids[20][33];  /* last scan results, indexed by button */
static int s_net_count;
static lv_obj_t *s_saver;         /* night dim / screensaver overlay */
static lv_obj_t *s_saver_clock;
/* "AI oog" screensaver: HAL-style eye (embedded 440x440 RGB565) with a pulsing
 * pupil glow, a scanning ring and a slow breath, all driven by lv_anim. */
extern const uint8_t eye_rgb565_start[] asm("_binary_eye_440x440_rgb565_start");
static lv_image_dsc_t s_eye_dsc;
static lv_obj_t *s_eye_group;     /* container for the eye layer (hidden in "scherm uit" mode) */
static lv_obj_t *s_eye_img;
static lv_obj_t *s_eye_glow;      /* radial gradient over the pupil */
static lv_obj_t *s_eye_ring;      /* thin rotating arc around the rim */
static lv_grad_dsc_t s_eye_glow_grad;
static lv_obj_t *s_eye_temps[PANEL_TEMP_SENSOR_COUNT]; /* room temperatures, top-left column */
static lv_timer_t *s_eye_flicker_timer;
static int s_saver_mode;          /* 0 = scherm uit (backlight off), 1 = AI oog */
static lv_obj_t *s_saver_mode_dd;
#define SAVER_MODE_OFF 0
#define SAVER_MODE_EYE 1

static lv_obj_t *s_popup;         /* long-press per-light brightness popup */
static lv_obj_t *s_popup_title;
static lv_obj_t *s_popup_slider;
static lv_obj_t *s_popup_color_slider;   /* colour or warmth, per light caps */
static lv_obj_t *s_popup_color_label;
static int s_popup_color_mode;           /* 0 none, 1 colour, 2 warmth */
static int s_popup_min_k, s_popup_max_k;
static lv_grad_dsc_t s_hue_grad;         /* rainbow track for the colour slider */
static lv_grad_dsc_t s_warm_grad;        /* warm->cool track for the warmth slider */
static const panel_entity_t *s_popup_entity;
static panel_ui_color_cb_t s_color_cb;
static panel_ui_warmth_cb_t s_warmth_cb;

static uint32_t s_saver_timeout_ms = 60000; /* 0 = never; changed in settings */
static lv_obj_t *s_saver_dd;
static lv_obj_t *s_theme_dd;
static lv_obj_t *s_theme_lbl;     /* "wordt toegepast..." feedback */

/* Screensaver timeout options (index -> milliseconds). */
static const uint32_t SAVER_OPTS_MS[] = {60000, 300000, 1800000, 7200000};
#define SAVER_OPTS_STR "1 min\n5 min\n30 min\n2 uur"
static panel_ui_light_cb_t s_light_cb;
static panel_ui_scene_cb_t s_scene_cb;
static panel_ui_brightness_cb_t s_brightness_cb;
static lv_obj_t *s_bright_label;
static lv_obj_t *s_bright_slider;
static bool s_slider_moved;
static bool s_slider_dragging;
static uint32_t s_slider_release_tick;        /* suppress HA sync briefly after a user change */
static int s_tab_brightness[PANEL_TAB_COUNT]; /* last known area brightness, -1 unknown */

/* Scene buttons per tab (bottom chips, or grid tiles on a scene tab), so
 * activating one can highlight it and clear the others. */
#define MAX_SCENES 12
static lv_obj_t *s_scene_chips[PANEL_TAB_COUNT][MAX_SCENES];
static int s_scene_counts[PANEL_TAB_COUNT];
/* Scene-tab extras: per-tile sub-labels ("actief"), the tile icon/name labels
 * (re-tinted when active), and the bottom-row "active scene" readout. */
static lv_obj_t *s_scene_state_lbl[PANEL_TAB_COUNT][MAX_SCENES];
static lv_obj_t *s_scene_icon[PANEL_TAB_COUNT][MAX_SCENES];
static lv_obj_t *s_scene_name[PANEL_TAB_COUNT][MAX_SCENES];
static lv_obj_t *s_active_scene_lbl[PANEL_TAB_COUNT];
static int s_active_scene[PANEL_TAB_COUNT]; /* index into the tab's scenes, -1 none */

typedef struct {
    const panel_entity_t *scene;
    int tab_idx;
} scene_ctx_t;
static scene_ctx_t s_scene_ctx[PANEL_TAB_COUNT][MAX_SCENES];

#define SLIDER_W       56
#define SLIDER_MARGIN  12                                      /* slider gap from right edge */
#define SLIDER_LANE_X  (LV_HOR_RES - SLIDER_W - SLIDER_MARGIN) /* slider's left edge */
#define SLIDER_LANE_W  (SLIDER_W + SLIDER_MARGIN + 16)         /* reserved right lane width */
#define SCENE_ROW_H    84

/* Grid templates (LVGL keeps the pointer, so they must persist). */
static int32_t s_col_dsc[] = { LV_GRID_FR(1), LV_GRID_FR(1), LV_GRID_FR(1), LV_GRID_TEMPLATE_LAST };
static int32_t s_row_dsc[] = { LV_GRID_FR(1), LV_GRID_FR(1), LV_GRID_TEMPLATE_LAST };
/* Compact 4x3 grid for scene tabs with more than 6 scenes. */
static int32_t s_col_dsc4[] = { LV_GRID_FR(1), LV_GRID_FR(1), LV_GRID_FR(1), LV_GRID_FR(1),
                                LV_GRID_TEMPLATE_LAST };
static int32_t s_row_dsc3[] = { LV_GRID_FR(1), LV_GRID_FR(1), LV_GRID_FR(1),
                                LV_GRID_TEMPLATE_LAST };

/* The drawer occupies only the middle band, keeping the header + scene row
 * (bottom buttons) visible; it's toggled by the "Alle lampen" button. */
#define CONTENT_Y (HEADER_H + TABBAR_H) /* top of the tab content (below header + tab bar) */
#define DRAWER_Y HEADER_H
#define DRAWER_H (LV_VER_RES - HEADER_H - SCENE_ROW_H)
static lv_obj_t *s_show_all_btn[PANEL_TAB_COUNT]; /* the "Alle lampen" toggle per tab */
static lv_obj_t *s_show_all_lbl[PANEL_TAB_COUNT]; /* its label (text + chevron) */
static bool s_drawer_open;                        /* is a drawer open/opening */

#define SHOW_ALL_CLOSED_TXT LV_SYMBOL_LIST "  Alle lampen   " LV_SYMBOL_DOWN
#define SHOW_ALL_OPEN_TXT   LV_SYMBOL_LIST "  Alle lampen   " LV_SYMBOL_UP

static void on_tile_clicked(lv_event_t *e)
{
    if (s_drag_suppress_click) {
        return; /* this touch was a swipe, not a tap */
    }
    const light_tile_t *tile = lv_event_get_user_data(e);
    if (s_light_cb) {
        s_light_cb(tile->entity->entity_id);
    }
}

/* Long-press a tile -> open the per-light brightness popup. */
static void on_tile_long_pressed(lv_event_t *e)
{
    const light_tile_t *tile = lv_event_get_user_data(e);
    if (s_popup == NULL || s_drag_on || s_drag_suppress_click) {
        return; /* don't open the popup mid-swipe */
    }
    /* Also suppress if the finger has moved since press: that's a swipe in
     * progress (below the drag threshold), not an intentional hold. */
    if (s_drag_press && s_drag_indev) {
        lv_point_t p;
        lv_indev_get_point(s_drag_indev, &p);
        const int dx = p.x - s_drag_x0;
        if (dx * dx > 10 * 10) {
            return;
        }
    }
    open_light_popup(tile);
}

/* Populate + show the per-light popup with brightness and (if supported) a
 * colour or warmth slider. */
static void open_light_popup(const light_tile_t *tile)
{
    s_popup_entity = tile->entity;
    lv_label_set_text(s_popup_title, tile->entity->label);
    lv_slider_set_value(s_popup_slider, tile->brightness > 0 ? tile->brightness : 50,
                        LV_ANIM_OFF);

    /* Second slider: colour if the light supports it, else warmth, else none. */
    if (tile->caps & TILE_CAP_COLOR) {
        s_popup_color_mode = 1;
        lv_label_set_text(s_popup_color_label, "Kleur");
        lv_slider_set_range(s_popup_color_slider, 0, 359);
        lv_slider_set_value(s_popup_color_slider, 40, LV_ANIM_OFF);
        /* Rainbow track; transparent fill so the whole spectrum shows; the knob
         * marks (and is tinted to) the chosen hue. */
        lv_obj_set_style_bg_grad(s_popup_color_slider, &s_hue_grad, LV_PART_MAIN);
        lv_obj_set_style_bg_opa(s_popup_color_slider, LV_OPA_TRANSP, LV_PART_INDICATOR);
        lv_obj_set_style_bg_color(s_popup_color_slider, lv_color_hsv_to_rgb(40, 100, 100),
                                  LV_PART_KNOB);
    } else if (tile->caps & TILE_CAP_WARMTH) {
        s_popup_color_mode = 2;
        s_popup_min_k = tile->min_k;
        s_popup_max_k = tile->max_k;
        lv_label_set_text(s_popup_color_label, "Warmte");
        lv_slider_set_range(s_popup_color_slider, tile->min_k, tile->max_k);
        lv_slider_set_value(s_popup_color_slider, (tile->min_k + tile->max_k) / 2, LV_ANIM_OFF);
        /* Warm -> cool gradient track shows the range; knob marks the choice. */
        lv_obj_set_style_bg_grad(s_popup_color_slider, &s_warm_grad, LV_PART_MAIN);
        lv_obj_set_style_bg_opa(s_popup_color_slider, LV_OPA_TRANSP, LV_PART_INDICATOR);
        lv_obj_set_style_bg_color(s_popup_color_slider, lv_color_hex(0xf2ede0), LV_PART_KNOB);
    } else {
        s_popup_color_mode = 0;
    }
    if (s_popup_color_mode == 0) {
        lv_obj_add_flag(s_popup_color_slider, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s_popup_color_label, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_remove_flag(s_popup_color_slider, LV_OBJ_FLAG_HIDDEN);
        lv_obj_remove_flag(s_popup_color_label, LV_OBJ_FLAG_HIDDEN);
    }

    lv_obj_remove_flag(s_popup, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(s_popup);
}

/* Radio-style highlight: scene idx lit, the others on the tab cleared. On a
 * scene tab this also re-tints the tile text and updates the bottom-row
 * "active scene" readout. Caller holds the LVGL lock. */
static void scene_highlight(int tab, int idx)
{
    if (tab < 0 || tab >= (int)PANEL_TAB_COUNT || idx < 0 || idx >= s_scene_counts[tab]) {
        return;
    }
    if (s_active_scene[tab] == idx) {
        return; /* already shown: keep the tab's cached bitmap */
    }
    s_active_scene[tab] = idx;
    const bool tiles = PANEL_TABS[tab].scene_tiles;
    for (int j = 0; j < s_scene_counts[tab]; j++) {
        const bool on = (j == idx);
        lv_obj_set_style_bg_color(s_scene_chips[tab][j],
                                  on ? COLOR_SCENE_ON : (tiles ? COLOR_TILE : COLOR_SCENE), 0);
        if (!tiles) {
            continue;
        }
        if (s_scene_icon[tab][j]) {
            lv_obj_set_style_text_color(s_scene_icon[tab][j],
                                        on ? COLOR_SCENE_TEXT : COLOR_TEXT_DIM, 0);
        }
        if (s_scene_name[tab][j]) {
            lv_obj_set_style_text_color(s_scene_name[tab][j], on ? COLOR_SCENE_TEXT : COLOR_TEXT, 0);
        }
        if (s_scene_state_lbl[tab][j]) {
            lv_label_set_text(s_scene_state_lbl[tab][j], on ? "actief" : "scene");
            lv_obj_set_style_text_color(s_scene_state_lbl[tab][j],
                                        on ? COLOR_SCENE_SUB : COLOR_TEXT_DIM, 0);
        }
    }
    if (s_active_scene_lbl[tab]) {
        lv_label_set_text_fmt(s_active_scene_lbl[tab], "Actieve scene:  %s",
                              PANEL_TABS[tab].scenes[idx].label);
    }
    mark_snapshot_dirty(tab);
}

static void on_scene_clicked(lv_event_t *e)
{
    if (s_drag_suppress_click) {
        return; /* this touch was a swipe, not a tap */
    }
    const scene_ctx_t *ctx = lv_event_get_user_data(e);
    if (s_scene_cb) {
        s_scene_cb(ctx->scene->entity_id);
    }
    scene_highlight(ctx->tab_idx, (int)(ctx->scene - PANEL_TABS[ctx->tab_idx].scenes));
}

/* Vertical brightness slider: live % readout while dragging, applies on release. */
static void on_bright_slider_event(lv_event_t *e)
{
    lv_obj_t *slider = lv_event_get_target(e);
    const int val = lv_slider_get_value(slider);
    const lv_event_code_t code = lv_event_get_code(e);

    if (code == LV_EVENT_PRESSED) {
        s_slider_dragging = true;
    } else if (code == LV_EVENT_VALUE_CHANGED) {
        s_slider_moved = true;
        if (s_bright_label) {
            lv_label_set_text_fmt(s_bright_label, "%d%%", val);
        }
    } else if (code == LV_EVENT_RELEASED) {
        s_slider_dragging = false;
        if (s_slider_moved) {
            s_slider_moved = false;
            s_slider_release_tick = lv_tick_get();
            const uint32_t idx = lv_tabview_get_tab_active(s_tabview);
            if (idx < PANEL_TAB_COUNT && s_brightness_cb) {
                s_tab_brightness[idx] = val;
                s_brightness_cb(PANEL_TABS[idx].lights, PANEL_TABS[idx].light_count, val);
            }
        }
    }
}

static void lvgl_wdt_feed(lv_timer_t *t)
{
    (void)t;
    static bool subscribed;
    if (!subscribed) { /* first run: we are on the LVGL task now */
        subscribed = esp_task_wdt_add(NULL) == ESP_OK;
        if (subscribed) {
            ESP_LOGI(TAG, "LVGL task subscribed to the task watchdog");
        }
        return;
    }
    esp_task_wdt_reset();
}

static void on_clock_timer(lv_timer_t *t)
{
    (void)t;
    time_t now = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    if (tm_now.tm_year <= 100) {
        return; /* wait for SNTP */
    }
    static const char *const days[] = {"zondag", "maandag", "dinsdag", "woensdag",
                                        "donderdag", "vrijdag", "zaterdag"};
    static const char *const mons[] = {"jan", "feb", "mrt", "apr", "mei", "jun",
                                        "jul", "aug", "sep", "okt", "nov", "dec"};
    static const char *const sd[] = {"zo", "ma", "di", "wo", "do", "vr", "za"};

    /* Only touch the labels when the value actually changes: lv_label_set_text
     * has no identical-text early-out, so an unconditional 1 Hz rewrite forces a
     * heap realloc + partial flush every second, 24/7. */
    static int last_min = -1, last_yday = -1;
    const int mins = tm_now.tm_hour * 60 + tm_now.tm_min;
    if (mins != last_min) {
        last_min = mins;
        lv_label_set_text_fmt(s_clock_label, "%02d:%02d", tm_now.tm_hour, tm_now.tm_min);
    }
    if (tm_now.tm_yday != last_yday) {
        last_yday = tm_now.tm_yday;
        if (s_dow_label) {
            lv_label_set_text(s_dow_label, days[tm_now.tm_wday]);
        }
        if (s_date_label) {
            lv_label_set_text_fmt(s_date_label, "%d %s", tm_now.tm_mday, mons[tm_now.tm_mon]);
        }
        for (int i = 0; i < FORECAST_DAYS; i++) {
            if (s_fc_day[i]) {
                lv_label_set_text(s_fc_day[i], sd[(tm_now.tm_wday + i) % 7]);
            }
        }
    }
}

/* Remove scrollbars/padding/border from a plain container. */
static void make_plain(lv_obj_t *o)
{
    lv_obj_set_style_bg_opa(o, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(o, 0, 0);
    lv_obj_set_style_radius(o, 0, 0);
    lv_obj_set_style_pad_all(o, 0, 0);
    lv_obj_set_style_pad_gap(o, 0, 0);
    lv_obj_clear_flag(o, LV_OBJ_FLAG_SCROLLABLE);
}

static void on_settings_open(lv_event_t *e); /* defined with the settings overlay */

/* A tiny filled shape (circle/bar) used to compose the weather icon. */
static lv_obj_t *wx_shape(lv_obj_t *parent, int w, int h, int radius, lv_color_t color)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_set_size(o, w, h);
    lv_obj_set_style_radius(o, radius, 0);
    lv_obj_set_style_bg_color(o, color, 0);
    lv_obj_set_style_border_width(o, 0, 0);
    lv_obj_set_style_pad_all(o, 0, 0);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    return o;
}

static void wx_cloud_color(lv_obj_t *cloud, lv_color_t c)
{
    if (!cloud) {
        return;
    }
    const uint32_t n = lv_obj_get_child_count(cloud);
    for (uint32_t i = 0; i < n; i++) {
        lv_obj_set_style_bg_color(lv_obj_get_child(cloud, i), c, 0);
    }
}

/* Build a small drawn sun+cloud icon (36x34) into parent; returns the handles.
 * The sun is vertically centered so a sun-only day lines up with the labels. */
static void build_wx_icon(lv_obj_t *parent, lv_obj_t **sun, lv_obj_t **cloud)
{
    lv_obj_t *box = lv_obj_create(parent);
    lv_obj_set_size(box, 36, 34);
    make_plain(box);

    *sun = wx_shape(box, 20, 20, LV_RADIUS_CIRCLE, lv_color_hex(0xffcf4d));
    lv_obj_align(*sun, LV_ALIGN_LEFT_MID, 1, 0);

    *cloud = lv_obj_create(box);
    lv_obj_set_size(*cloud, 36, 19);
    make_plain(*cloud);
    lv_obj_align(*cloud, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_align(wx_shape(*cloud, 34, 10, 5, COLOR_TEXT_DIM), LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_align(wx_shape(*cloud, 14, 14, LV_RADIUS_CIRCLE, COLOR_TEXT_DIM),
                 LV_ALIGN_BOTTOM_LEFT, 4, -2);
    lv_obj_align(wx_shape(*cloud, 17, 17, LV_RADIUS_CIRCLE, COLOR_TEXT_DIM),
                 LV_ALIGN_BOTTOM_MID, 2, -1);
}

static void on_sensor_clicked(lv_event_t *e)
{
    if (s_drag_suppress_click) {
        return;
    }
    open_climate_popup((int)(intptr_t)lv_event_get_user_data(e));
}

static void create_header(lv_obj_t *parent)
{
    lv_obj_t *bar = lv_obj_create(parent);
    lv_obj_set_size(bar, LV_PCT(100), HEADER_H);
    make_plain(bar);
    lv_obj_set_style_bg_color(bar, COLOR_TOOLBAR, 0);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(bar, COLOR_TILE, 0);
    lv_obj_set_style_border_width(bar, 1, 0);
    lv_obj_set_style_border_side(bar, LV_BORDER_SIDE_BOTTOM, 0);
    lv_obj_set_style_pad_hor(bar, 20, 0);
    lv_obj_set_flex_flow(bar, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(bar, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    /* Left cluster: forecast, one column per day (index 0 = today). */
    lv_obj_t *fc = lv_obj_create(bar);
    lv_obj_set_size(fc, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    make_plain(fc);
    lv_obj_set_style_pad_gap(fc, 12, 0);
    lv_obj_set_flex_flow(fc, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(fc, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    for (int i = 0; i < FORECAST_DAYS; i++) {
        lv_obj_t *col = lv_obj_create(fc);
        lv_obj_set_size(col, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        make_plain(col);
        lv_obj_set_style_pad_gap(col, 1, 0);
        lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_align(col, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER,
                              LV_FLEX_ALIGN_CENTER);
        s_fc_day[i] = lv_label_create(col);
        lv_label_set_text(s_fc_day[i], "--");
        lv_obj_set_style_text_font(s_fc_day[i], &lv_font_montserrat_14, 0);
        /* Today (index 0) stands out in the accent colour. */
        lv_obj_set_style_text_color(s_fc_day[i], i == 0 ? COLOR_ACCENT : COLOR_TEXT_DIM, 0);
        build_wx_icon(col, &s_fc_sun[i], &s_fc_cloud[i]);
        s_fc_temp[i] = lv_label_create(col);
        lv_label_set_text(s_fc_temp[i], "--");
        lv_obj_set_style_text_font(s_fc_temp[i], &lv_font_montserrat_18, 0);
        lv_obj_set_style_text_color(s_fc_temp[i], COLOR_TEXT, 0);
    }

    /* Thin vertical rule separating the forecast from the room sensors. */
    lv_obj_t *rule = lv_obj_create(bar);
    lv_obj_set_size(rule, 1, 48);
    make_plain(rule);
    lv_obj_set_style_bg_color(rule, COLOR_TILE, 0);
    lv_obj_set_style_bg_opa(rule, LV_OPA_COVER, 0);
    lv_obj_set_style_margin_hor(rule, 14, 0);

    /* Climate sensors: one column per sensor (name, temperature, humidity),
     * laid out like the forecast columns so they read as one strip. */
    lv_obj_t *tc = lv_obj_create(bar);
    lv_obj_set_size(tc, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    make_plain(tc);
    lv_obj_set_style_pad_gap(tc, 11, 0);
    lv_obj_set_flex_flow(tc, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(tc, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    for (int i = 0; i < (int)PANEL_TEMP_SENSOR_COUNT; i++) {
        lv_obj_t *col = lv_obj_create(tc);
        lv_obj_set_size(col, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        make_plain(col);
        lv_obj_set_style_pad_gap(col, 1, 0);
        lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_align(col, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER,
                              LV_FLEX_ALIGN_CENTER);
        /* Tap a column for its 24 h chart (Klimaat popup). */
        lv_obj_add_flag(col, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_event_cb(col, on_sensor_clicked, LV_EVENT_SHORT_CLICKED, (void *)(intptr_t)i);
        lv_obj_set_style_pad_hor(col, 4, 0);
        lv_obj_t *name = lv_label_create(col);
        lv_label_set_text(name, PANEL_TEMP_SENSORS[i].label);
        lv_obj_set_style_text_font(name, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(name, COLOR_TEXT_DIM, 0);
        s_sensor_name[i] = name;
        s_temp_now[i] = NAN;
        s_hum_now[i] = NAN;
        s_temp_val[i] = lv_label_create(col);
        lv_label_set_text(s_temp_val[i], "--");
        lv_obj_set_style_text_font(s_temp_val[i], &lv_font_montserrat_24, 0);
        lv_obj_set_style_text_color(s_temp_val[i], COLOR_TEXT, 0);
        s_hum_val[i] = lv_label_create(col);
        lv_label_set_text(s_hum_val[i], PANEL_TEMP_SENSORS[i].humidity_id ? LV_SYMBOL_TINT " --"
                                                                         : "");
        lv_obj_set_style_text_font(s_hum_val[i], &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(s_hum_val[i], COLOR_HUM, 0);
    }

    /* Spacer pushes the clock cluster + gear to the right edge. */
    lv_obj_t *spacer = lv_obj_create(bar);
    make_plain(spacer);
    lv_obj_set_height(spacer, 1);
    lv_obj_set_flex_grow(spacer, 1);

    /* Right cluster: the big time on top, weekday + date below it (right-aligned). */
    lv_obj_t *timebox = lv_obj_create(bar);
    lv_obj_set_size(timebox, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    make_plain(timebox);
    lv_obj_set_style_pad_gap(timebox, 1, 0);
    lv_obj_set_flex_flow(timebox, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(timebox, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_END,
                          LV_FLEX_ALIGN_END);
    s_clock_label = lv_label_create(timebox);
    lv_label_set_text(s_clock_label, "--:--");
    lv_obj_set_style_text_font(s_clock_label, &lv_font_montserrat_32, 0);
    lv_obj_set_style_text_color(s_clock_label, COLOR_TEXT, 0);

    lv_obj_t *daterow = lv_obj_create(timebox);
    lv_obj_set_size(daterow, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    make_plain(daterow);
    lv_obj_set_style_pad_gap(daterow, 6, 0);
    lv_obj_set_flex_flow(daterow, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(daterow, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    s_dow_label = lv_label_create(daterow);
    lv_label_set_text(s_dow_label, "");
    lv_obj_set_style_text_font(s_dow_label, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(s_dow_label, COLOR_TEXT_SOFT, 0);
    s_date_label = lv_label_create(daterow);
    lv_label_set_text(s_date_label, "");
    lv_obj_set_style_text_font(s_date_label, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(s_date_label, COLOR_TEXT_DIM, 0);

    s_status_dot = lv_obj_create(bar);
    lv_obj_set_size(s_status_dot, 14, 14);
    lv_obj_set_style_radius(s_status_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(s_status_dot, COLOR_BAD, 0);
    lv_obj_set_style_border_width(s_status_dot, 0, 0);
    lv_obj_set_style_margin_left(s_status_dot, 14, 0);

    lv_obj_t *gear = lv_button_create(bar);
    lv_obj_set_size(gear, 56, 56);
    lv_obj_set_style_bg_opa(gear, LV_OPA_TRANSP, 0);
    lv_obj_set_style_bg_opa(gear, LV_OPA_30, LV_STATE_PRESSED);
    lv_obj_set_style_bg_color(gear, COLOR_TILE, LV_STATE_PRESSED);
    lv_obj_set_style_radius(gear, 12, 0);
    lv_obj_set_style_shadow_width(gear, 0, 0);
    lv_obj_set_style_margin_left(gear, 10, 0);
    lv_obj_add_event_cb(gear, on_settings_open, LV_EVENT_CLICKED, NULL);
    lv_obj_t *gl = lv_label_create(gear);
    lv_label_set_text(gl, LV_SYMBOL_SETTINGS);
    lv_obj_set_style_text_font(gl, &lv_font_montserrat_32, 0);
    lv_obj_set_style_text_color(gl, COLOR_TEXT, 0);
    lv_obj_center(gl);
}

static void create_light_grid(lv_obj_t *parent, const panel_tab_t *tab, int tab_idx)
{
    lv_obj_t *grid = lv_obj_create(parent);
    lv_obj_set_width(grid, LV_PCT(100));
    lv_obj_set_flex_grow(grid, 1);
    make_plain(grid);
    lv_obj_set_style_pad_all(grid, 16, 0);
    lv_obj_set_style_pad_right(grid, SLIDER_LANE_W, 0); /* lane for the brightness slider */
    lv_obj_set_style_pad_gap(grid, 14, 0);
    lv_obj_set_grid_dsc_array(grid, s_col_dsc, s_row_dsc);
    lv_obj_set_layout(grid, LV_LAYOUT_GRID);

    if (tab->scene_tiles) {
        /* Scene tab: one tile per scene. Up to 6 scenes get big light-style
         * tiles (icon / name / "actief"); more get a compact 4x3 grid of
         * swatch + name pills. Tapping activates the scene and lights the tile. */
        const int scene_n = tab->scene_count < MAX_SCENES ? tab->scene_count : MAX_SCENES;
        /* The last quick_scenes entries become bottom-row buttons (create_scene_row). */
        const int grid_n = scene_n - (tab->quick_scenes < scene_n ? tab->quick_scenes : 0);
        const bool compact = grid_n > 6;
        const int cols = compact ? 4 : 3;
        s_scene_counts[tab_idx] = scene_n;
        if (compact) {
            lv_obj_set_grid_dsc_array(grid, s_col_dsc4, s_row_dsc3);
            lv_obj_set_style_pad_gap(grid, 10, 0);
        }
        for (int i = 0; i < grid_n; i++) {
            lv_obj_t *tile = lv_button_create(grid);
            lv_obj_set_grid_cell(tile, LV_GRID_ALIGN_STRETCH, i % cols, 1,
                                 LV_GRID_ALIGN_STRETCH, i / cols, 1);
            lv_obj_set_style_bg_color(tile, COLOR_TILE, 0);
            lv_obj_set_style_radius(tile, compact ? 14 : 18, 0);
            lv_obj_set_style_shadow_width(tile, 0, 0);
            lv_obj_set_style_pad_all(tile, compact ? 12 : 16, 0);
            lv_obj_set_style_pad_gap(tile, compact ? 10 : 0, 0);
            lv_obj_set_style_bg_opa(tile, LV_OPA_80, LV_STATE_PRESSED);
            lv_obj_set_flex_flow(tile, compact ? LV_FLEX_FLOW_ROW : LV_FLEX_FLOW_COLUMN);
            lv_obj_set_flex_align(tile, LV_FLEX_ALIGN_START,
                                  compact ? LV_FLEX_ALIGN_CENTER : LV_FLEX_ALIGN_START,
                                  LV_FLEX_ALIGN_START);
            s_scene_chips[tab_idx][i] = tile;
            s_scene_ctx[tab_idx][i] = (scene_ctx_t){ &tab->scenes[i], tab_idx };
            lv_obj_add_event_cb(tile, on_scene_clicked, LV_EVENT_SHORT_CLICKED,
                                &s_scene_ctx[tab_idx][i]);

            /* Leading glyph: a colour swatch if configured, else a symbol. */
            const panel_swatch_t *sw = tab->scene_swatches ? &tab->scene_swatches[i] : NULL;
            s_scene_icon[tab_idx][i] = NULL;
            if (sw && sw->a) {
                const int d = compact ? 28 : 36;
                lv_obj_t *dot = wx_shape(tile, d, d, LV_RADIUS_CIRCLE,
                                         lv_color_hex(sw->a == SWATCH_RAINBOW ? 0xff0000 : sw->a));
                if (sw->a == SWATCH_RAINBOW) {
                    lv_obj_set_style_bg_grad(dot, &s_hue_grad, 0);
                } else if (sw->b) {
                    lv_obj_set_style_bg_grad_color(dot, lv_color_hex(sw->b), 0);
                    lv_obj_set_style_bg_grad_dir(dot, LV_GRAD_DIR_HOR, 0);
                }
            } else {
                lv_obj_t *icon = lv_label_create(tile);
                lv_label_set_text(icon, (tab->scene_icons && tab->scene_icons[i])
                                            ? tab->scene_icons[i] : LV_SYMBOL_CHARGE);
                lv_obj_set_style_text_font(icon, compact ? &lv_font_montserrat_24
                                                         : &lv_font_montserrat_32, 0);
                lv_obj_set_style_text_color(icon, COLOR_TEXT_DIM, 0);
                s_scene_icon[tab_idx][i] = icon;
            }

            if (!compact) {
                lv_obj_t *spacer = lv_obj_create(tile);
                lv_obj_set_width(spacer, LV_PCT(100));
                make_plain(spacer);
                lv_obj_set_flex_grow(spacer, 1);
            }

            lv_obj_t *name = lv_label_create(tile);
            lv_label_set_text(name, tab->scenes[i].label);
            lv_obj_set_style_text_font(name, compact ? &lv_font_montserrat_18
                                                     : &lv_font_montserrat_24, 0);
            lv_obj_set_style_text_color(name, COLOR_TEXT, 0);
            s_scene_name[tab_idx][i] = name;

            s_scene_state_lbl[tab_idx][i] = NULL;
            if (!compact) {
                lv_obj_t *sub = lv_label_create(tile);
                lv_label_set_text(sub, "scene");
                lv_obj_set_style_text_font(sub, &lv_font_montserrat_18, 0);
                lv_obj_set_style_text_color(sub, COLOR_TEXT_DIM, 0);
                s_scene_state_lbl[tab_idx][i] = sub;
            }
        }
        return;
    }

    for (int i = 0; i < tab->light_count && s_tile_count < PANEL_MAX_LIGHTS; i++) {
        light_tile_t *t = &s_tiles[s_tile_count++];
        t->entity = &tab->lights[i];
        t->tab_idx = tab_idx;
        const int col = i % 3;
        const int row = i / 3;

        t->tile = lv_button_create(grid);
        lv_obj_set_grid_cell(t->tile, LV_GRID_ALIGN_STRETCH, col, 1,
                             LV_GRID_ALIGN_STRETCH, row, 1);
        lv_obj_set_style_bg_color(t->tile, COLOR_TILE, 0);
        lv_obj_set_style_radius(t->tile, 18, 0);
        lv_obj_set_style_shadow_width(t->tile, 0, 0);
        lv_obj_set_style_pad_all(t->tile, 16, 0);
        lv_obj_set_style_pad_gap(t->tile, 0, 0);
        /* subtle darkening on press for tactile feedback */
        lv_obj_set_style_bg_opa(t->tile, LV_OPA_80, LV_STATE_PRESSED);
        lv_obj_set_flex_flow(t->tile, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_align(t->tile, LV_FLEX_ALIGN_START,
                              LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
        lv_obj_add_event_cb(t->tile, on_tile_clicked, LV_EVENT_SHORT_CLICKED, t);
        lv_obj_add_event_cb(t->tile, on_tile_long_pressed, LV_EVENT_LONG_PRESSED, t);

        t->icon = lv_label_create(t->tile);
        lv_label_set_text(t->icon, LV_SYMBOL_POWER);
        lv_obj_set_style_text_font(t->icon, &lv_font_montserrat_32, 0);
        lv_obj_set_style_text_color(t->icon, COLOR_TEXT_DIM, 0);

        lv_obj_t *spacer = lv_obj_create(t->tile);
        lv_obj_set_width(spacer, LV_PCT(100));
        make_plain(spacer);
        lv_obj_set_flex_grow(spacer, 1);

        t->name_label = lv_label_create(t->tile);
        lv_label_set_text(t->name_label, t->entity->label);
        lv_obj_set_style_text_font(t->name_label, &lv_font_montserrat_24, 0);
        lv_obj_set_style_text_color(t->name_label, COLOR_TEXT, 0);

        t->state_label = lv_label_create(t->tile);
        lv_label_set_text(t->state_label, "...");
        lv_obj_set_style_text_font(t->state_label, &lv_font_montserrat_18, 0);
        lv_obj_set_style_text_color(t->state_label, COLOR_TEXT_DIM, 0);
    }
}

static void on_show_all_clicked(lv_event_t *e); /* opens the active tab's drawer */

static void create_scene_row(lv_obj_t *parent, const panel_tab_t *tab, int tab_idx)
{
    lv_obj_t *row = lv_obj_create(parent);
    lv_obj_set_size(row, LV_PCT(100), SCENE_ROW_H);
    make_plain(row);
    lv_obj_set_style_pad_hor(row, 16, 0);
    lv_obj_set_style_pad_bottom(row, 14, 0);
    lv_obj_set_style_pad_gap(row, 12, 0);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);

    if (tab->scene_tiles && tab->light_count > 0 && s_tile_count < PANEL_MAX_LIGHTS) {
        /* Square power toggle for the zone group (lights[0]): tap toggles,
         * long-press opens the brightness/colour popup for the whole group.
         * Registered as a tile (no text labels) so HA state colours it. */
        light_tile_t *t = &s_tiles[s_tile_count++];
        t->entity = &tab->lights[0];
        t->tab_idx = tab_idx;
        t->name_label = NULL;
        t->state_label = NULL;
        t->tile = lv_button_create(row);
        lv_obj_set_size(t->tile, SCENE_ROW_H - 14, LV_PCT(100));
        lv_obj_set_style_bg_color(t->tile, COLOR_TILE, 0);
        lv_obj_set_style_radius(t->tile, 14, 0);
        lv_obj_set_style_shadow_width(t->tile, 0, 0);
        lv_obj_set_style_bg_opa(t->tile, LV_OPA_80, LV_STATE_PRESSED);
        lv_obj_add_event_cb(t->tile, on_tile_clicked, LV_EVENT_SHORT_CLICKED, t);
        lv_obj_add_event_cb(t->tile, on_tile_long_pressed, LV_EVENT_LONG_PRESSED, t);
        t->icon = lv_label_create(t->tile);
        lv_label_set_text(t->icon, LV_SYMBOL_POWER);
        lv_obj_set_style_text_font(t->icon, &lv_font_montserrat_32, 0);
        lv_obj_set_style_text_color(t->icon, COLOR_TEXT_DIM, 0);
        lv_obj_center(t->icon);
    }

    if (tab->scene_tiles && tab->quick_scenes > 0) {
        /* Quick scenes: small square icon buttons (e.g. Min / Max brightness)
         * that behave exactly like the grid scene tiles (same registry). */
        const int scene_n = tab->scene_count < MAX_SCENES ? tab->scene_count : MAX_SCENES;
        const int first = scene_n - (tab->quick_scenes < scene_n ? tab->quick_scenes : 0);
        for (int i = first; i < scene_n; i++) {
            lv_obj_t *btn = lv_button_create(row);
            lv_obj_set_size(btn, SCENE_ROW_H - 14, LV_PCT(100));
            lv_obj_set_style_bg_color(btn, COLOR_TILE, 0);
            lv_obj_set_style_radius(btn, 14, 0);
            lv_obj_set_style_shadow_width(btn, 0, 0);
            lv_obj_set_style_bg_opa(btn, LV_OPA_80, LV_STATE_PRESSED);
            s_scene_chips[tab_idx][i] = btn;
            s_scene_ctx[tab_idx][i] = (scene_ctx_t){ &tab->scenes[i], tab_idx };
            lv_obj_add_event_cb(btn, on_scene_clicked, LV_EVENT_SHORT_CLICKED,
                                &s_scene_ctx[tab_idx][i]);
            lv_obj_t *icon = lv_label_create(btn);
            lv_label_set_text(icon, (tab->scene_icons && tab->scene_icons[i])
                                        ? tab->scene_icons[i] : tab->scenes[i].label);
            lv_obj_set_style_text_font(icon, &lv_font_montserrat_24, 0);
            lv_obj_set_style_text_color(icon, COLOR_TEXT_DIM, 0);
            lv_obj_center(icon);
            s_scene_icon[tab_idx][i] = icon;
            s_scene_name[tab_idx][i] = NULL;
            s_scene_state_lbl[tab_idx][i] = NULL;
        }
    }

    if (tab->scene_tiles) {
        /* Scene tab: the scenes live in the grid, so the bottom row shows which
         * one is active (a passive pill; the grid tiles were registered by
         * create_light_grid). */
        lv_obj_t *pill = lv_obj_create(row);
        lv_obj_set_flex_grow(pill, 2);
        lv_obj_set_height(pill, LV_PCT(100));
        make_plain(pill);
        lv_obj_set_style_bg_color(pill, COLOR_TILE_OFF, 0);
        lv_obj_set_style_bg_opa(pill, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(pill, 14, 0);
        lv_obj_set_style_pad_hor(pill, 18, 0);
        lv_obj_t *lbl = lv_label_create(pill);
        lv_label_set_text(lbl, "Actieve scene:  -");
        lv_label_set_long_mode(lbl, LV_LABEL_LONG_DOT);
        lv_obj_set_width(lbl, LV_PCT(100));
        lv_obj_set_style_text_font(lbl, &lv_font_montserrat_18, 0);
        lv_obj_set_style_text_color(lbl, COLOR_TEXT_DIM, 0);
        lv_obj_align(lbl, LV_ALIGN_LEFT_MID, 0, 0);
        s_active_scene_lbl[tab_idx] = lbl;
    }

    const int scene_n = tab->scene_tiles ? 0
                        : (tab->scene_count < MAX_SCENES ? tab->scene_count : MAX_SCENES);
    if (!tab->scene_tiles) {
        s_scene_counts[tab_idx] = scene_n;
    }
    for (int i = 0; i < scene_n; i++) {
        lv_obj_t *chip = lv_button_create(row);
        lv_obj_set_flex_grow(chip, 1);
        lv_obj_set_height(chip, LV_PCT(100));
        lv_obj_set_style_bg_color(chip, COLOR_SCENE, 0);
        lv_obj_set_style_radius(chip, 14, 0);
        lv_obj_set_style_shadow_width(chip, 0, 0);
        lv_obj_set_style_bg_opa(chip, LV_OPA_70, LV_STATE_PRESSED);
        s_scene_chips[tab_idx][i] = chip;
        s_scene_ctx[tab_idx][i] = (scene_ctx_t){ &tab->scenes[i], tab_idx };
        lv_obj_add_event_cb(chip, on_scene_clicked, LV_EVENT_CLICKED,
                            &s_scene_ctx[tab_idx][i]);

        lv_obj_t *label = lv_label_create(chip);
        lv_label_set_text(label, tab->scenes[i].label);
        lv_obj_set_style_text_font(label, &lv_font_montserrat_18, 0);
        lv_obj_set_style_text_color(label, COLOR_TEXT, 0);
        lv_obj_center(label);
    }

    /* "Alle lampen" button toggles this tab's slide-out drawer (and lights up
     * amber while it's open). The chevron flips between expand/collapse. */
    lv_obj_t *all = lv_button_create(row);
    lv_obj_set_flex_grow(all, 1);
    lv_obj_set_height(all, LV_PCT(100));
    lv_obj_set_style_bg_color(all, COLOR_TILE, 0);
    lv_obj_set_style_bg_color(all, COLOR_ACCENT, LV_STATE_CHECKED); /* active = drawer open */
    lv_obj_set_style_radius(all, 14, 0);
    lv_obj_set_style_shadow_width(all, 0, 0);
    lv_obj_set_style_bg_opa(all, LV_OPA_70, LV_STATE_PRESSED);
    lv_obj_add_event_cb(all, on_show_all_clicked, LV_EVENT_CLICKED, NULL);

    lv_obj_t *all_lbl = lv_label_create(all);
    lv_label_set_text(all_lbl, SHOW_ALL_CLOSED_TXT);
    lv_obj_set_style_text_font(all_lbl, &lv_font_montserrat_18, 0);
    lv_obj_set_style_text_color(all_lbl, COLOR_ACCENT, 0);
    lv_obj_center(all_lbl);
    if (tab_idx >= 0 && tab_idx < (int)PANEL_TAB_COUNT) {
        s_show_all_btn[tab_idx] = all;
        s_show_all_lbl[tab_idx] = all_lbl;
    }
}

/* ---- Slide-out drawer: all individual devices for one floor ------------- */

static void anim_x_cb(void *obj, int32_t v)
{
    lv_obj_set_x(obj, v);
}

/* The drawer is full-screen with many tiles, so animating it live re-rasterizes
 * everything each frame. Instead snapshot it once and slide the bitmap (a blit).
 * A static snapshot of the screen behind it is shown as a frozen backdrop so the
 * uncovered strip doesn't re-rasterize the live tabview during the slide. */
static lv_obj_t *s_drawer_slide_img;
static lv_draw_buf_t *s_drawer_slide_snap;
static bool s_drawer_slide_owned;   /* free s_drawer_slide_snap (on-demand) vs keep (warm) */
static lv_obj_t *s_drawer_back;     /* opaque backdrop so nothing live re-renders */
static lv_obj_t *s_drawer_live;
/* Pre-rendered snapshot of the active tab's drawer, kept warm so opening it is
 * instant (no ~68ms snapshot on tap). Only the active tab's drawer can open. */
static lv_draw_buf_t *s_drawer_warm;
static int s_drawer_warm_tab = -1;
static bool s_drawer_warm_dirty;

static int drawer_tab_index(lv_obj_t *d)
{
    for (int i = 0; i < (int)PANEL_TAB_COUNT; i++) {
        if (s_drawers[i] == d) {
            return i;
        }
    }
    return -1;
}

static void drawer_slide_cleanup(void)
{
    if (s_drawer_slide_img) {
        lv_obj_delete(s_drawer_slide_img);
        s_drawer_slide_img = NULL;
    }
    if (s_drawer_back) {
        lv_obj_delete(s_drawer_back);
        s_drawer_back = NULL;
    }
    if (s_drawer_slide_snap) {
        if (s_drawer_slide_owned) { /* warm cache is kept; only free on-demand snaps */
            lv_draw_buf_destroy(s_drawer_slide_snap);
        }
        s_drawer_slide_snap = NULL;
    }
}

static void drawer_open_done(lv_anim_t *a)
{
    (void)a;
    if (s_drawer_live) {
        lv_obj_set_x(s_drawer_live, 0); /* reveal the live (interactive) drawer */
    }
    drawer_slide_cleanup();
}

static void drawer_close_done(lv_anim_t *a)
{
    (void)a;
    drawer_slide_cleanup(); /* live drawer is already parked off-screen */
}

static void drawer_live_anim(lv_obj_t *drawer, bool opening)
{
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, drawer);
    lv_anim_set_values(&a, opening ? LV_HOR_RES : 0, opening ? 0 : LV_HOR_RES);
    lv_anim_set_duration(&a, opening ? 260 : 240);
    lv_anim_set_exec_cb(&a, anim_x_cb);
    lv_anim_set_path_cb(&a, opening ? lv_anim_path_ease_out : lv_anim_path_ease_in);
    lv_anim_start(&a);
}

static lv_obj_t *make_slide_image(lv_draw_buf_t *snap, int x)
{
    lv_obj_t *img = lv_image_create(lv_screen_active());
    lv_obj_add_flag(img, LV_OBJ_FLAG_FLOATING);
    lv_image_set_src(img, snap);
    lv_obj_set_pos(img, x, DRAWER_Y);
    lv_obj_move_foreground(img);
    return img;
}

static void drawer_slide(lv_obj_t *drawer, bool opening)
{
    if (drawer == NULL || s_drawer_slide_img) {
        return; /* ignore if a slide is already animating */
    }
    const int tab = drawer_tab_index(drawer);
    lv_draw_buf_t *dsnap;
    bool owned;
    if (s_drawer_warm != NULL && s_drawer_warm_tab == tab && !s_drawer_warm_dirty) {
        dsnap = s_drawer_warm; /* pre-rendered: instant open/close, keep the cache */
        owned = false;
    } else {
        dsnap = lv_snapshot_take(drawer, LV_COLOR_FORMAT_RGB565);
        owned = true;
        if (dsnap == NULL) {
            drawer_live_anim(drawer, opening); /* fallback: live animation */
            return;
        }
    }
    lv_obj_set_x(drawer, LV_HOR_RES); /* park the live drawer off-screen */
    s_drawer_live = drawer;
    s_drawer_slide_snap = dsnap;
    s_drawer_slide_owned = owned;

    /* Opaque backdrop over the drawer band so the moving bitmap never exposes
     * the live grid tiles to per-frame re-rasterization; the uncovered strip is
     * then just a cheap solid fill. Sized to the band, so the header + scene row
     * stay untouched. */
    s_drawer_back = lv_obj_create(lv_screen_active());
    lv_obj_add_flag(s_drawer_back, LV_OBJ_FLAG_FLOATING);
    lv_obj_remove_flag(s_drawer_back, LV_OBJ_FLAG_SCROLLABLE);
    make_plain(s_drawer_back);
    lv_obj_set_style_bg_color(s_drawer_back, COLOR_BG, 0);
    lv_obj_set_style_bg_opa(s_drawer_back, LV_OPA_COVER, 0);
    lv_obj_set_pos(s_drawer_back, 0, DRAWER_Y);
    lv_obj_set_size(s_drawer_back, LV_HOR_RES, DRAWER_H);
    lv_obj_move_foreground(s_drawer_back);

    s_drawer_slide_img = make_slide_image(dsnap, opening ? LV_HOR_RES : 0); /* on top */

    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, s_drawer_slide_img);
    lv_anim_set_values(&a, opening ? LV_HOR_RES : 0, opening ? 0 : LV_HOR_RES);
    lv_anim_set_duration(&a, opening ? 240 : 220);
    lv_anim_set_exec_cb(&a, anim_x_cb);
    lv_anim_set_path_cb(&a, opening ? lv_anim_path_ease_out : lv_anim_path_ease_in);
    lv_anim_set_completed_cb(&a, opening ? drawer_open_done : drawer_close_done);
    lv_anim_start(&a);
}

static void drawer_open(lv_obj_t *drawer)
{
    drawer_slide(drawer, true);
}

static void drawer_close(lv_obj_t *drawer)
{
    drawer_slide(drawer, false);
}

static void on_show_all_clicked(lv_event_t *e)
{
    (void)e;
    if (s_drawer_slide_img) {
        return; /* mid-slide: ignore */
    }
    const uint32_t idx = lv_tabview_get_tab_active(s_tabview);
    if (idx >= PANEL_TAB_COUNT) {
        return;
    }
    s_drawer_open = !s_drawer_open;
    if (s_drawer_open) {
        drawer_open(s_drawers[idx]);
    } else {
        drawer_close(s_drawers[idx]);
    }
    /* Reflect state on the button: amber bg + dark, readable label + a chevron
     * that flips between expand (closed) and collapse (open). */
    if (s_show_all_btn[idx]) {
        if (s_drawer_open) {
            lv_obj_add_state(s_show_all_btn[idx], LV_STATE_CHECKED);
        } else {
            lv_obj_remove_state(s_show_all_btn[idx], LV_STATE_CHECKED);
        }
    }
    if (s_show_all_lbl[idx]) {
        lv_label_set_text(s_show_all_lbl[idx],
                          s_drawer_open ? SHOW_ALL_OPEN_TXT : SHOW_ALL_CLOSED_TXT);
        lv_obj_set_style_text_color(s_show_all_lbl[idx],
                                    s_drawer_open ? COLOR_ON_TEXT : COLOR_ACCENT, 0);
    }
}

/* Compact device tile registered in s_tiles so state updates reach it too. */
static void create_device_tile(lv_obj_t *parent, const panel_entity_t *dev, int tab_idx)
{
    if (s_tile_count >= PANEL_MAX_LIGHTS) {
        return;
    }
    light_tile_t *t = &s_tiles[s_tile_count++];
    t->entity = dev;
    t->tab_idx = tab_idx;

    t->tile = lv_button_create(parent);
    lv_obj_set_size(t->tile, 178, 84);
    lv_obj_set_style_bg_color(t->tile, COLOR_TILE, 0);
    lv_obj_set_style_radius(t->tile, 14, 0);
    lv_obj_set_style_shadow_width(t->tile, 0, 0);
    lv_obj_set_style_pad_all(t->tile, 12, 0);
    lv_obj_set_style_pad_gap(t->tile, 0, 0);
    lv_obj_set_style_bg_opa(t->tile, LV_OPA_80, LV_STATE_PRESSED);
    lv_obj_set_flex_flow(t->tile, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(t->tile, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START,
                          LV_FLEX_ALIGN_START);
    lv_obj_add_event_cb(t->tile, on_tile_clicked, LV_EVENT_SHORT_CLICKED, t);
    lv_obj_add_event_cb(t->tile, on_tile_long_pressed, LV_EVENT_LONG_PRESSED, t);

    t->icon = lv_label_create(t->tile);
    lv_label_set_text(t->icon, LV_SYMBOL_POWER);
    lv_obj_set_style_text_font(t->icon, &lv_font_montserrat_18, 0);
    lv_obj_set_style_text_color(t->icon, COLOR_TEXT_DIM, 0);

    lv_obj_t *spacer = lv_obj_create(t->tile);
    lv_obj_set_width(spacer, LV_PCT(100));
    make_plain(spacer);
    lv_obj_set_flex_grow(spacer, 1);

    t->name_label = lv_label_create(t->tile);
    lv_label_set_text(t->name_label, t->entity->label);
    lv_obj_set_style_text_font(t->name_label, &lv_font_montserrat_18, 0);
    lv_obj_set_style_text_color(t->name_label, COLOR_TEXT, 0);

    t->state_label = lv_label_create(t->tile);
    lv_label_set_text(t->state_label, "...");
    lv_obj_set_style_text_font(t->state_label, &lv_font_montserrat_18, 0);
    lv_obj_set_style_text_color(t->state_label, COLOR_TEXT_DIM, 0);
}

static lv_obj_t *create_drawer(const panel_tab_t *tab, int tab_idx)
{
    /* Overlay covering only the middle band (below the header, above the scene
     * row), parked off the right edge. FLOATING so the screen flex doesn't move
     * it. Scrollable wrap of compact device tiles; no header/back button -- the
     * "Alle lampen" button toggles it closed. */
    lv_obj_t *drawer = lv_obj_create(lv_screen_active());
    lv_obj_add_flag(drawer, LV_OBJ_FLAG_FLOATING);
    lv_obj_set_size(drawer, LV_HOR_RES, DRAWER_H);
    lv_obj_set_pos(drawer, LV_HOR_RES, DRAWER_Y);
    lv_obj_set_style_bg_color(drawer, COLOR_BG, 0);
    lv_obj_set_style_border_width(drawer, 0, 0);
    lv_obj_set_style_radius(drawer, 0, 0);
    lv_obj_set_style_pad_all(drawer, 16, 0);
    lv_obj_set_style_pad_gap(drawer, 12, 0);
    lv_obj_set_flex_flow(drawer, LV_FLEX_FLOW_ROW_WRAP);
    lv_obj_set_flex_align(drawer, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START,
                          LV_FLEX_ALIGN_START);

    for (int i = 0; i < tab->device_count; i++) {
        create_device_tile(drawer, &tab->devices[i], tab_idx);
    }
    return drawer;
}

/* Vertical brightness slider on the right edge, spanning only the tile-grid
 * area (above the scene row, so it doesn't steal the bottom row's space).
 * Sets the active tab's area brightness on release. */
static void create_bright_slider(lv_obj_t *screen)
{
    const int32_t top = CONTENT_Y + 26;                      /* start a bit lower */
    const int32_t bottom = LV_VER_RES - SCENE_ROW_H - 8;     /* stop above scene row */
    const int32_t slider_x = SLIDER_LANE_X;

    lv_obj_t *slider = lv_slider_create(screen);
    lv_obj_add_flag(slider, LV_OBJ_FLAG_FLOATING);
    lv_obj_set_size(slider, SLIDER_W, bottom - top);          /* taller than wide -> vertical */
    lv_obj_set_pos(slider, slider_x, top);
    lv_slider_set_range(slider, 0, 100);
    lv_slider_set_value(slider, 50, LV_ANIM_OFF);
    /* Track */
    lv_obj_set_style_bg_color(slider, COLOR_TILE, LV_PART_MAIN);
    lv_obj_set_style_radius(slider, 14, LV_PART_MAIN);
    /* Filled indicator */
    lv_obj_set_style_bg_color(slider, COLOR_TILE_ON, LV_PART_INDICATOR);
    lv_obj_set_style_radius(slider, 14, LV_PART_INDICATOR);
    /* Knob */
    lv_obj_set_style_bg_color(slider, COLOR_TEXT, LV_PART_KNOB);
    lv_obj_set_style_pad_all(slider, 5, LV_PART_KNOB);
    lv_obj_set_style_radius(slider, LV_RADIUS_CIRCLE, LV_PART_KNOB);
    lv_obj_add_event_cb(slider, on_bright_slider_event, LV_EVENT_PRESSED, NULL);
    lv_obj_add_event_cb(slider, on_bright_slider_event, LV_EVENT_VALUE_CHANGED, NULL);
    lv_obj_add_event_cb(slider, on_bright_slider_event, LV_EVENT_RELEASED, NULL);
    s_bright_slider = slider;

    /* % readout just above the slider */
    s_bright_label = lv_label_create(screen);
    lv_obj_add_flag(s_bright_label, LV_OBJ_FLAG_FLOATING);
    lv_label_set_text(s_bright_label, "");
    lv_obj_set_style_text_font(s_bright_label, &lv_font_montserrat_18, 0);
    lv_obj_set_style_text_color(s_bright_label, COLOR_TEXT_DIM, 0);
    lv_obj_set_pos(s_bright_label, slider_x, CONTENT_Y + 2);
}

/* When the tab changes, show that tab's last-known area brightness. */
static void on_tab_changed(lv_event_t *e)
{
    (void)e;
    const uint32_t idx = lv_tabview_get_tab_active(s_tabview);
    if (idx < PANEL_TAB_COUNT && s_bright_slider && s_tab_brightness[idx] >= 0) {
        lv_slider_set_value(s_bright_slider, s_tab_brightness[idx], LV_ANIM_OFF);
        if (s_bright_label) {
            lv_label_set_text_fmt(s_bright_label, "%d%%", s_tab_brightness[idx]);
        }
    }
}

/* ---- Per-light brightness popup (opened by long-press) ------------------ */

static void on_popup_slider(lv_event_t *e)
{
    if (lv_event_get_code(e) == LV_EVENT_RELEASED && s_popup_entity && s_brightness_cb) {
        const int v = lv_slider_get_value(lv_event_get_target(e));
        s_brightness_cb(s_popup_entity, 1, v);
    }
}

/* Colour/warmth slider: live knob feedback while dragging, applies on release. */
static void on_popup_color_slider(lv_event_t *e)
{
    const lv_event_code_t code = lv_event_get_code(e);
    lv_obj_t *sl = lv_event_get_target(e);
    const int v = lv_slider_get_value(sl);
    if (code == LV_EVENT_VALUE_CHANGED) {
        /* Tint the indicator + knob so the slider previews the chosen colour. */
        lv_color_t c;
        if (s_popup_color_mode == 1) {
            c = lv_color_hsv_to_rgb((uint16_t)v, 100, 100);
        } else {
            const int span = s_popup_max_k > s_popup_min_k ? s_popup_max_k - s_popup_min_k : 1;
            const int t = ((v - s_popup_min_k) * 255) / span; /* 0 warm .. 255 cool */
            c = lv_color_make(255, 180 + t / 4, 110 + t / 2);
        }
        lv_obj_set_style_bg_color(sl, c, LV_PART_INDICATOR);
        lv_obj_set_style_bg_color(sl, c, LV_PART_KNOB);
    } else if (code == LV_EVENT_RELEASED && s_popup_entity) {
        if (s_popup_color_mode == 1 && s_color_cb) {
            s_color_cb(s_popup_entity->entity_id, v, 100);
        } else if (s_popup_color_mode == 2 && s_warmth_cb) {
            s_warmth_cb(s_popup_entity->entity_id, v);
        }
    }
}

static void on_popup_close(lv_event_t *e)
{
    (void)e;
    lv_obj_add_flag(s_popup, LV_OBJ_FLAG_HIDDEN);
}

/* Build the rainbow (hue) and warm->cool gradient descriptors once. */
static void init_slider_grads(void)
{
    lv_color_t hue[7];
    for (int i = 0; i < 7; i++) {
        hue[i] = lv_color_hsv_to_rgb((uint16_t)((i * 60) % 360), 100, 100);
    }
    lv_grad_init_stops(&s_hue_grad, hue, NULL, NULL, 7);
    s_hue_grad.dir = LV_GRAD_DIR_HOR;

    lv_color_t warm[2] = { lv_color_hex(0xffb46b), lv_color_hex(0xcfe0ff) };
    lv_grad_init_stops(&s_warm_grad, warm, NULL, NULL, 2);
    s_warm_grad.dir = LV_GRAD_DIR_HOR;
}

static void create_popup(lv_obj_t *root)
{
    /* Dim backdrop; tapping it closes. */
    s_popup = lv_obj_create(root);
    lv_obj_set_size(s_popup, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_color(s_popup, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(s_popup, LV_OPA_50, 0);
    lv_obj_set_style_border_width(s_popup, 0, 0);
    lv_obj_set_style_radius(s_popup, 0, 0);
    lv_obj_clear_flag(s_popup, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(s_popup, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_event_cb(s_popup, on_popup_close, LV_EVENT_CLICKED, NULL);

    /* Centered box (clicks here do not bubble to the backdrop). */
    lv_obj_t *box = lv_obj_create(s_popup);
    lv_obj_set_size(box, 480, 300);
    lv_obj_center(box);
    lv_obj_set_style_bg_color(box, COLOR_TILE, 0);
    lv_obj_set_style_radius(box, 20, 0);
    lv_obj_set_style_border_width(box, 0, 0);
    lv_obj_set_style_pad_all(box, 24, 0);
    lv_obj_set_style_pad_gap(box, 8, 0);
    lv_obj_clear_flag(box, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(box, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(box, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_START,
                          LV_FLEX_ALIGN_CENTER);

    s_popup_title = lv_label_create(box);
    lv_label_set_text(s_popup_title, "");
    lv_obj_set_style_text_font(s_popup_title, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(s_popup_title, COLOR_TEXT, 0);
    lv_obj_set_style_pad_bottom(s_popup_title, 12, 0);

    settings_label(box, "Helderheid", &lv_font_montserrat_18, COLOR_TEXT_DIM);
    s_popup_slider = lv_slider_create(box);
    lv_obj_set_size(s_popup_slider, LV_PCT(100), 40);
    lv_slider_set_range(s_popup_slider, 0, 100);
    lv_obj_set_style_bg_color(s_popup_slider, COLOR_TILE_OFF, LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_popup_slider, COLOR_TILE_ON, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(s_popup_slider, COLOR_TEXT, LV_PART_KNOB);
    lv_obj_set_style_pad_all(s_popup_slider, 6, LV_PART_KNOB);
    lv_obj_add_event_cb(s_popup_slider, on_popup_slider, LV_EVENT_RELEASED, NULL);

    s_popup_color_label = settings_label(box, "Kleur", &lv_font_montserrat_18, COLOR_TEXT_DIM);
    lv_obj_set_style_pad_top(s_popup_color_label, 6, 0);
    s_popup_color_slider = lv_slider_create(box);
    lv_obj_set_size(s_popup_color_slider, LV_PCT(100), 40);
    lv_obj_set_style_bg_color(s_popup_color_slider, COLOR_TILE_OFF, LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_popup_color_slider, LV_OPA_TRANSP, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(s_popup_color_slider, COLOR_TEXT, LV_PART_KNOB);
    lv_obj_set_style_pad_all(s_popup_color_slider, 6, LV_PART_KNOB);
    lv_obj_add_event_cb(s_popup_color_slider, on_popup_color_slider, LV_EVENT_VALUE_CHANGED, NULL);
    lv_obj_add_event_cb(s_popup_color_slider, on_popup_color_slider, LV_EVENT_RELEASED, NULL);
    lv_obj_add_flag(s_popup_color_slider, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_popup_color_label, LV_OBJ_FLAG_HIDDEN);
}

/* ---- Boot splash -------------------------------------------------------- */

static void splash_fade_done(lv_anim_t *a)
{
    (void)a;
    if (s_splash) {
        lv_obj_delete(s_splash); /* frees the bar/labels; the artwork stays in flash */
        s_splash = NULL;
    }
}

static void splash_fade_cb(void *obj, int32_t v)
{
    lv_obj_set_style_opa(obj, (lv_opa_t)v, 0);
}

/* Creep the bar towards the requested progress so it always looks alive, and
 * fade the splash out once 100 % is requested and the minimum time has passed. */
static void splash_timer_cb(lv_timer_t *t)
{
    if (s_splash == NULL || s_splash_done) {
        lv_timer_delete(t);
        return;
    }
    const int cur = lv_bar_get_value(s_splash_bar);
    const uint32_t shown = lv_tick_elaps(s_splash_shown_tick);
    /* Time-based floor: 0 -> 85 % over the minimum display time even with no
     * events, so a slow network still shows movement. */
    const int floor_pct = (int)LV_MIN(85U, shown * 85U / SPLASH_MIN_MS);
    const int target = LV_MAX(s_splash_target, floor_pct);
    if (cur < target) {
        lv_bar_set_value(s_splash_bar, LV_MIN(cur + 2, target), LV_ANIM_OFF);
    }
    if (s_splash_target >= 100 && shown >= SPLASH_MIN_MS && cur >= 100) {
        s_splash_done = true;
        lv_anim_t a;
        lv_anim_init(&a);
        lv_anim_set_var(&a, s_splash);
        lv_anim_set_values(&a, LV_OPA_COVER, LV_OPA_TRANSP);
        lv_anim_set_duration(&a, 500);
        lv_anim_set_exec_cb(&a, splash_fade_cb);
        lv_anim_set_completed_cb(&a, splash_fade_done);
        lv_anim_start(&a);
        lv_timer_delete(t);
    }
}

static void create_splash(lv_obj_t *root)
{
    s_splash_dsc = s_splash_img;
    s_splash_dsc.data = splash_rgb565_start;

    s_splash = lv_obj_create(root);
    lv_obj_set_size(s_splash, LV_PCT(100), LV_PCT(100));
    make_plain(s_splash);
    lv_obj_set_style_bg_color(s_splash, lv_color_hex(0x050b16), 0);
    lv_obj_set_style_bg_opa(s_splash, LV_OPA_COVER, 0);

    lv_obj_t *img = lv_image_create(s_splash);
    lv_image_set_src(img, &s_splash_dsc);
    lv_obj_center(img);

    /* Loader in the artwork's empty lower third: thin amber-to-cyan bar. */
    s_splash_bar = lv_bar_create(s_splash);
    lv_obj_set_size(s_splash_bar, 360, 6);
    lv_obj_align(s_splash_bar, LV_ALIGN_BOTTOM_MID, 0, -74);
    lv_bar_set_range(s_splash_bar, 0, 100);
    lv_bar_set_value(s_splash_bar, 0, LV_ANIM_OFF);
    lv_obj_set_style_bg_color(s_splash_bar, lv_color_hex(0x16213a), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_splash_bar, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_radius(s_splash_bar, 3, LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_splash_bar, lv_color_hex(0xffb84d), LV_PART_INDICATOR);
    lv_obj_set_style_bg_grad_color(s_splash_bar, lv_color_hex(0x3ee0ff), LV_PART_INDICATOR);
    lv_obj_set_style_bg_grad_dir(s_splash_bar, LV_GRAD_DIR_HOR, LV_PART_INDICATOR);
    lv_obj_set_style_radius(s_splash_bar, 3, LV_PART_INDICATOR);

    s_splash_status = lv_label_create(s_splash);
    lv_label_set_text(s_splash_status, "Opstarten...");
    lv_obj_set_style_text_font(s_splash_status, &lv_font_montserrat_18, 0);
    lv_obj_set_style_text_color(s_splash_status, lv_color_hex(0x9fb3d1), 0);
    lv_obj_align(s_splash_status, LV_ALIGN_BOTTOM_MID, 0, -42);

    s_splash_shown_tick = lv_tick_get();
    s_splash_target = 5;
    lv_timer_create(splash_timer_cb, 40, NULL);
}

void panel_ui_splash_progress(int percent, const char *status)
{
    if (s_splash == NULL || s_splash_done || !bsp_display_lock(500)) {
        return;
    }
    if (percent > s_splash_target) {
        s_splash_target = LV_MIN(percent, 100);
    }
    if (status && s_splash_status) {
        lv_label_set_text(s_splash_status, status);
    }
    bsp_display_unlock();
}

/* ---- Night dim / screensaver -------------------------------------------- */

static void eye_anim_opa(void *obj, int32_t v)
{
    lv_obj_set_style_opa(obj, (lv_opa_t)v, 0);
}

static void eye_anim_rot(void *obj, int32_t v)
{
    lv_arc_set_rotation(obj, v);
}

static void eye_flicker_done(lv_anim_t *a)
{
    (void)a;
    /* Back to the breathing pulse after a flicker. */
    lv_obj_set_style_opa(s_eye_glow, LV_OPA_COVER, 0);
}

/* Random short dips of the pupil glow every few seconds: an "alive" feel on
 * top of the regular pulse. */
static void eye_flicker_cb(lv_timer_t *t)
{
    if (s_eye_glow == NULL || lv_obj_has_flag(s_saver, LV_OBJ_FLAG_HIDDEN)) {
        return;
    }
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, s_eye_glow);
    lv_anim_set_exec_cb(&a, eye_anim_opa);
    lv_anim_set_values(&a, LV_OPA_COVER, LV_OPA_30);
    lv_anim_set_duration(&a, 90);
    lv_anim_set_playback_duration(&a, 140);
    lv_anim_set_repeat_count(&a, (lv_rand(0, 10) < 3) ? 2 : 1);
    lv_anim_set_completed_cb(&a, eye_flicker_done);
    lv_anim_start(&a);
    lv_timer_set_period(t, lv_rand(4000, 9000));
}

static void eye_anims_start(void)
{
    lv_anim_t a;
    /* Pupil glow: slow pulse. */
    lv_anim_init(&a);
    lv_anim_set_var(&a, s_eye_glow);
    lv_anim_set_exec_cb(&a, eye_anim_opa);
    lv_anim_set_values(&a, LV_OPA_50, LV_OPA_COVER);
    lv_anim_set_duration(&a, 1600);
    lv_anim_set_playback_duration(&a, 1600);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_in_out);
    lv_anim_start(&a);
    /* Whole eye: a longer, subtler breath. */
    lv_anim_init(&a);
    lv_anim_set_var(&a, s_eye_img);
    lv_anim_set_exec_cb(&a, eye_anim_opa);
    lv_anim_set_values(&a, LV_OPA_COVER, LV_OPA_80);
    lv_anim_set_duration(&a, 2700);
    lv_anim_set_playback_duration(&a, 2700);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_in_out);
    lv_anim_start(&a);
    /* Scanning ring: one revolution every 9 s. */
    lv_anim_init(&a);
    lv_anim_set_var(&a, s_eye_ring);
    lv_anim_set_exec_cb(&a, eye_anim_rot);
    lv_anim_set_values(&a, 0, 360);
    lv_anim_set_duration(&a, 9000);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_start(&a);
    if (s_eye_flicker_timer) {
        lv_timer_resume(s_eye_flicker_timer);
    }
}

static void eye_anims_stop(void)
{
    lv_anim_delete(s_eye_glow, NULL);
    lv_anim_delete(s_eye_img, NULL);
    lv_anim_delete(s_eye_ring, NULL);
    if (s_eye_flicker_timer) {
        lv_timer_pause(s_eye_flicker_timer);
    }
}

/* Room temperatures in the eye screensaver (top-left, top to bottom). */
static void saver_refresh_temps(void)
{
    for (int i = 0; i < (int)PANEL_TEMP_SENSOR_COUNT; i++) {
        if (s_eye_temps[i] == NULL) {
            continue;
        }
        if (isnan(s_temp_now[i])) {
            lv_label_set_text_fmt(s_eye_temps[i], "%s   --", PANEL_TEMP_SENSORS[i].abbr);
        } else {
            lv_label_set_text_fmt(s_eye_temps[i], "%s   %.1f\xC2\xB0", PANEL_TEMP_SENSORS[i].abbr,
                                  (double)s_temp_now[i]);
        }
    }
}

/* Show the saver in the configured mode. Caller holds the LVGL lock. */
static void saver_show(void)
{
    if (s_saver == NULL) {
        return;
    }
    /* Clock straight away (the 1 Hz saver timer only refreshes on minute changes). */
    time_t now = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    if (tm_now.tm_year > 100 && s_saver_clock) {
        lv_label_set_text_fmt(s_saver_clock, "%02d:%02d", tm_now.tm_hour, tm_now.tm_min);
    }
    lv_obj_remove_flag(s_saver, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(s_saver);
    if (s_saver_mode == SAVER_MODE_EYE && s_eye_group) {
        saver_refresh_temps();
        lv_obj_remove_flag(s_eye_group, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_style_text_color(s_saver_clock, lv_color_hex(0x5a3028), 0); /* ember, fits the eye */
        eye_anims_start();
        bsp_display_backlight_on();
    } else {
        lv_obj_set_style_text_color(s_saver_clock, lv_color_hex(0x2e3340), 0);
        if (s_eye_group) {
            lv_obj_add_flag(s_eye_group, LV_OBJ_FLAG_HIDDEN);
        }
        /* The backlight GPIO is on/off only (no PWM), so "dim" means off: a
         * black overlay with the backlight lit still burns the full panel
         * power. Any touch wakes it (on_saver_click). */
        bsp_display_backlight_off();
    }
}

static void saver_hide(void)
{
    if (s_saver == NULL) {
        return;
    }
    eye_anims_stop();
    lv_obj_add_flag(s_saver, LV_OBJ_FLAG_HIDDEN);
    bsp_display_backlight_on();
}

static void on_saver_click(lv_event_t *e)
{
    (void)e;
    saver_hide();
}

static void saver_timer_cb(lv_timer_t *t)
{
    (void)t;
    time_t now = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    /* Only refresh the saver clock while it's visible, and only on a real
     * minute change (avoids a needless 1 Hz realloc while parked/hidden). */
    static int last_min = -1;
    const int mins = tm_now.tm_hour * 60 + tm_now.tm_min;
    if (tm_now.tm_year > 100 && mins != last_min &&
        !lv_obj_has_flag(s_saver, LV_OBJ_FLAG_HIDDEN)) {
        last_min = mins;
        lv_label_set_text_fmt(s_saver_clock, "%02d:%02d", tm_now.tm_hour, tm_now.tm_min);
        if (s_saver_mode == SAVER_MODE_EYE) {
            saver_refresh_temps();
        }
    }
    if (s_saver_timeout_ms > 0 &&
        lv_display_get_inactive_time(NULL) > s_saver_timeout_ms &&
        lv_obj_has_flag(s_saver, LV_OBJ_FLAG_HIDDEN)) {
        last_min = -1; /* force a clock refresh now that it's visible */
        lv_label_set_text_fmt(s_saver_clock, "%02d:%02d", tm_now.tm_hour, tm_now.tm_min);
        saver_show();
    }
}

static void create_screensaver(lv_obj_t *root)
{
    s_saver = lv_obj_create(root);
    lv_obj_set_size(s_saver, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_color(s_saver, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(s_saver, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(s_saver, 0, 0);
    lv_obj_set_style_radius(s_saver, 0, 0);
    lv_obj_clear_flag(s_saver, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(s_saver, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_event_cb(s_saver, on_saver_click, LV_EVENT_CLICKED, NULL);

    /* AI oog layer: eye artwork, glow, ring. Hidden unless that mode is active. */
    s_eye_group = lv_obj_create(s_saver);
    lv_obj_set_size(s_eye_group, LV_PCT(100), LV_PCT(100));
    make_plain(s_eye_group);
    lv_obj_add_flag(s_eye_group, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_eye_group, LV_OBJ_FLAG_EVENT_BUBBLE); /* taps reach on_saver_click */

    s_eye_dsc = (lv_image_dsc_t){
        .header = { .magic = LV_IMAGE_HEADER_MAGIC, .cf = LV_COLOR_FORMAT_RGB565, .flags = 0,
                    .w = 440, .h = 440, .stride = 440 * 2 },
        .data_size = 440 * 440 * 2,
        .data = eye_rgb565_start,
    };
    s_eye_img = lv_image_create(s_eye_group);
    lv_image_set_src(s_eye_img, &s_eye_dsc);
    lv_obj_center(s_eye_img);

    /* Pupil glow: red core fading to transparent, pulsed via opacity. */
    lv_color_t gc[2] = { lv_color_hex(0xff3b1f), lv_color_hex(0xff3b1f) };
    lv_opa_t go[2] = { LV_OPA_80, LV_OPA_TRANSP };
    lv_grad_init_stops(&s_eye_glow_grad, gc, go, NULL, 2);
    lv_grad_radial_init(&s_eye_glow_grad, LV_GRAD_CENTER, LV_GRAD_CENTER, LV_GRAD_RIGHT, LV_GRAD_CENTER,
                        LV_GRAD_EXTEND_PAD);
    s_eye_glow = lv_obj_create(s_eye_group);
    lv_obj_set_size(s_eye_glow, 170, 170);
    make_plain(s_eye_glow);
    lv_obj_set_style_radius(s_eye_glow, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(s_eye_glow, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_grad(s_eye_glow, &s_eye_glow_grad, 0);
    lv_obj_align(s_eye_glow, LV_ALIGN_CENTER, 4, 4); /* the artwork's pupil sits just off-centre */

    /* Scanning ring: a thin 50-degree amber arc that circles the rim. */
    s_eye_ring = lv_arc_create(s_eye_group);
    lv_obj_set_size(s_eye_ring, 470, 470);
    lv_obj_center(s_eye_ring);
    lv_arc_set_bg_angles(s_eye_ring, 0, 50);
    lv_arc_set_value(s_eye_ring, 0);
    lv_obj_remove_style(s_eye_ring, NULL, LV_PART_KNOB);
    lv_obj_remove_style(s_eye_ring, NULL, LV_PART_INDICATOR);
    lv_obj_set_style_arc_width(s_eye_ring, 2, LV_PART_MAIN);
    lv_obj_set_style_arc_color(s_eye_ring, lv_color_hex(0xff8a3d), LV_PART_MAIN);
    lv_obj_set_style_arc_opa(s_eye_ring, LV_OPA_60, LV_PART_MAIN);
    lv_obj_set_style_arc_rounded(s_eye_ring, true, LV_PART_MAIN);
    lv_obj_remove_flag(s_eye_ring, LV_OBJ_FLAG_CLICKABLE);

    /* Temperature column, top-left, top to bottom (eye mode only). */
    for (int i = 0; i < (int)PANEL_TEMP_SENSOR_COUNT; i++) {
        s_eye_temps[i] = lv_label_create(s_eye_group);
        lv_label_set_text(s_eye_temps[i], "");
        lv_obj_set_style_text_font(s_eye_temps[i], &lv_font_montserrat_24, 0);
        lv_obj_set_style_text_color(s_eye_temps[i], lv_color_hex(0x7a3d30), 0); /* ember */
        lv_obj_align(s_eye_temps[i], LV_ALIGN_TOP_LEFT, 28, 24 + i * 40);
    }

    s_saver_clock = lv_label_create(s_saver);
    lv_label_set_text(s_saver_clock, "--:--");
    lv_obj_set_style_text_font(s_saver_clock, &lv_font_montserrat_46, 0);
    lv_obj_set_style_text_color(s_saver_clock, lv_color_hex(0x2e3340), 0); /* dim */
    lv_obj_align(s_saver_clock, LV_ALIGN_BOTTOM_RIGHT, -28, -16);

    s_eye_flicker_timer = lv_timer_create(eye_flicker_cb, 6000, NULL);
    lv_timer_pause(s_eye_flicker_timer);

    lv_timer_create(saver_timer_cb, 1000, NULL);
}

void panel_ui_debug_saver(int show)
{
    if (!bsp_display_lock(1000)) {
        return;
    }
    if (show) {
        saver_show();
    } else {
        saver_hide();
    }
    bsp_display_unlock();
}

static void style_tab_bar(lv_obj_t *tabview)
{
    lv_obj_t *bar = lv_tabview_get_tab_bar(tabview);
    lv_obj_set_style_bg_color(bar, COLOR_BG, 0);
    lv_obj_set_style_border_width(bar, 0, 0);
    lv_obj_set_style_pad_hor(bar, 12, 0);

    const uint32_t count = lv_obj_get_child_count(bar);
    for (uint32_t i = 0; i < count; i++) {
        lv_obj_t *btn = lv_obj_get_child(bar, i);
        lv_obj_set_style_bg_opa(btn, LV_OPA_TRANSP, 0);
        lv_obj_set_style_text_color(btn, COLOR_TEXT_DIM, 0);
        lv_obj_set_style_text_font(btn, &lv_font_montserrat_24, 0);
        lv_obj_set_style_text_color(btn, COLOR_ACCENT, LV_STATE_CHECKED);
        lv_obj_set_style_border_color(btn, COLOR_ACCENT, LV_STATE_CHECKED);
        lv_obj_set_style_border_side(btn, LV_BORDER_SIDE_BOTTOM, LV_STATE_CHECKED);
        lv_obj_set_style_border_width(btn, 3, LV_STATE_CHECKED);
    }
}

/* ---- Settings screen (Wi-Fi) -------------------------------------------- */

static void on_settings_open(lv_event_t *e)
{
    (void)e;
    if (s_settings) {
        render_net_details(); /* show current diagnostics immediately */
        lv_obj_remove_flag(s_settings, LV_OBJ_FLAG_HIDDEN);
        lv_obj_move_foreground(s_settings);
    }
}

static void on_settings_close(lv_event_t *e)
{
    (void)e;
    if (s_kb) {
        lv_obj_add_flag(s_kb, LV_OBJ_FLAG_HIDDEN);
    }
    if (s_settings) {
        lv_obj_add_flag(s_settings, LV_OBJ_FLAG_HIDDEN);
    }
}

static void on_ta_event(lv_event_t *e)
{
    if (s_kb == NULL) {
        return;
    }
    const lv_event_code_t code = lv_event_get_code(e);
    if (code == LV_EVENT_FOCUSED) {
        lv_keyboard_set_textarea(s_kb, lv_event_get_target(e));
        lv_obj_remove_flag(s_kb, LV_OBJ_FLAG_HIDDEN);
        lv_obj_move_foreground(s_kb);
    } else if (code == LV_EVENT_DEFOCUSED) {
        lv_obj_add_flag(s_kb, LV_OBJ_FLAG_HIDDEN);
    }
}

static void on_kb_done(lv_event_t *e)
{
    (void)e;
    if (s_kb) {
        lv_obj_add_flag(s_kb, LV_OBJ_FLAG_HIDDEN);
    }
}

/* --- Scanned-network picker (list mode <-> password mode) --- */

static void on_wifi_connect(lv_event_t *e)
{
    (void)e;
    const char *pass = lv_textarea_get_text(s_pass_ta);
    if (s_wifi_cb && strlen(s_wifi_sel_ssid) > 0) {
        s_wifi_cb(s_wifi_sel_ssid, pass);
        lv_label_set_text_fmt(s_wifi_sel_lbl, "Verbinden met %s...", s_wifi_sel_ssid);
        lv_obj_set_style_text_color(s_wifi_sel_lbl, COLOR_TEXT_DIM, 0);
    }
    if (s_kb) {
        lv_obj_add_flag(s_kb, LV_OBJ_FLAG_HIDDEN);
    }
    if (s_wifi_list) {
        lv_obj_add_flag(s_wifi_list, LV_OBJ_FLAG_HIDDEN);
    }
}

static void on_wifi_list_close(lv_event_t *e)
{
    (void)e;
    if (s_kb) {
        lv_obj_add_flag(s_kb, LV_OBJ_FLAG_HIDDEN);
    }
    if (s_wifi_list) {
        lv_obj_add_flag(s_wifi_list, LV_OBJ_FLAG_HIDDEN);
    }
}

static void on_wifi_net_clicked(lv_event_t *e)
{
    int idx = (int)(intptr_t)lv_event_get_user_data(e);
    if (idx < 0 || idx >= s_net_count) {
        return;
    }
    strlcpy(s_wifi_sel_ssid, s_net_ssids[idx], sizeof(s_wifi_sel_ssid));
    /* Switch the picker from the list to the password prompt. */
    lv_obj_add_flag(s_wifi_list_box, LV_OBJ_FLAG_HIDDEN);
    lv_obj_remove_flag(s_wifi_pw, LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text_fmt(s_wifi_pw_title, "Wachtwoord voor %s", s_wifi_sel_ssid);
    lv_textarea_set_text(s_pass_ta, "");
    if (s_kb) {
        lv_keyboard_set_textarea(s_kb, s_pass_ta);
        lv_obj_remove_flag(s_kb, LV_OBJ_FLAG_HIDDEN);
        lv_obj_move_foreground(s_kb);
    }
}

static void on_wifi_select_open(lv_event_t *e)
{
    (void)e;
    if (s_wifi_list == NULL) {
        return;
    }
    /* Reset to list mode: hide the password panel + keyboard, show a placeholder. */
    lv_obj_add_flag(s_wifi_pw, LV_OBJ_FLAG_HIDDEN);
    if (s_kb) {
        lv_obj_add_flag(s_kb, LV_OBJ_FLAG_HIDDEN);
    }
    lv_obj_remove_flag(s_wifi_list_box, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clean(s_wifi_list_box);
    lv_obj_t *l = lv_label_create(s_wifi_list_box);
    lv_label_set_text(l, "Scannen...");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_18, 0);
    lv_obj_set_style_text_color(l, COLOR_TEXT_DIM, 0);
    lv_obj_remove_flag(s_wifi_list, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(s_wifi_list);
    if (s_scan_cb) {
        s_scan_cb();
    }
}

/* ---- Themes ------------------------------------------------------------- */
static void theme_load(void)
{
    uint8_t idx = 0;
    nvs_handle_t h;
    if (nvs_open("panel", NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "theme", &idx);
        nvs_close(h);
    }
    if (idx >= PANEL_THEME_COUNT) {
        idx = 0;
    }
    s_theme_idx = idx;
    s_theme = &PANEL_THEMES[idx];
    ESP_LOGI(TAG, "theme: %s", s_theme->name);
}

static void theme_restart_cb(lv_timer_t *t)
{
    (void)t;
    esp_restart();
}

/* Save the choice and restart: every object was styled at creation with the
 * old palette, and a clean start (about three seconds) is the honest way to
 * apply a new one everywhere at once. */
static void theme_apply_and_restart(int idx)
{
    if (idx < 0 || idx >= (int)PANEL_THEME_COUNT || idx == s_theme_idx) {
        return;
    }
    nvs_handle_t h;
    if (nvs_open("panel", NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_u8(h, "theme", (uint8_t)idx);
        nvs_commit(h);
        nvs_close(h);
    }
    ESP_LOGI(TAG, "theme -> %s, restarting", PANEL_THEMES[idx].name);
    if (s_theme_lbl) {
        lv_label_set_text_fmt(s_theme_lbl, "%s wordt toegepast...", PANEL_THEMES[idx].name);
    }
    lv_timer_t *t = lv_timer_create(theme_restart_cb, 600, NULL);
    lv_timer_set_repeat_count(t, 1);
}

static void on_theme_dd_changed(lv_event_t *e)
{
    theme_apply_and_restart((int)lv_dropdown_get_selected(lv_event_get_target(e)));
}

void panel_ui_get_screen_state(int *screen_off, int *timeout_s, int *idle_s)
{
    /* Plain reads; no LVGL mutation, so no lock needed. */
    *screen_off = (s_saver && !lv_obj_has_flag(s_saver, LV_OBJ_FLAG_HIDDEN)) ? 1 : 0;
    *timeout_s = (int)(s_saver_timeout_ms / 1000);
    *idle_s = (int)(lv_display_get_inactive_time(NULL) / 1000);
}

void panel_ui_set_theme(int idx)
{
    if (!bsp_display_lock(1000)) {
        return;
    }
    theme_apply_and_restart(idx);
    bsp_display_unlock();
}

static void saver_apply_and_save(int idx)
{
    const int n = sizeof(SAVER_OPTS_MS) / sizeof(SAVER_OPTS_MS[0]);
    if (idx < 0 || idx >= n) {
        return;
    }
    s_saver_timeout_ms = SAVER_OPTS_MS[idx];
    nvs_handle_t h;
    if (nvs_open("panel", NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_u8(h, "saver_idx", (uint8_t)idx);
        nvs_commit(h);
        nvs_close(h);
    }
}

static void on_saver_dd_changed(lv_event_t *e)
{
    saver_apply_and_save(lv_dropdown_get_selected(lv_event_get_target(e)));
}

static void on_saver_mode_changed(lv_event_t *e)
{
    const int mode = (int)lv_dropdown_get_selected(lv_event_get_target(e));
    s_saver_mode = mode == SAVER_MODE_EYE ? SAVER_MODE_EYE : SAVER_MODE_OFF;
    nvs_handle_t h;
    if (nvs_open("panel", NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_u8(h, "saver_mode", (uint8_t)s_saver_mode);
        nvs_commit(h);
        nvs_close(h);
    }
}

/* Load the saved screensaver-timeout index, apply it, and return it. */
static int saver_load_idx(void)
{
    const int n = sizeof(SAVER_OPTS_MS) / sizeof(SAVER_OPTS_MS[0]);
    uint8_t idx = 1; /* default: 5 min */
    uint8_t mode = SAVER_MODE_EYE;
    nvs_handle_t h;
    if (nvs_open("panel", NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "saver_idx", &idx);
        nvs_get_u8(h, "saver_mode", &mode);
        nvs_close(h);
    }
    s_saver_mode = mode == SAVER_MODE_EYE ? SAVER_MODE_EYE : SAVER_MODE_OFF;
    if (idx >= n) {
        idx = 1;
    }
    s_saver_timeout_ms = SAVER_OPTS_MS[idx];
    return idx;
}

static lv_obj_t *settings_label(lv_obj_t *parent, const char *txt,
                                const lv_font_t *font, lv_color_t color)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_label_set_text(l, txt);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, color, 0);
    return l;
}

/* A settings list row: title on the left, a growing spacer, and whatever
 * value/control the caller appends afterwards pushed to the right. */
static lv_obj_t *settings_row(lv_obj_t *parent, const char *title)
{
    lv_obj_t *row = lv_obj_create(parent);
    lv_obj_set_size(row, LV_PCT(100), LV_SIZE_CONTENT);
    make_plain(row);
    lv_obj_set_style_pad_ver(row, 12, 0);
    lv_obj_set_style_border_color(row, COLOR_TILE, 0);
    lv_obj_set_style_border_width(row, 1, 0);
    lv_obj_set_style_border_side(row, LV_BORDER_SIDE_BOTTOM, 0);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    settings_label(row, title, &lv_font_montserrat_24, COLOR_TEXT);
    lv_obj_t *sp = lv_obj_create(row);
    make_plain(sp);
    lv_obj_set_height(sp, 1);
    lv_obj_set_flex_grow(sp, 1);
    return row;
}

static void create_settings(lv_obj_t *root)
{
    s_settings = lv_obj_create(root);
    lv_obj_set_size(s_settings, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_color(s_settings, COLOR_BG, 0);
    lv_obj_set_style_bg_opa(s_settings, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(s_settings, 0, 0);
    lv_obj_set_style_radius(s_settings, 0, 0);
    lv_obj_set_style_pad_all(s_settings, 24, 0);
    lv_obj_set_style_pad_bottom(s_settings, 8, 0);
    lv_obj_set_style_pad_gap(s_settings, 6, 0);
    lv_obj_set_flex_flow(s_settings, LV_FLEX_FLOW_COLUMN);
    lv_obj_clear_flag(s_settings, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(s_settings, LV_OBJ_FLAG_HIDDEN);

    lv_obj_t *hdr = lv_obj_create(s_settings);
    lv_obj_set_size(hdr, LV_PCT(100), LV_SIZE_CONTENT);
    make_plain(hdr);
    lv_obj_set_flex_flow(hdr, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(hdr, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_flex_grow(settings_label(hdr, "Instellingen", &lv_font_montserrat_32, COLOR_TEXT), 1);
    lv_obj_t *close = lv_button_create(hdr);
    lv_obj_set_size(close, 52, 52);
    lv_obj_set_style_bg_color(close, COLOR_TILE, 0);
    lv_obj_set_style_radius(close, 12, 0);
    lv_obj_set_style_shadow_width(close, 0, 0);
    lv_obj_add_event_cb(close, on_settings_close, LV_EVENT_CLICKED, NULL);
    lv_obj_center(settings_label(close, LV_SYMBOL_CLOSE, &lv_font_montserrat_24, COLOR_TEXT));

    /* Rows live in a vertically scrollable body under the fixed header. */
    lv_obj_t *body = lv_obj_create(s_settings);
    lv_obj_set_width(body, LV_PCT(100));
    lv_obj_set_flex_grow(body, 1);
    make_plain(body);
    lv_obj_set_flex_flow(body, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scroll_dir(body, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(body, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_add_flag(body, LV_OBJ_FLAG_SCROLLABLE);

    /* --- Wi-Fi row: title left, SSID/status + connect button right. --- */
    lv_obj_t *wr = settings_row(body, LV_SYMBOL_WIFI "  Wi-Fi");
    s_wifi_sel_lbl = settings_label(wr, "Niet verbonden", &lv_font_montserrat_24, COLOR_TEXT_DIM);
    lv_obj_set_style_margin_right(s_wifi_sel_lbl, 16, 0);
    lv_obj_t *wbtn = lv_button_create(wr);
    lv_obj_set_style_bg_color(wbtn, COLOR_TILE_ON, 0);
    lv_obj_set_style_radius(wbtn, 12, 0);
    lv_obj_set_style_shadow_width(wbtn, 0, 0);
    lv_obj_add_event_cb(wbtn, on_wifi_select_open, LV_EVENT_CLICKED, NULL);
    s_wifi_btn_lbl = settings_label(wbtn, "Verbinden", &lv_font_montserrat_24, COLOR_ON_TEXT);
    lv_obj_center(s_wifi_btn_lbl);

    /* --- Screensaver row: title left, timeout dropdown right. --- */
    lv_obj_t *sr = settings_row(body, LV_SYMBOL_EYE_OPEN "  Screensaver na");
    s_saver_dd = lv_dropdown_create(sr);
    lv_dropdown_set_options(s_saver_dd, SAVER_OPTS_STR);
    lv_obj_set_width(s_saver_dd, 170);
    lv_dropdown_set_selected(s_saver_dd, saver_load_idx());
    lv_obj_add_event_cb(s_saver_dd, on_saver_dd_changed, LV_EVENT_VALUE_CHANGED, NULL);

    /* --- Screensaver mode: backlight off, or the AI eye animation. --- */
    lv_obj_t *mr = settings_row(body, LV_SYMBOL_PLAY "  Screensaver");
    s_saver_mode_dd = lv_dropdown_create(mr);
    lv_dropdown_set_options(s_saver_mode_dd, "Scherm uit\nAI oog");
    lv_obj_set_width(s_saver_mode_dd, 170);
    lv_dropdown_set_selected(s_saver_mode_dd, (uint32_t)s_saver_mode);
    lv_obj_add_event_cb(s_saver_mode_dd, on_saver_mode_changed, LV_EVENT_VALUE_CHANGED, NULL);

    /* --- Theme row: dropdown with every palette; applies with a restart. --- */
    lv_obj_t *tr = settings_row(body, LV_SYMBOL_IMAGE "  Thema");
    s_theme_lbl = settings_label(tr, "", &lv_font_montserrat_18, COLOR_TEXT_DIM);
    lv_obj_set_style_margin_right(s_theme_lbl, 12, 0);
    s_theme_dd = lv_dropdown_create(tr);
    {
        char opts[128] = "";
        for (int i = 0; i < (int)PANEL_THEME_COUNT; i++) {
            strlcat(opts, PANEL_THEMES[i].name, sizeof(opts));
            if (i + 1 < (int)PANEL_THEME_COUNT) {
                strlcat(opts, "\n", sizeof(opts));
            }
        }
        lv_dropdown_set_options(s_theme_dd, opts);
    }
    lv_obj_set_width(s_theme_dd, 170);
    lv_dropdown_set_selected(s_theme_dd, (uint32_t)s_theme_idx);
    lv_obj_add_event_cb(s_theme_dd, on_theme_dd_changed, LV_EVENT_VALUE_CHANGED, NULL);

    /* --- Diagnostics: connection + firmware (updated by panel_ui_set_net_details). --- */
    lv_obj_t *nr = settings_row(body, LV_SYMBOL_LOOP "  Verbinding");
    s_net_lbl = settings_label(nr, "--", &lv_font_montserrat_18, COLOR_TEXT_DIM);
    lv_obj_t *fr = settings_row(body, LV_SYMBOL_DRIVE "  Firmware");
    s_fw_lbl = settings_label(fr, "--", &lv_font_montserrat_18, COLOR_TEXT_DIM);

    /* Network picker: a modal on the top layer, above the settings screen. */
    s_wifi_list = lv_obj_create(lv_layer_top());
    lv_obj_set_size(s_wifi_list, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_color(s_wifi_list, COLOR_BG, 0);
    lv_obj_set_style_bg_opa(s_wifi_list, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(s_wifi_list, 0, 0);
    lv_obj_set_style_radius(s_wifi_list, 0, 0);
    lv_obj_set_style_pad_all(s_wifi_list, 24, 0);
    lv_obj_set_style_pad_gap(s_wifi_list, 10, 0);
    lv_obj_set_flex_flow(s_wifi_list, LV_FLEX_FLOW_COLUMN);
    lv_obj_clear_flag(s_wifi_list, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(s_wifi_list, LV_OBJ_FLAG_HIDDEN);

    lv_obj_t *lhdr = lv_obj_create(s_wifi_list);
    lv_obj_set_size(lhdr, LV_PCT(100), LV_SIZE_CONTENT);
    make_plain(lhdr);
    lv_obj_set_flex_flow(lhdr, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(lhdr, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_flex_grow(settings_label(lhdr, "Kies netwerk", &lv_font_montserrat_32, COLOR_TEXT), 1);
    lv_obj_t *lclose = lv_button_create(lhdr);
    lv_obj_set_size(lclose, 52, 52);
    lv_obj_set_style_bg_color(lclose, COLOR_TILE, 0);
    lv_obj_set_style_radius(lclose, 12, 0);
    lv_obj_set_style_shadow_width(lclose, 0, 0);
    lv_obj_add_event_cb(lclose, on_wifi_list_close, LV_EVENT_CLICKED, NULL);
    lv_obj_center(settings_label(lclose, LV_SYMBOL_CLOSE, &lv_font_montserrat_24, COLOR_TEXT));

    s_wifi_list_box = lv_obj_create(s_wifi_list);
    lv_obj_set_size(s_wifi_list_box, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_flex_grow(s_wifi_list_box, 1);
    make_plain(s_wifi_list_box);
    lv_obj_set_flex_flow(s_wifi_list_box, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_gap(s_wifi_list_box, 8, 0);
    lv_obj_add_flag(s_wifi_list_box, LV_OBJ_FLAG_SCROLLABLE);

    /* Password-entry panel (shown after a network is picked). */
    s_wifi_pw = lv_obj_create(s_wifi_list);
    lv_obj_set_size(s_wifi_pw, LV_PCT(100), LV_SIZE_CONTENT);
    make_plain(s_wifi_pw);
    lv_obj_set_flex_flow(s_wifi_pw, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_gap(s_wifi_pw, 12, 0);
    lv_obj_add_flag(s_wifi_pw, LV_OBJ_FLAG_HIDDEN);
    s_wifi_pw_title = settings_label(s_wifi_pw, "Wachtwoord", &lv_font_montserrat_24, COLOR_TEXT);
    s_pass_ta = lv_textarea_create(s_wifi_pw);
    lv_textarea_set_one_line(s_pass_ta, true);
    lv_textarea_set_password_mode(s_pass_ta, true);
    lv_obj_set_width(s_pass_ta, LV_PCT(80));
    lv_obj_add_event_cb(s_pass_ta, on_ta_event, LV_EVENT_ALL, NULL);
    lv_obj_t *pwbtn = lv_button_create(s_wifi_pw);
    lv_obj_set_style_bg_color(pwbtn, COLOR_TILE_ON, 0);
    lv_obj_set_style_radius(pwbtn, 12, 0);
    lv_obj_set_style_shadow_width(pwbtn, 0, 0);
    lv_obj_add_event_cb(pwbtn, on_wifi_connect, LV_EVENT_CLICKED, NULL);
    lv_obj_center(settings_label(pwbtn, "Verbinden", &lv_font_montserrat_24, COLOR_ON_TEXT));

    /* Keyboard lives in the picker so it overlays the password panel. */
    s_kb = lv_keyboard_create(s_wifi_list);
    lv_obj_add_flag(s_kb, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_event_cb(s_kb, on_kb_done, LV_EVENT_READY, NULL);
    lv_obj_add_event_cb(s_kb, on_kb_done, LV_EVENT_CANCEL, NULL);
}

void panel_ui_set_wifi_callback(panel_ui_wifi_cb_t cb, const char *current_ssid)
{
    s_wifi_cb = cb;
    if (current_ssid && strlen(current_ssid) > 0) {
        strlcpy(s_wifi_sel_ssid, current_ssid, sizeof(s_wifi_sel_ssid));
    }
}

void panel_ui_set_scan_callback(panel_ui_scan_cb_t cb)
{
    s_scan_cb = cb;
}

void panel_ui_set_color_callbacks(panel_ui_color_cb_t color_cb, panel_ui_warmth_cb_t warmth_cb)
{
    s_color_cb = color_cb;
    s_warmth_cb = warmth_cb;
}

void panel_ui_set_light_caps(const char *entity_id, int caps, int min_kelvin, int max_kelvin)
{
    /* Runs on the HA task; the LVGL thread reads these fields in the long-press
     * popup, so mutate under the display lock to keep s_tiles single-writer. */
    if (!bsp_display_lock(1000)) {
        return;
    }
    for (int i = 0; i < s_tile_count; i++) {
        if (strcmp(s_tiles[i].entity->entity_id, entity_id) == 0) {
            s_tiles[i].caps = caps;
            s_tiles[i].min_k = min_kelvin;
            s_tiles[i].max_k = max_kelvin;
        }
    }
    bsp_display_unlock();
}

void panel_ui_set_networks(const char *const *ssids, const int8_t *rssi, int count)
{
    if (s_wifi_list_box == NULL || !bsp_display_lock(500)) {
        return;
    }
    lv_obj_clean(s_wifi_list_box);
    s_net_count = 0;
    if (count <= 0) {
        lv_obj_t *l = lv_label_create(s_wifi_list_box);
        lv_label_set_text(l, "Geen netwerken gevonden");
        lv_obj_set_style_text_font(l, &lv_font_montserrat_18, 0);
        lv_obj_set_style_text_color(l, COLOR_TEXT_DIM, 0);
        bsp_display_unlock();
        return;
    }
    const int max = sizeof(s_net_ssids) / sizeof(s_net_ssids[0]);
    for (int i = 0; i < count && s_net_count < max; i++) {
        strlcpy(s_net_ssids[s_net_count], ssids[i], sizeof(s_net_ssids[0]));
        /* Lightweight row: transparent (no per-row fill/rounded-AA overdraw, so
         * the list scrolls fast); a divider line + a press highlight instead. */
        lv_obj_t *btn = lv_button_create(s_wifi_list_box);
        lv_obj_set_width(btn, LV_PCT(100));
        lv_obj_set_style_bg_opa(btn, LV_OPA_TRANSP, 0);
        lv_obj_set_style_bg_color(btn, COLOR_TILE, LV_STATE_PRESSED);
        lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, LV_STATE_PRESSED);
        lv_obj_set_style_radius(btn, 0, 0);
        lv_obj_set_style_shadow_width(btn, 0, 0);
        lv_obj_set_style_pad_ver(btn, 13, 0);
        lv_obj_set_style_border_color(btn, COLOR_TILE, 0);
        lv_obj_set_style_border_width(btn, 1, 0);
        lv_obj_set_style_border_side(btn, LV_BORDER_SIDE_BOTTOM, 0);
        lv_obj_set_flex_flow(btn, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(btn, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        lv_obj_add_event_cb(btn, on_wifi_net_clicked, LV_EVENT_CLICKED,
                            (void *)(intptr_t)s_net_count);
        /* Signal strength: full symbol for strong, dim for weak. */
        const bool strong = rssi && rssi[i] >= -67;
        lv_obj_t *ico = settings_label(btn, LV_SYMBOL_WIFI, &lv_font_montserrat_18,
                                       strong ? COLOR_TEXT : COLOR_TEXT_DIM);
        lv_obj_set_style_margin_right(ico, 12, 0);
        settings_label(btn, s_net_ssids[s_net_count], &lv_font_montserrat_18, COLOR_TEXT);
        s_net_count++;
    }
    bsp_display_unlock();
}

void panel_ui_set_wifi_connected(bool connected, const char *ssid)
{
    /* Generous timeout: the first full render can hold the LVGL lock > 500 ms. */
    if (s_wifi_sel_lbl == NULL || !bsp_display_lock(3000)) {
        return;
    }
    if (connected && ssid && strlen(ssid) > 0) {
        strlcpy(s_wifi_sel_ssid, ssid, sizeof(s_wifi_sel_ssid));
        lv_label_set_text(s_wifi_sel_lbl, ssid);
        lv_obj_set_style_text_color(s_wifi_sel_lbl, COLOR_OK, 0);
        if (s_wifi_btn_lbl) {
            lv_label_set_text(s_wifi_btn_lbl, "Wijzig");
        }
    } else if (!connected) {
        lv_label_set_text(s_wifi_sel_lbl, "Niet verbonden");
        lv_obj_set_style_text_color(s_wifi_sel_lbl, COLOR_TEXT_DIM, 0);
        if (s_wifi_btn_lbl) {
            lv_label_set_text(s_wifi_btn_lbl, "Verbinden");
        }
    }
    bsp_display_unlock();
}







/* ---- Cached-bitmap tab swipe -------------------------------------------- */
/* Invalidate one tab's cached bitmap (so its next snapshot is re-rendered).
 * Marking only the affected tab avoids re-rasterizing all four on every update. */
static void mark_snapshot_dirty(int tab)
{
    if (tab >= 0 && tab < (int)PANEL_TAB_COUNT) {
        s_snap_dirty[tab] = true;
        if (tab == s_drawer_warm_tab) {
            s_drawer_warm_dirty = true; /* the warm drawer for this tab is stale too */
        }
    }
}

/* Snapshot src into *slot, freeing the previous buffer only after the new one is
 * installed (order matters: a live image may still reference the old one). */
static void swap_snapshot(lv_draw_buf_t **slot, lv_obj_t *src)
{
    if (src == NULL) {
        return;
    }
    lv_draw_buf_t *ns = lv_snapshot_take(src, LV_COLOR_FORMAT_RGB565);
    if (ns != NULL) {
        lv_draw_buf_t *old = *slot;
        *slot = ns;
        if (old) {
            lv_draw_buf_destroy(old);
        }
    }
}

/* Pre-render the active tab's drawer into s_drawer_warm so opening is instant. */
static void refresh_drawer_warm(int tab)
{
    if (tab < 0 || tab >= (int)PANEL_TAB_COUNT) {
        return;
    }
    swap_snapshot(&s_drawer_warm, s_drawers[tab]);
    s_drawer_warm_tab = tab;
    s_drawer_warm_dirty = false;
}

/* Re-snapshot a tab's content to a bitmap (only if marked dirty). This is a
 * full render (~tens of ms) so it runs lazily off the swipe path. */
static void refresh_snapshot(int i)
{
    if (i < 0 || i >= (int)PANEL_TAB_COUNT || s_tab_content[i] == NULL) {
        return;
    }
    if (s_tab_snap[i] != NULL && !s_snap_dirty[i]) {
        return;
    }
    swap_snapshot(&s_tab_snap[i], s_tab_content[i]);
    s_snap_dirty[i] = false;
}

/* Keep off-screen/dirty snapshots warm while idle so a swipe can start instantly.
 * One snapshot per tick bounds the cost; skipped entirely while swiping. */
static void snap_timer_cb(lv_timer_t *t)
{
    (void)t;
    /* Never re-snapshot (which frees the old draw-buf) while a swipe overlay is
     * live: its two lv_images still point at s_tab_snap[from]/[to]. s_swiping
     * covers the release animation; s_slide_ov covers the whole gesture. */
    if (s_swiping || s_slide_ov || s_drawer_slide_img || s_tabview == NULL) {
        return;
    }
    const int active = (int)lv_tabview_get_tab_active(s_tabview);
    for (int i = 0; i < (int)PANEL_TAB_COUNT; i++) {
        if (i != active && (s_tab_snap[i] == NULL || s_snap_dirty[i])) {
            refresh_snapshot(i);
            return;
        }
    }
    if (s_tab_snap[active] == NULL || s_snap_dirty[active]) {
        refresh_snapshot(active);
        return;
    }
    /* Then keep the active tab's drawer bitmap warm (only while it's closed, so
     * snapshotting it is invisible and doesn't hitch the open drawer). */
    if ((s_drawer_warm == NULL || s_drawer_warm_tab != active || s_drawer_warm_dirty) &&
        s_drawers[active] && lv_obj_get_x(s_drawers[active]) >= LV_HOR_RES) {
        refresh_drawer_warm(active);
    }
}

static void slide_anim_x(void *var, int32_t v)
{
    lv_obj_set_x((lv_obj_t *)var, v);
}

static void slide_done_cb(lv_anim_t *a)
{
    (void)a;
    lv_tabview_set_active(s_tabview, s_slide_target, LV_ANIM_OFF);
    if (s_slide_ov) {
        lv_obj_delete(s_slide_ov); /* also deletes the two child images */
        s_slide_ov = NULL;
    }
    s_drag_from_img = NULL;
    s_drag_to_img = NULL;
    if (s_bright_slider) {
        lv_obj_remove_flag(s_bright_slider, LV_OBJ_FLAG_HIDDEN);
    }
    if (s_bright_label) {
        lv_obj_remove_flag(s_bright_label, LV_OBJ_FLAG_HIDDEN);
    }
    s_swiping = false;
}

/* Snap the drag to completion (commit) or back (cancel), then clean up. */
static void drag_end(bool commit)
{
    const int dir = s_drag_to > s_drag_from ? 1 : -1;
    const int W = LV_HOR_RES;
    s_slide_target = commit ? s_drag_to : s_drag_from;
    s_swiping = true;
    s_drag_on = false;

    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_duration(&a, 160);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
    lv_anim_set_exec_cb(&a, slide_anim_x);
    lv_anim_set_var(&a, s_drag_from_img);
    lv_anim_set_values(&a, lv_obj_get_x(s_drag_from_img), commit ? -dir * W : 0);
    lv_anim_start(&a);
    lv_anim_set_var(&a, s_drag_to_img);
    lv_anim_set_values(&a, lv_obj_get_x(s_drag_to_img), commit ? 0 : dir * W);
    lv_anim_set_completed_cb(&a, slide_done_cb);
    lv_anim_start(&a);
}

/* Build the drag overlay with the two cached bitmaps once a drag really starts. */
static bool drag_begin(int from, int to)
{
    refresh_snapshot(from);
    refresh_snapshot(to);
    if (s_tab_snap[from] == NULL || s_tab_snap[to] == NULL) {
        return false;
    }
    const int dir = to > from ? 1 : -1;
    const int W = LV_HOR_RES;
    const int y = CONTENT_Y;

    s_slide_ov = lv_obj_create(lv_screen_active());
    lv_obj_add_flag(s_slide_ov, LV_OBJ_FLAG_FLOATING);
    lv_obj_remove_flag(s_slide_ov, LV_OBJ_FLAG_SCROLLABLE);
    make_plain(s_slide_ov);
    lv_obj_set_style_bg_color(s_slide_ov, COLOR_BG, 0);
    lv_obj_set_style_bg_opa(s_slide_ov, LV_OPA_COVER, 0);
    lv_obj_set_pos(s_slide_ov, 0, y);
    lv_obj_set_size(s_slide_ov, W, LV_VER_RES - y);

    if (s_bright_slider) {
        lv_obj_add_flag(s_bright_slider, LV_OBJ_FLAG_HIDDEN);
    }
    if (s_bright_label) {
        lv_obj_add_flag(s_bright_label, LV_OBJ_FLAG_HIDDEN);
    }

    s_drag_from_img = lv_image_create(s_slide_ov);
    lv_image_set_src(s_drag_from_img, s_tab_snap[from]);
    lv_obj_set_pos(s_drag_from_img, 0, 0);
    s_drag_to_img = lv_image_create(s_slide_ov);
    lv_image_set_src(s_drag_to_img, s_tab_snap[to]);
    lv_obj_set_pos(s_drag_to_img, dir * W, 0);
    return true;
}

/* True while any modal overlay is up (settings/popup/network/screensaver/drawer). */
static bool overlays_open(void)
{
    lv_obj_t *ov[] = { s_settings, s_popup, s_wifi_list, s_saver };
    for (int i = 0; i < (int)(sizeof(ov) / sizeof(ov[0])); i++) {
        if (ov[i] && !lv_obj_has_flag(ov[i], LV_OBJ_FLAG_HIDDEN)) {
            return true;
        }
    }
    if (s_drawer_slide_img) {
        return true; /* a drawer is mid-slide */
    }
    for (int i = 0; i < (int)PANEL_TAB_COUNT; i++) {
        if (s_drawers[i] && lv_obj_get_x(s_drawers[i]) < LV_HOR_RES) {
            return true;
        }
    }
    return false;
}

/* Follow the finger: track horizontal movement over the tab content, slide the
 * two cached bitmaps live, and snap to the nearest tab on release. */
static void on_content_pressed(lv_event_t *e)
{
    (void)e;
    if (s_swiping || s_tabview == NULL) {
        return;
    }
    lv_indev_t *indev = lv_indev_active();
    if (!indev) {
        return;
    }
    lv_point_t p;
    lv_indev_get_point(indev, &p);
    /* A press during the release-debounce window is the finger coming back after
     * a momentary touch drop mid-drag (not a real lift): resume the same drag,
     * re-anchoring x0 so the images don't jump. */
    if (s_drag_release_pending && s_drag_on) {
        s_drag_release_pending = false;
        s_drag_press = true;
        s_drag_x0 = p.x - lv_obj_get_x(s_drag_from_img);
        return;
    }
    /* Only start tracking for touches that begin inside the tile area, clear of
     * the header/tab bar, the right-edge brightness slider, and any overlay. */
    if (p.y < CONTENT_Y || p.x > SLIDER_LANE_X - SLIDER_MARGIN || overlays_open()) {
        return;
    }
    s_drag_press = true;
    s_drag_on = false;
    s_drag_suppress_click = false;
    s_drag_release_pending = false;
    s_drag_x0 = p.x;
    s_drag_indev = indev;
    s_drag_from = (int)lv_tabview_get_tab_active(s_tabview);
}

/* Polls the touch point ~60Hz while a press is active (LVGL doesn't deliver
 * PRESSING at the indev level, so we can't get continuous move events there). */
static void do_drag_commit(void)
{
    const int dx = lv_obj_get_x(s_drag_from_img); /* last dragged position */
    const int dir = s_drag_to > s_drag_from ? 1 : -1;
    const bool far = (dx < 0 ? -dx : dx) > LV_HOR_RES / 5;
    const bool flick = s_drag_vel > 6 && (-dir * dx) > 24;
    drag_end(far || flick);
}

static void drag_poll_cb(lv_timer_t *t)
{
    (void)t;
    /* A release is pending. If the touch is actually still down (LVGL fired a
     * spurious RELEASED mid-drag), resume the drag. Only commit once the finger
     * has really been up for the whole debounce window. */
    if (s_drag_release_pending && !s_swiping) {
        if (s_drag_indev && lv_indev_get_state(s_drag_indev) == LV_INDEV_STATE_PRESSED) {
            lv_point_t p;
            lv_indev_get_point(s_drag_indev, &p);
            s_drag_release_pending = false;
            s_drag_press = true;
            s_drag_x0 = p.x - lv_obj_get_x(s_drag_from_img); /* re-anchor, no jump */
        } else if (lv_tick_elaps(s_drag_release_tick) >= DRAG_RELEASE_DEBOUNCE_MS) {
            s_drag_release_pending = false;
            do_drag_commit();
        }
        return;
    }
    if (!s_drag_press || s_swiping || s_drag_indev == NULL) {
        return;
    }
    lv_point_t p;
    lv_indev_get_point(s_drag_indev, &p);
    const int dx = p.x - s_drag_x0;
    if (!s_drag_on) {
        if (dx > -16 && dx < 16) {
            return; /* not yet a horizontal drag */
        }
        const int dir = dx < 0 ? 1 : -1;
        const int to = s_drag_from + dir;
        if (to < 0 || to >= (int)PANEL_TAB_COUNT || !drag_begin(s_drag_from, to)) {
            s_drag_press = false; /* at an edge or no snapshot: ignore */
            return;
        }
        s_drag_to = to;
        s_drag_on = true;
        s_drag_suppress_click = true; /* this touch is a drag, not a tap */
        s_drag_last_dx = dx;
        s_drag_vel = 0;
    }
    /* Peak per-tick speed toward the target (px/~16ms) for flick detection;
     * peak, not instantaneous, since a flick often decelerates before release. */
    const int dir = s_drag_to > s_drag_from ? 1 : -1;
    const int toward = -dir * (dx - s_drag_last_dx);
    if (toward > s_drag_vel) {
        s_drag_vel = toward;
    }
    s_drag_last_dx = dx;
    lv_obj_set_x(s_drag_from_img, dx);
    lv_obj_set_x(s_drag_to_img, dx + dir * LV_HOR_RES);
}

static void on_content_released(lv_event_t *e)
{
    (void)e;
    if (!s_drag_press) {
        return;
    }
    s_drag_press = false;
    if (!s_drag_on) {
        return; /* was a tap, not a drag */
    }
    /* Don't commit yet: a fast drag can briefly drop the touch, firing a
     * spurious RELEASED. Defer; drag_poll_cb commits after the debounce window
     * unless the finger comes back (handled in on_content_pressed). */
    s_drag_release_pending = true;
    s_drag_release_tick = lv_tick_get();
}






/* ---- Klimaat: 24 h chart + ventilation advice per sensor ----------------- */

/* Trend arrows in the header: compare with the reading an hour ago. */
static void climate_trend_timer(lv_timer_t *t)
{
    (void)t;
    const time_t now = time(NULL);
    if (!climate_time_valid(now)) {
        return;
    }
    for (int i = 0; i < (int)PANEL_TEMP_SENSOR_COUNT; i++) {
        if (s_sensor_name[i] == NULL) {
            continue;
        }
        const int16_t cur = climate_hist_latest(i, CLIMATE_KIND_TEMP, now, 0);
        const int16_t old = climate_hist_latest(i, CLIMATE_KIND_TEMP, now, 3600);
        const char *arrow = "";
        if (cur != CLIMATE_NONE && old != CLIMATE_NONE) {
            const int d = cur - old; /* tenths */
            arrow = d >= 3 ? " " LV_SYMBOL_UP : d <= -3 ? " " LV_SYMBOL_DOWN : "";
        }
        lv_label_set_text_fmt(s_sensor_name[i], "%s%s", PANEL_TEMP_SENSORS[i].label, arrow);
    }
}

static void on_climate_close(lv_event_t *e)
{
    (void)e;
    if (s_clim) {
        lv_obj_add_flag(s_clim, LV_OBJ_FLAG_HIDDEN);
    }
    s_clim_idx = -1;
}

static lv_obj_t *clim_label(lv_obj_t *parent, const lv_font_t *font, lv_color_t color)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_label_set_text(l, "");
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, color, 0);
    return l;
}

static void create_climate_popup(lv_obj_t *root)
{
    s_clim_t_arr = heap_caps_malloc(sizeof(int32_t) * CLIMATE_SLOTS, MALLOC_CAP_SPIRAM);
    s_clim_h_arr = heap_caps_malloc(sizeof(int32_t) * CLIMATE_SLOTS, MALLOC_CAP_SPIRAM);
    if (!s_clim_t_arr || !s_clim_h_arr) {
        return;
    }
    s_clim = lv_obj_create(root);
    lv_obj_set_size(s_clim, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_color(s_clim, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(s_clim, LV_OPA_60, 0);
    lv_obj_set_style_border_width(s_clim, 0, 0);
    lv_obj_set_style_radius(s_clim, 0, 0);
    lv_obj_clear_flag(s_clim, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(s_clim, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_event_cb(s_clim, on_climate_close, LV_EVENT_CLICKED, NULL);

    lv_obj_t *box = lv_obj_create(s_clim);
    lv_obj_set_size(box, 740, 440);
    lv_obj_center(box);
    lv_obj_set_style_bg_color(box, COLOR_TILE, 0);
    lv_obj_set_style_radius(box, 20, 0);
    lv_obj_set_style_border_width(box, 0, 0);
    lv_obj_set_style_pad_all(box, 20, 0);
    lv_obj_clear_flag(box, LV_OBJ_FLAG_SCROLLABLE);

    /* Title row: room name left, current readings right. */
    s_clim_title = clim_label(box, &lv_font_montserrat_24, COLOR_TEXT);
    lv_obj_align(s_clim_title, LV_ALIGN_TOP_LEFT, 0, 0);
    s_clim_now = clim_label(box, &lv_font_montserrat_24, COLOR_TEXT);
    lv_obj_align(s_clim_now, LV_ALIGN_TOP_RIGHT, 0, 0);

    /* Axis labels flank the chart: temperature left (accent), humidity right. */
    s_clim_ymax = clim_label(box, &lv_font_montserrat_14, COLOR_ACCENT);
    s_clim_ymin = clim_label(box, &lv_font_montserrat_14, COLOR_ACCENT);
    s_clim_hmax = clim_label(box, &lv_font_montserrat_14, COLOR_HUM);
    s_clim_hmin = clim_label(box, &lv_font_montserrat_14, COLOR_HUM);

    s_clim_chart = lv_chart_create(box);
    lv_obj_set_size(s_clim_chart, 600, 230);
    lv_obj_align(s_clim_chart, LV_ALIGN_TOP_MID, 0, 44);
    lv_chart_set_type(s_clim_chart, LV_CHART_TYPE_LINE);
    lv_chart_set_point_count(s_clim_chart, CLIMATE_SLOTS);
    lv_chart_set_update_mode(s_clim_chart, LV_CHART_UPDATE_MODE_SHIFT);
    lv_chart_set_div_line_count(s_clim_chart, 3, 5);
    lv_obj_set_style_bg_color(s_clim_chart, COLOR_TILE_OFF, 0);
    lv_obj_set_style_bg_opa(s_clim_chart, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(s_clim_chart, 0, 0);
    lv_obj_set_style_radius(s_clim_chart, 12, 0);
    lv_obj_set_style_pad_all(s_clim_chart, 8, 0);
    lv_obj_set_style_line_color(s_clim_chart, COLOR_GRID, 0);
    lv_obj_set_style_line_width(s_clim_chart, 1, 0);
    lv_obj_set_style_size(s_clim_chart, 0, 0, LV_PART_INDICATOR); /* no point dots */
    lv_obj_set_style_line_width(s_clim_chart, 3, LV_PART_ITEMS);
    lv_obj_clear_flag(s_clim_chart, LV_OBJ_FLAG_SCROLLABLE);
    s_clim_ser_h = lv_chart_add_series(s_clim_chart, COLOR_HUM, LV_CHART_AXIS_SECONDARY_Y);
    s_clim_ser_t = lv_chart_add_series(s_clim_chart, COLOR_ACCENT, LV_CHART_AXIS_PRIMARY_Y);
    lv_chart_set_ext_y_array(s_clim_chart, s_clim_ser_h, s_clim_h_arr);
    lv_chart_set_ext_y_array(s_clim_chart, s_clim_ser_t, s_clim_t_arr);

    /* Fixed-width axis labels in the 50 px margins beside the chart. */
    lv_obj_set_width(s_clim_ymax, 44);
    lv_obj_set_width(s_clim_ymin, 44);
    lv_obj_set_style_text_align(s_clim_ymax, LV_TEXT_ALIGN_RIGHT, 0);
    lv_obj_set_style_text_align(s_clim_ymin, LV_TEXT_ALIGN_RIGHT, 0);
    lv_obj_align_to(s_clim_ymax, s_clim_chart, LV_ALIGN_OUT_LEFT_TOP, -4, 2);
    lv_obj_align_to(s_clim_ymin, s_clim_chart, LV_ALIGN_OUT_LEFT_BOTTOM, -4, -2);
    lv_obj_align_to(s_clim_hmax, s_clim_chart, LV_ALIGN_OUT_RIGHT_TOP, 4, 2);
    lv_obj_align_to(s_clim_hmin, s_clim_chart, LV_ALIGN_OUT_RIGHT_BOTTOM, 4, -2);

    /* Time axis: 24 h ago .. now. */
    static const char *const marks[] = { "-24u", "-18u", "-12u", "-6u", "nu" }; /* chart x axis */
    for (int i = 0; i < 5; i++) {
        lv_obj_t *m = clim_label(box, &lv_font_montserrat_14, COLOR_TEXT_DIM);
        lv_label_set_text(m, marks[i]);
        lv_obj_align_to(m, s_clim_chart, LV_ALIGN_OUT_BOTTOM_LEFT, (600 - 30) * i / 4, 4);
    }

    s_clim_range = clim_label(box, &lv_font_montserrat_18, COLOR_TEXT_DIM);
    lv_obj_align(s_clim_range, LV_ALIGN_BOTTOM_LEFT, 0, -26);
    s_clim_advice = clim_label(box, &lv_font_montserrat_18, COLOR_TEXT);
    lv_label_set_long_mode(s_clim_advice, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s_clim_advice, 700);
    lv_obj_align(s_clim_advice, LV_ALIGN_BOTTOM_LEFT, 0, 0);

    lv_timer_create(climate_trend_timer, 60 * 1000, NULL);
}

/* Fill the popup for sensor idx from the history ring. Caller holds the lock. */
static void climate_popup_fill(int idx)
{
    const time_t now = time(NULL);
    int16_t t[CLIMATE_SLOTS], h[CLIMATE_SLOTS];
    const int nt = climate_hist_get(idx, CLIMATE_KIND_TEMP, now, t);
    const int nh = climate_hist_get(idx, CLIMATE_KIND_HUM, now, h);
    /* Sensors report on change only, so a quiet slot means "still the same":
     * carry the last value forward across gaps of up to two hours. */
    int16_t *series[2] = { t, h };
    for (int k = 0; k < 2; k++) {
        int16_t last = CLIMATE_NONE;
        int age = 0;
        for (int i = 0; i < CLIMATE_SLOTS; i++) {
            if (series[k][i] != CLIMATE_NONE) {
                last = series[k][i];
                age = 0;
            } else if (last != CLIMATE_NONE && ++age <= 24) {
                series[k][i] = last;
            }
        }
    }
    int tmin = 32767, tmax = -32768, hmin = 32767, hmax = -32768;
    for (int i = 0; i < CLIMATE_SLOTS; i++) {
        s_clim_t_arr[i] = t[i] == CLIMATE_NONE ? LV_CHART_POINT_NONE : t[i];
        s_clim_h_arr[i] = h[i] == CLIMATE_NONE ? LV_CHART_POINT_NONE : h[i];
        if (t[i] != CLIMATE_NONE) { tmin = LV_MIN(tmin, t[i]); tmax = LV_MAX(tmax, t[i]); }
        if (h[i] != CLIMATE_NONE) { hmin = LV_MIN(hmin, h[i]); hmax = LV_MAX(hmax, h[i]); }
    }
    /* Axis ranges: temperature padded to whole degrees with 1° margin,
     * humidity to whole tens with 10 % margin. */
    int ylo = nt ? (tmin / 10 - 1) * 10 : 150, yhi = nt ? (tmax / 10 + 2) * 10 : 300;
    if (yhi - ylo < 40) { yhi = ylo + 40; }
    int hlo = nh ? ((hmin / 100) - 1) * 100 : 300, hhi = nh ? ((hmax / 100) + 2) * 100 : 700;
    if (hlo < 0) { hlo = 0; }
    if (hhi > 1000) { hhi = 1000; }
    lv_chart_set_axis_range(s_clim_chart, LV_CHART_AXIS_PRIMARY_Y, ylo, yhi);
    lv_chart_set_axis_range(s_clim_chart, LV_CHART_AXIS_SECONDARY_Y, hlo, hhi);
    lv_chart_refresh(s_clim_chart);
    lv_label_set_text_fmt(s_clim_ymax, "%d\xC2\xB0", yhi / 10);
    lv_label_set_text_fmt(s_clim_ymin, "%d\xC2\xB0", ylo / 10);
    lv_label_set_text_fmt(s_clim_hmax, "%d%%", hhi / 10);
    lv_label_set_text_fmt(s_clim_hmin, "%d%%", hlo / 10);

    const panel_sensor_t *sn = &PANEL_TEMP_SENSORS[idx];
    lv_label_set_text_fmt(s_clim_title, "%s  \xE2\x80\xA2  laatste 24 uur", sn->label);
    if (!isnan(s_temp_now[idx]) && !isnan(s_hum_now[idx])) {
        lv_label_set_text_fmt(s_clim_now, "%.1f\xC2\xB0   " LV_SYMBOL_TINT " %.0f%%",
                              (double)s_temp_now[idx], (double)s_hum_now[idx]);
    } else if (!isnan(s_temp_now[idx])) {
        lv_label_set_text_fmt(s_clim_now, "%.1f\xC2\xB0", (double)s_temp_now[idx]);
    } else {
        lv_label_set_text(s_clim_now, "--");
    }
    if (nt && nh) {
        lv_label_set_text_fmt(s_clim_range, "Min %.1f\xC2\xB0  Max %.1f\xC2\xB0      "
                              LV_SYMBOL_TINT " %d%% - %d%%", tmin / 10.0, tmax / 10.0,
                              hmin / 10, hmax / 10);
    } else if (nt) {
        lv_label_set_text_fmt(s_clim_range, "Min %.1f\xC2\xB0  Max %.1f\xC2\xB0", tmin / 10.0,
                              tmax / 10.0);
    } else {
        lv_label_set_text(s_clim_range, "Nog geen geschiedenis (wordt opgehaald)");
    }

    /* Ventilation advice: compare absolute humidity with the outdoor sensor. */
    int out = -1;
    for (int i = 0; i < (int)PANEL_TEMP_SENSOR_COUNT; i++) {
        if (!PANEL_TEMP_SENSORS[i].indoor) {
            out = i;
            break;
        }
    }
    if (!sn->indoor) {
        if (!isnan(s_temp_now[idx]) && !isnan(s_hum_now[idx])) {
            lv_label_set_text_fmt(s_clim_advice, "Buitenlucht bevat %.1f g/m3 vocht",
                                  (double)climate_abs_humidity(s_temp_now[idx], s_hum_now[idx]));
        } else {
            lv_label_set_text(s_clim_advice, "");
        }
        lv_obj_set_style_text_color(s_clim_advice, COLOR_TEXT_DIM, 0);
    } else if (out >= 0 && !isnan(s_temp_now[idx]) && !isnan(s_hum_now[idx]) &&
               !isnan(s_temp_now[out]) && !isnan(s_hum_now[out])) {
        const float ah_in = climate_abs_humidity(s_temp_now[idx], s_hum_now[idx]);
        const float ah_out = climate_abs_humidity(s_temp_now[out], s_hum_now[out]);
        const float d = ah_in - ah_out;
        if (s_hum_now[idx] <= COMFORT_HUM_MAX && s_hum_now[idx] >= COMFORT_HUM_MIN && d < 1.0f) {
            lv_label_set_text_fmt(s_clim_advice, "Vochtigheid is goed (%.1f g/m3 binnen, "
                                  "%.1f buiten)", (double)ah_in, (double)ah_out);
            lv_obj_set_style_text_color(s_clim_advice, COLOR_OK, 0);
        } else if (d >= 1.0f) {
            lv_label_set_text_fmt(s_clim_advice, LV_SYMBOL_OK " Ventileren helpt: buitenlucht is "
                                  "droger (%.1f vs %.1f g/m3)", (double)ah_out, (double)ah_in);
            lv_obj_set_style_text_color(s_clim_advice, COLOR_OK, 0);
        } else if (d <= -1.0f) {
            lv_label_set_text_fmt(s_clim_advice, LV_SYMBOL_WARNING " Niet ventileren: buitenlucht is "
                                  "vochtiger (%.1f vs %.1f g/m3)", (double)ah_out, (double)ah_in);
            lv_obj_set_style_text_color(s_clim_advice, COLOR_WARN, 0);
        } else {
            lv_label_set_text(s_clim_advice, "Ventileren maakt nu weinig verschil");
            lv_obj_set_style_text_color(s_clim_advice, COLOR_TEXT_DIM, 0);
        }
    } else {
        lv_label_set_text(s_clim_advice, "");
    }
}

static void open_climate_popup(int idx)
{
    if (s_clim == NULL || idx < 0 || idx >= (int)PANEL_TEMP_SENSOR_COUNT) {
        return;
    }
    s_clim_idx = idx;
    climate_popup_fill(idx);
    lv_obj_remove_flag(s_clim, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(s_clim);
}

void panel_ui_debug_climate(int idx)
{
    if (!bsp_display_lock(1000)) {
        return;
    }
    if (idx < 0) {
        on_climate_close(NULL);
    } else {
        open_climate_popup(idx);
    }
    bsp_display_unlock();
}

/* ---- Remote verification: drive the UI + capture the composited screen -- */
void panel_ui_debug_select(int tab, int drawer_open, int settings_open)
{
    if (s_tabview == NULL || !bsp_display_lock(1000)) {
        return;
    }
    if (tab >= 0 && tab < (int)PANEL_TAB_COUNT &&
        (int)lv_tabview_get_tab_active(s_tabview) != tab) {
        if (s_drawer_open) { /* drawers are per tab: close before switching */
            on_show_all_clicked(NULL);
        }
        lv_tabview_set_active(s_tabview, (uint32_t)tab, LV_ANIM_OFF);
    }
    if (drawer_open >= 0 && (drawer_open != 0) != s_drawer_open) {
        on_show_all_clicked(NULL);
    }
    if (settings_open >= 0 && s_settings) {
        if (settings_open) {
            render_net_details();
            lv_obj_remove_flag(s_settings, LV_OBJ_FLAG_HIDDEN);
            lv_obj_move_foreground(s_settings);
        } else {
            lv_obj_add_flag(s_settings, LV_OBJ_FLAG_HIDDEN);
        }
    }
    bsp_display_unlock();
}

/* True if any direct child of the layer is visible (cheap overlay test). */
static bool layer_has_visible(lv_obj_t *layer)
{
    const uint32_t n = lv_obj_get_child_count(layer);
    for (uint32_t i = 0; i < n; i++) {
        if (!lv_obj_has_flag(lv_obj_get_child(layer, i), LV_OBJ_FLAG_HIDDEN)) {
            return true;
        }
    }
    return false;
}

lv_draw_buf_t *panel_ui_capture(void)
{
    if (!bsp_display_lock(2000)) {
        return NULL;
    }
    lv_draw_buf_t *snap = lv_snapshot_take(lv_screen_active(), LV_COLOR_FORMAT_RGB565);
    lv_draw_buf_t *top = NULL;
    if (snap && layer_has_visible(lv_layer_top())) {
        top = lv_snapshot_take(lv_layer_top(), LV_COLOR_FORMAT_ARGB8888);
    }
    bsp_display_unlock();
    if (snap == NULL) {
        ESP_LOGW(TAG, "screen snapshot failed");
        return NULL;
    }
    if (top == NULL) {
        return snap;
    }
    /* Alpha-blend the overlay (BGRA bytes) onto the RGB565 screen. */
    const int w = LV_MIN(snap->header.w, top->header.w);
    const int h = LV_MIN(snap->header.h, top->header.h);
    for (int y = 0; y < h; y++) {
        uint16_t *dst = (uint16_t *)(snap->data + y * snap->header.stride);
        const uint8_t *src = top->data + y * top->header.stride;
        for (int x = 0; x < w; x++, src += 4) {
            const int a = src[3];
            if (a == 0) {
                continue;
            }
            int r = src[2], g = src[1], b = src[0];
            if (a < 255) {
                const uint16_t d = dst[x];
                const int dr = ((d >> 11) & 0x1f) << 3, dg = ((d >> 5) & 0x3f) << 2,
                          db = (d & 0x1f) << 3;
                r = (r * a + dr * (255 - a)) / 255;
                g = (g * a + dg * (255 - a)) / 255;
                b = (b * a + db * (255 - a)) / 255;
            }
            dst[x] = (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
        }
    }
    lv_draw_buf_destroy(top);
    return snap;
}

#ifdef PANEL_ENABLE_SCREEN_DUMP
/* ---- Screen dump (verification helper, build with -DPANEL_ENABLE_SCREEN_DUMP)
 * Snapshots the active screen, downsamples 2x, and streams it over the serial
 * console as base64 RGB565 so the host (tools/snapcap.py) can rebuild a PNG.
 * Call from a temporary trigger. */
void panel_ui_dump_screen(void)
{
    if (!bsp_display_lock(2000)) {
        return;
    }
    lv_draw_buf_t *snap = lv_snapshot_take(lv_screen_active(), LV_COLOR_FORMAT_RGB565);
    bsp_display_unlock();
    if (snap == NULL) {
        ESP_LOGW(TAG, "snapshot failed");
        return;
    }
    const int w = snap->header.w, h = snap->header.h;
    const int stride = snap->header.stride;
    const int w2 = w / 2, h2 = h / 2;
    uint8_t *small = heap_caps_malloc(w2 * h2 * 2, MALLOC_CAP_SPIRAM);
    if (small) {
        for (int y = 0; y < h2; y++) {
            const uint8_t *src = snap->data + (y * 2) * stride;
            uint16_t *dst = (uint16_t *)(small + y * w2 * 2);
            const uint16_t *s16 = (const uint16_t *)src;
            for (int x = 0; x < w2; x++) {
                dst[x] = s16[x * 2];
            }
        }
        const int raw = w2 * h2 * 2;
        size_t olen = 0;
        mbedtls_base64_encode(NULL, 0, &olen, small, raw);
        uint8_t *b64 = heap_caps_malloc(olen + 1, MALLOC_CAP_SPIRAM);
        if (b64 && mbedtls_base64_encode(b64, olen + 1, &olen, small, raw) == 0) {
            printf("\nSNAPBEGIN %d %d\n", w2, h2);
            for (size_t i = 0; i < olen; i += 100) {
                size_t n = (olen - i < 100) ? (olen - i) : 100;
                printf("SNAPDATA %.*s\n", (int)n, b64 + i);
            }
            printf("SNAPEND\n");
        }
        heap_caps_free(b64);
        heap_caps_free(small);
    }
    lv_draw_buf_destroy(snap);
}
#endif /* PANEL_ENABLE_SCREEN_DUMP */

void panel_ui_create(panel_ui_light_cb_t light_cb, panel_ui_scene_cb_t scene_cb,
                     panel_ui_brightness_cb_t brightness_cb)
{
    s_light_cb = light_cb;
    s_scene_cb = scene_cb;
    s_brightness_cb = brightness_cb;
    s_tile_count = 0;
    for (int t = 0; t < (int)PANEL_TAB_COUNT; t++) {
        s_tab_brightness[t] = -1;
        s_active_scene[t] = -1;
    }

    theme_load();        /* colours must be known before the first object is styled */
    init_slider_grads(); /* swatches + popup sliders share these gradient descriptors */

    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, COLOR_BG, 0);
    make_plain(screen);
    lv_obj_set_flex_flow(screen, LV_FLEX_FLOW_COLUMN);

    create_header(screen);

    s_tabview = lv_tabview_create(screen);
    lv_obj_set_size(s_tabview, LV_PCT(100), LV_VER_RES - HEADER_H);
    lv_tabview_set_tab_bar_position(s_tabview, LV_DIR_TOP);
    lv_tabview_set_tab_bar_size(s_tabview, TABBAR_H);
    lv_obj_set_style_bg_color(s_tabview, COLOR_BG, 0);
    lv_obj_add_event_cb(s_tabview, on_tab_changed, LV_EVENT_VALUE_CHANGED, NULL);

    for (int i = 0; i < (int)PANEL_TAB_COUNT; i++) {
        const panel_tab_t *tab_cfg = &PANEL_TABS[i];
        lv_obj_t *tab = lv_tabview_add_tab(s_tabview, tab_cfg->name);
        s_tab_content[i] = tab;
        lv_obj_set_style_bg_color(tab, COLOR_BG, 0);
        make_plain(tab);
        lv_obj_set_flex_flow(tab, LV_FLEX_FLOW_COLUMN);

        create_light_grid(tab, tab_cfg, i);
        create_scene_row(tab, tab_cfg, i);
    }
    style_tab_bar(s_tabview);

    /* Take over swiping: disable the tabview's live finger-scroll (which
     * re-rasterizes every frame) and finger-drag cached bitmaps instead.
     * Instant programmatic scroll so tab-bar button clicks don't slow-scroll. */
    lv_obj_t *tv_content = lv_tabview_get_content(s_tabview);
    lv_obj_clear_flag(tv_content, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_anim_duration(tv_content, 0, 0);
    /* Track touches at the input-device level so a drag works no matter which
     * tile the finger lands on (object events wouldn't bubble up reliably). */
    lv_indev_t *touch = lv_indev_get_next(NULL);
    if (touch) {
        lv_indev_add_event_cb(touch, on_content_pressed, LV_EVENT_PRESSED, NULL);
        lv_indev_add_event_cb(touch, on_content_released, LV_EVENT_RELEASED, NULL);
    }
    lv_timer_create(drag_poll_cb, 16, NULL); /* ~60Hz finger tracking during a drag */
    lv_timer_create(snap_timer_cb, 900, NULL);

    /* Slider sits above the tabview (draggable); drawers are created afterwards
     * so they render on top and cover it when open. */
    create_bright_slider(screen);
    for (int i = 0; i < (int)PANEL_TAB_COUNT; i++) {
        s_drawers[i] = create_drawer(&PANEL_TABS[i], i);
    }

    /* Splash first so the very first frame is the artwork, not a half-built UI. */
    create_splash(lv_layer_top());

    /* Overlays on the top layer so they cover everything, including drawers. */
    create_popup(lv_layer_top());
    create_climate_popup(lv_layer_top());
    create_settings(lv_layer_top());
    create_screensaver(lv_layer_top());

    /* The LVGL task feeds the task watchdog from this timer. A UI task that
     * blocks forever (I2C, a lock inversion) then panics within
     * CONFIG_ESP_TASK_WDT_TIMEOUT_S, writes a coredump and reboots instead of
     * leaving a frozen panel that still answers HTTP. */
    lv_timer_create(lvgl_wdt_feed, 500, NULL);

    /* Drive the header clock/date (updates once SNTP has synced). */
    lv_timer_create(on_clock_timer, 1000, NULL);
    on_clock_timer(NULL);


    ESP_LOGI(TAG, "UI created (%d tabs, %d tiles)", (int)PANEL_TAB_COUNT, s_tile_count);
}

void panel_ui_set_light_state(const char *entity_id, const char *state)
{
    if (state == NULL) {
        return;
    }
    const bool on = strcmp(state, "on") == 0;
    const bool unavailable = strcmp(state, "unavailable") == 0 ||
                             strcmp(state, "unknown") == 0 ||
                             strcmp(state, "none") == 0;
    const int cat = unavailable ? TILE_STATE_UNAVAIL : (on ? TILE_STATE_ON : TILE_STATE_OFF);

    bool locked = false;
    for (int i = 0; i < s_tile_count; i++) {
        light_tile_t *t = &s_tiles[i];
        if (strcmp(t->entity->entity_id, entity_id) != 0) {
            continue; /* same entity may appear on several tabs: keep looking */
        }
        if (t->last_render == cat) {
            continue; /* already showing this state: no re-style, no cache dirty */
        }
        if (!locked) { /* lock once for the whole update, not per tile */
            if (!bsp_display_lock(1000)) {
                ESP_LOGW(TAG, "LVGL lock timeout");
                return;
            }
            locked = true;
        }
        t->last_render = cat;
        if (unavailable) {
            /* Physically unreachable (e.g. wall switch off): dim the whole tile,
             * show a warning glyph and greyed text so it reads as disabled. */
            lv_obj_set_style_opa(t->tile, LV_OPA_50, 0);
            lv_obj_set_style_bg_color(t->tile, COLOR_TILE_OFF, 0);
            lv_label_set_text(t->icon, LV_SYMBOL_WARNING);
            lv_obj_set_style_text_color(t->icon, COLOR_TEXT_DIM, 0);
            if (t->name_label) {
                lv_obj_set_style_text_color(t->name_label, COLOR_TEXT_DIM, 0);
            }
            if (t->state_label) {
                lv_label_set_text(t->state_label, "niet beschikbaar");
                lv_obj_set_style_text_color(t->state_label, COLOR_TEXT_DIM, 0);
            }
        } else {
            lv_obj_set_style_opa(t->tile, LV_OPA_COVER, 0);
            lv_obj_set_style_bg_color(t->tile, on ? COLOR_TILE_ON : COLOR_TILE, 0);
            lv_label_set_text(t->icon, LV_SYMBOL_POWER);
            lv_obj_set_style_text_color(t->icon, on ? COLOR_ON_TEXT : COLOR_TEXT_DIM, 0);
            if (t->name_label) {
                lv_obj_set_style_text_color(t->name_label, on ? COLOR_ON_TEXT : COLOR_TEXT, 0);
            }
            if (t->state_label) {
                lv_label_set_text(t->state_label, on ? "aan" : "uit");
                lv_obj_set_style_text_color(t->state_label,
                                            on ? COLOR_ON_SUB : COLOR_TEXT_DIM, 0);
            }
        }
        mark_snapshot_dirty(t->tab_idx); /* only this tile's tab needs re-caching */
    }
    if (locked) {
        bsp_display_unlock();
    }
}

void panel_ui_set_scene_active(const char *entity_id)
{
    if (entity_id == NULL) {
        return;
    }
    for (int t = 0; t < (int)PANEL_TAB_COUNT; t++) {
        for (int i = 0; i < s_scene_counts[t]; i++) {
            if (strcmp(s_scene_ctx[t][i].scene->entity_id, entity_id) != 0) {
                continue;
            }
            if (!bsp_display_lock(1000)) {
                return;
            }
            scene_highlight(t, i);
            bsp_display_unlock();
            return;
        }
    }
}

void panel_ui_set_light_brightness(const char *entity_id, int brightness_pct)
{
    if (entity_id == NULL || brightness_pct < 0) {
        return;
    }
    /* Plain data update: no LVGL objects touched, so no lock needed. */
    for (int i = 0; i < s_tile_count; i++) {
        if (strcmp(s_tiles[i].entity->entity_id, entity_id) == 0) {
            s_tiles[i].brightness = brightness_pct;
        }
    }
}

/* Render the stored connection/firmware details into the settings rows.
 * Caller holds the LVGL lock. */
static void render_net_details(void)
{
    if (s_net_lbl == NULL || s_fw_lbl == NULL) {
        return;
    }
    const char *bullet = "  \xE2\x80\xA2  ";
    if (s_net_ip[0]) {
        const int r = s_net_rssi;
        const char *q = r >= -67 ? "goed" : r >= -75 ? "matig" : "zwak";
        lv_label_set_text_fmt(s_net_lbl, "%s%s%d dBm (%s)%sHA %s", s_net_ip, bullet, r, q,
                              bullet, s_net_ha_up ? "verbonden" : "niet verbonden");
        lv_obj_set_style_text_color(s_net_lbl, s_net_ha_up ? COLOR_OK : COLOR_WARN, 0);
    } else {
        lv_label_set_text(s_net_lbl, "Geen netwerk");
        lv_obj_set_style_text_color(s_net_lbl, COLOR_BAD, 0);
    }
    const esp_app_desc_t *d = esp_app_get_description();
    const esp_partition_t *run = esp_ota_get_running_partition();
    const uint32_t up = (uint32_t)(esp_timer_get_time() / 1000000ULL);
    lv_label_set_text_fmt(s_fw_lbl, "%s%s%s%s%lu:%02lu uur aan", d->version, bullet,
                          run ? run->label : "?", bullet,
                          (unsigned long)(up / 3600), (unsigned long)((up / 60) % 60));
}

void panel_ui_set_net_details(const char *ip, int rssi_dbm, bool ha_up)
{
    strlcpy(s_net_ip, ip ? ip : "", sizeof(s_net_ip));
    s_net_rssi = rssi_dbm;
    s_net_ha_up = ha_up;
    /* Only touch LVGL while the settings screen is actually visible. */
    if (s_settings == NULL || lv_obj_has_flag(s_settings, LV_OBJ_FLAG_HIDDEN) ||
        !bsp_display_lock(500)) {
        return;
    }
    render_net_details();
    bsp_display_unlock();
}

void panel_ui_set_area_brightness(const char *entity_id, int brightness_pct)
{
    if (entity_id == NULL || brightness_pct < 0 || s_tabview == NULL) {
        return;
    }
    /* Reflect only a tab's representative (first) light on the slider. */
    for (int t = 0; t < (int)PANEL_TAB_COUNT; t++) {
        if (PANEL_TABS[t].light_count == 0 ||
            strcmp(PANEL_TABS[t].lights[0].entity_id, entity_id) != 0) {
            continue;
        }
        s_tab_brightness[t] = brightness_pct;
        /* Don't fight the user: skip sync while dragging or just after a change. */
        if (s_slider_dragging ||
            (s_slider_release_tick && lv_tick_elaps(s_slider_release_tick) < 2500)) {
            return;
        }
        if (!bsp_display_lock(1000)) {
            return;
        }
        const uint32_t active = lv_tabview_get_tab_active(s_tabview);
        if ((int)active == t && s_bright_slider) {
            lv_slider_set_value(s_bright_slider, brightness_pct, LV_ANIM_OFF);
            if (s_bright_label) {
                lv_label_set_text_fmt(s_bright_label, "%d%%", brightness_pct);
            }
        }
        bsp_display_unlock();
        return;
    }
}

/* Show/tint a drawn sun+cloud pair for a weather condition string. */
static void apply_wx(lv_obj_t *sun, lv_obj_t *cloud, const char *condition)
{
    if (!sun || !cloud || !condition) {
        return;
    }
    bool show_sun = false, show_cloud = false;
    lv_color_t cc = COLOR_TEXT_DIM;
    if (strstr(condition, "partlycloudy")) {
        show_sun = true;
        show_cloud = true;
    } else if (strstr(condition, "sunny") || strstr(condition, "clear")) {
        show_sun = true;
    } else if (strstr(condition, "rain") || strstr(condition, "pour") ||
               strstr(condition, "lightning")) {
        show_cloud = true;
        cc = lv_color_hex(0x7fa8d0);
    } else if (strstr(condition, "snow")) {
        show_cloud = true;
        cc = lv_color_hex(0xdfe6f0);
    } else {
        show_cloud = true; /* cloudy / fog / windy / exceptional */
    }
    lv_obj_set_style_bg_color(sun, strstr(condition, "night") ? lv_color_hex(0xc3c9d6)
                                                              : lv_color_hex(0xffcf4d), 0);
    wx_cloud_color(cloud, cc);
    if (show_sun) {
        lv_obj_remove_flag(sun, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(sun, LV_OBJ_FLAG_HIDDEN);
    }
    if (show_cloud) {
        lv_obj_remove_flag(cloud, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(cloud, LV_OBJ_FLAG_HIDDEN);
    }
}

void panel_ui_set_forecast_day(int idx, const char *condition, float temperature)
{
    if (idx < 0 || idx >= FORECAST_DAYS || s_fc_temp[idx] == NULL || !bsp_display_lock(1000)) {
        return;
    }
    /* Day labels are maintained by the clock timer (date-only). */
    if (!isnan(temperature)) {
        lv_label_set_text_fmt(s_fc_temp[idx], "%.0f\xC2\xB0", (double)temperature);
    }
    apply_wx(s_fc_sun[idx], s_fc_cloud[idx], condition);
    bsp_display_unlock();
}

/* Live current weather updates today's column until the daily forecast lands. */
void panel_ui_set_weather(const char *condition, float temperature)
{
    panel_ui_set_forecast_day(0, condition, temperature);
}

void panel_ui_set_temp_sensor(const char *entity_id, float temperature)
{
    int idx = -1;
    for (int i = 0; i < (int)PANEL_TEMP_SENSOR_COUNT; i++) {
        if (strcmp(PANEL_TEMP_SENSORS[i].temp_id, entity_id) == 0) {
            idx = i;
            break;
        }
    }
    if (idx < 0 || s_temp_val[idx] == NULL || !bsp_display_lock(1000)) {
        return;
    }
    if (isnan(temperature)) {
        lv_label_set_text(s_temp_val[idx], "--");
        lv_obj_set_style_text_color(s_temp_val[idx], COLOR_TEXT, 0);
    } else {
        lv_label_set_text_fmt(s_temp_val[idx], "%.1f\xC2\xB0", (double)temperature);
        s_temp_now[idx] = temperature;
        lv_color_t c = COLOR_TEXT;
        if (PANEL_TEMP_SENSORS[idx].indoor) {
            c = temperature < COMFORT_TEMP_MIN ? COLOR_COLD
              : temperature <= COMFORT_TEMP_MAX ? COLOR_OK
              : temperature <= COMFORT_TEMP_HOT ? COLOR_WARN : COLOR_BAD;
        }
        lv_obj_set_style_text_color(s_temp_val[idx], c, 0);
    }
    bsp_display_unlock();
}

void panel_ui_set_humidity(const char *entity_id, float percent)
{
    int idx = -1;
    for (int i = 0; i < (int)PANEL_TEMP_SENSOR_COUNT; i++) {
        if (PANEL_TEMP_SENSORS[i].humidity_id &&
            strcmp(PANEL_TEMP_SENSORS[i].humidity_id, entity_id) == 0) {
            idx = i;
            break;
        }
    }
    if (idx < 0 || s_hum_val[idx] == NULL || !bsp_display_lock(1000)) {
        return;
    }
    if (isnan(percent)) {
        lv_label_set_text(s_hum_val[idx], LV_SYMBOL_TINT " --");
        lv_obj_set_style_text_color(s_hum_val[idx], COLOR_HUM, 0);
    } else {
        lv_label_set_text_fmt(s_hum_val[idx], LV_SYMBOL_TINT " %.0f%%", (double)percent);
        s_hum_now[idx] = percent;
        lv_color_t c = COLOR_HUM;
        if (PANEL_TEMP_SENSORS[idx].indoor) {
            const float off = percent < COMFORT_HUM_MIN ? COMFORT_HUM_MIN - percent
                            : percent > COMFORT_HUM_MAX ? percent - COMFORT_HUM_MAX : 0.0f;
            c = off <= 0.0f ? COLOR_OK : off > COMFORT_HUM_MARGIN ? COLOR_BAD : COLOR_WARN;
        }
        lv_obj_set_style_text_color(s_hum_val[idx], c, 0);
    }
    bsp_display_unlock();
}

void panel_ui_set_link_status(bool wifi_up, bool ha_up)
{
    if (s_status_dot == NULL || !bsp_display_lock(3000)) {
        return; /* Wi-Fi can come up before the UI exists */
    }
    lv_color_t color = COLOR_BAD;
    if (wifi_up && ha_up) {
        color = COLOR_OK;
    } else if (wifi_up) {
        color = COLOR_WARN; /* Wi-Fi up, HA down */
    }
    lv_obj_set_style_bg_color(s_status_dot, color, 0);
    bsp_display_unlock();
}
