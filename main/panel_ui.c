#include "panel_ui.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "bsp/esp32_s31_korvo.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "lvgl.h"
#include "mbedtls/base64.h"
#include "nvs.h"
#include "panel_config.h"

static const char *TAG = "panel_ui";

#define COLOR_BG        lv_color_hex(0x111318)
#define COLOR_TILE      lv_color_hex(0x232833)
#define COLOR_TILE_OFF  lv_color_hex(0x1a1d24)
#define COLOR_TILE_ON   lv_color_hex(0xffb84d)
#define COLOR_ON_TEXT   lv_color_hex(0x241a05)
#define COLOR_TEXT      lv_color_hex(0xeef0f5)
#define COLOR_TEXT_DIM  lv_color_hex(0x848b9c)
#define COLOR_SCENE     lv_color_hex(0x2b3444)
#define COLOR_SCENE_ON  lv_color_hex(0xa78bfa)   /* light purple, active scene */
#define COLOR_ACCENT    lv_color_hex(0xffb84d)
#define COLOR_OK        lv_color_hex(0x4dd06a)
#define COLOR_WARN      lv_color_hex(0xe0a555)
#define COLOR_BAD       lv_color_hex(0xe05555)

#define HEADER_H        84
#define TABBAR_H        46

#define TILE_CAP_COLOR  0x1
#define TILE_CAP_WARMTH 0x2

typedef struct {
    const panel_entity_t *entity;
    lv_obj_t *tile;
    lv_obj_t *icon;
    lv_obj_t *name_label;
    lv_obj_t *state_label;
    int caps;   /* TILE_CAP_* bit flags */
    int min_k;  /* colour-temp range (kelvin) */
    int max_k;
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
static void mark_snapshots_dirty(void);
static lv_obj_t *settings_label(lv_obj_t *parent, const char *txt,
                                const lv_font_t *font, lv_color_t color);
static void open_light_popup(const light_tile_t *tile);
static lv_obj_t *s_date_label;
static lv_obj_t *s_dow_label;     /* weekday, right cluster */
/* 5-day forecast columns in the header (index 0 = today). */
#define FORECAST_DAYS 5
static lv_obj_t *s_fc_day[FORECAST_DAYS];
static lv_obj_t *s_fc_sun[FORECAST_DAYS];
static lv_obj_t *s_fc_cloud[FORECAST_DAYS];
static lv_obj_t *s_fc_temp[FORECAST_DAYS];
static lv_obj_t *s_settings;      /* settings overlay */
static lv_obj_t *s_kb;
static lv_obj_t *s_pass_ta;
static panel_ui_wifi_cb_t s_wifi_cb;
static panel_ui_scan_cb_t s_scan_cb;
static lv_obj_t *s_wifi_sel_lbl;  /* settings-row value: SSID / "Niet verbonden" */
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

/* Screensaver timeout options (index -> milliseconds). */
static const uint32_t SAVER_OPTS_MS[] = {30000, 60000, 300000, 1800000,
                                         7200000, 86400000, 0};
#define SAVER_OPTS_STR "30 sec\n1 min\n5 min\n30 min\n2 uur\n24 uur\nnooit"
static panel_ui_light_cb_t s_light_cb;
static panel_ui_scene_cb_t s_scene_cb;
static panel_ui_brightness_cb_t s_brightness_cb;
static lv_obj_t *s_bright_label;
static lv_obj_t *s_bright_slider;
static bool s_slider_moved;
static bool s_slider_dragging;
static uint32_t s_slider_release_tick;        /* suppress HA sync briefly after a user change */
static int s_tab_brightness[PANEL_TAB_COUNT]; /* last known area brightness, -1 unknown */

/* Scene chips per tab, so activating one can highlight it and clear the others. */
#define MAX_SCENES 6
static lv_obj_t *s_scene_chips[PANEL_TAB_COUNT][MAX_SCENES];
static int s_scene_counts[PANEL_TAB_COUNT];

typedef struct {
    const panel_entity_t *scene;
    int tab_idx;
} scene_ctx_t;
static scene_ctx_t s_scene_ctx[PANEL_TAB_COUNT][MAX_SCENES];

#define SLIDER_W 56
#define SCENE_ROW_H 84

/* Grid templates (LVGL keeps the pointer, so they must persist). */
static int32_t s_col_dsc[] = { LV_GRID_FR(1), LV_GRID_FR(1), LV_GRID_FR(1), LV_GRID_TEMPLATE_LAST };
static int32_t s_row_dsc[] = { LV_GRID_FR(1), LV_GRID_FR(1), LV_GRID_TEMPLATE_LAST };

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
    lv_slider_set_value(s_popup_slider, 50, LV_ANIM_OFF);

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

static void on_scene_clicked(lv_event_t *e)
{
    const scene_ctx_t *ctx = lv_event_get_user_data(e);
    lv_obj_t *chip = lv_event_get_target(e);
    if (s_scene_cb) {
        s_scene_cb(ctx->scene->entity_id);
    }
    /* Radio-style highlight: this scene lit, the others on the tab cleared. */
    for (int j = 0; j < s_scene_counts[ctx->tab_idx]; j++) {
        lv_obj_set_style_bg_color(s_scene_chips[ctx->tab_idx][j], COLOR_SCENE, 0);
    }
    lv_obj_set_style_bg_color(chip, COLOR_SCENE_ON, 0);
    mark_snapshots_dirty();
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

static void on_clock_timer(lv_timer_t *t)
{
    (void)t;
    time_t now = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    if (tm_now.tm_year > 100) { /* only once SNTP has synced */
        static const char *const days[] = {"zondag", "maandag", "dinsdag", "woensdag",
                                            "donderdag", "vrijdag", "zaterdag"};
        static const char *const mons[] = {"jan", "feb", "mrt", "apr", "mei", "jun",
                                            "jul", "aug", "sep", "okt", "nov", "dec"};
        static const char *const sd[] = {"zo", "ma", "di", "wo", "do", "vr", "za"};
        lv_label_set_text_fmt(s_clock_label, "%02d:%02d", tm_now.tm_hour, tm_now.tm_min);
        if (s_dow_label) {
            lv_label_set_text(s_dow_label, days[tm_now.tm_wday]);
        }
        if (s_date_label) {
            lv_label_set_text_fmt(s_date_label, "%d %s", tm_now.tm_mday, mons[tm_now.tm_mon]);
        }
        /* Forecast day labels only depend on the date; keep them fresh here so
         * they appear as soon as SNTP syncs (the forecast may arrive first). */
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

static void create_header(lv_obj_t *parent)
{
    lv_obj_t *bar = lv_obj_create(parent);
    lv_obj_set_size(bar, LV_PCT(100), HEADER_H);
    make_plain(bar);
    lv_obj_set_style_bg_color(bar, lv_color_hex(0x0c0e12), 0);   /* solid dark toolbar */
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(bar, lv_color_hex(0x232833), 0);
    lv_obj_set_style_border_width(bar, 1, 0);
    lv_obj_set_style_border_side(bar, LV_BORDER_SIDE_BOTTOM, 0);
    lv_obj_set_style_pad_hor(bar, 20, 0);
    lv_obj_set_flex_flow(bar, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(bar, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    /* Left cluster: 5-day forecast, one column per day (index 0 = today). */
    lv_obj_t *fc = lv_obj_create(bar);
    lv_obj_set_size(fc, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    make_plain(fc);
    lv_obj_set_style_pad_gap(fc, 16, 0);
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
    lv_obj_set_style_text_color(s_dow_label, lv_color_hex(0xc6cbd6), 0);
    s_date_label = lv_label_create(daterow);
    lv_label_set_text(s_date_label, "");
    lv_obj_set_style_text_font(s_date_label, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(s_date_label, COLOR_TEXT_DIM, 0);

    s_status_dot = lv_obj_create(bar);
    lv_obj_set_size(s_status_dot, 14, 14);
    lv_obj_set_style_radius(s_status_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(s_status_dot, COLOR_BAD, 0);
    lv_obj_set_style_border_width(s_status_dot, 0, 0);
    lv_obj_set_style_margin_left(s_status_dot, 16, 0);

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

static void create_light_grid(lv_obj_t *parent, const panel_tab_t *tab)
{
    lv_obj_t *grid = lv_obj_create(parent);
    lv_obj_set_width(grid, LV_PCT(100));
    lv_obj_set_flex_grow(grid, 1);
    make_plain(grid);
    lv_obj_set_style_pad_all(grid, 16, 0);
    lv_obj_set_style_pad_right(grid, SLIDER_W + 28, 0); /* lane for the brightness slider */
    lv_obj_set_style_pad_gap(grid, 14, 0);
    lv_obj_set_grid_dsc_array(grid, s_col_dsc, s_row_dsc);
    lv_obj_set_layout(grid, LV_LAYOUT_GRID);

    for (int i = 0; i < tab->light_count && s_tile_count < PANEL_MAX_LIGHTS; i++) {
        light_tile_t *t = &s_tiles[s_tile_count++];
        t->entity = &tab->lights[i];
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

    const int scene_n = tab->scene_count < MAX_SCENES ? tab->scene_count : MAX_SCENES;
    s_scene_counts[tab_idx] = scene_n;
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

    /* "Show all devices" button opens this tab's slide-out drawer. */
    lv_obj_t *all = lv_button_create(row);
    lv_obj_set_flex_grow(all, 1);
    lv_obj_set_height(all, LV_PCT(100));
    lv_obj_set_style_bg_color(all, COLOR_TILE, 0);
    lv_obj_set_style_radius(all, 14, 0);
    lv_obj_set_style_shadow_width(all, 0, 0);
    lv_obj_set_style_bg_opa(all, LV_OPA_70, LV_STATE_PRESSED);
    lv_obj_add_event_cb(all, on_show_all_clicked, LV_EVENT_CLICKED, NULL);

    lv_obj_t *all_lbl = lv_label_create(all);
    lv_label_set_text(all_lbl, LV_SYMBOL_LIST "  Alle lampen");
    lv_obj_set_style_text_font(all_lbl, &lv_font_montserrat_18, 0);
    lv_obj_set_style_text_color(all_lbl, COLOR_ACCENT, 0);
    lv_obj_center(all_lbl);
}

/* ---- Slide-out drawer: all individual devices for one floor ------------- */

static void anim_x_cb(void *obj, int32_t v)
{
    lv_obj_set_x(obj, v);
}

/* The drawer is full-screen with many tiles, so animating it live re-rasterizes
 * everything each frame. Instead snapshot it once and slide the bitmap (a blit),
 * then swap to the live drawer at the end so it stays interactive. */
static lv_obj_t *s_drawer_slide_img;
static lv_draw_buf_t *s_drawer_slide_snap;
static lv_obj_t *s_drawer_live;

static void drawer_slide_cleanup(void)
{
    if (s_drawer_slide_img) {
        lv_obj_delete(s_drawer_slide_img);
        s_drawer_slide_img = NULL;
    }
    if (s_drawer_slide_snap) {
        lv_draw_buf_destroy(s_drawer_slide_snap);
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

static void drawer_slide(lv_obj_t *drawer, bool opening)
{
    if (drawer == NULL || s_drawer_slide_img) {
        return; /* ignore if a slide is already animating */
    }
    lv_draw_buf_t *snap = lv_snapshot_take(drawer, LV_COLOR_FORMAT_RGB565);
    if (snap == NULL) {
        drawer_live_anim(drawer, opening); /* fallback: live animation */
        return;
    }
    /* Park the live drawer off-screen; the bitmap does the visible sliding. */
    lv_obj_set_x(drawer, LV_HOR_RES);
    s_drawer_live = drawer;
    s_drawer_slide_snap = snap;
    s_drawer_slide_img = lv_image_create(lv_screen_active());
    lv_obj_add_flag(s_drawer_slide_img, LV_OBJ_FLAG_FLOATING);
    lv_image_set_src(s_drawer_slide_img, snap);
    lv_obj_set_pos(s_drawer_slide_img, opening ? LV_HOR_RES : 0, 0);
    lv_obj_move_foreground(s_drawer_slide_img);

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
    const uint32_t idx = lv_tabview_get_tab_active(s_tabview);
    if (idx < PANEL_TAB_COUNT) {
        drawer_open(s_drawers[idx]);
    }
}

static void on_drawer_back(lv_event_t *e)
{
    drawer_close(lv_event_get_user_data(e));
}

/* Compact device tile registered in s_tiles so state updates reach it too. */
static void create_device_tile(lv_obj_t *parent, const panel_entity_t *dev)
{
    if (s_tile_count >= PANEL_MAX_LIGHTS) {
        return;
    }
    light_tile_t *t = &s_tiles[s_tile_count++];
    t->entity = dev;

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

static lv_obj_t *create_drawer(const panel_tab_t *tab)
{
    /* Full-screen overlay, parked just off the right edge. FLOATING so the
     * screen's flex layout doesn't reposition it. */
    lv_obj_t *drawer = lv_obj_create(lv_screen_active());
    lv_obj_add_flag(drawer, LV_OBJ_FLAG_FLOATING);
    lv_obj_set_size(drawer, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_pos(drawer, LV_HOR_RES, 0);
    lv_obj_set_style_bg_color(drawer, COLOR_BG, 0);
    lv_obj_set_style_border_width(drawer, 0, 0);
    lv_obj_set_style_radius(drawer, 0, 0);
    lv_obj_set_style_pad_all(drawer, 0, 0);
    lv_obj_set_flex_flow(drawer, LV_FLEX_FLOW_COLUMN);
    lv_obj_clear_flag(drawer, LV_OBJ_FLAG_SCROLLABLE);

    /* Header: back button + title */
    lv_obj_t *hdr = lv_obj_create(drawer);
    lv_obj_set_size(hdr, LV_PCT(100), HEADER_H);
    make_plain(hdr);
    lv_obj_set_style_pad_hor(hdr, 16, 0);
    lv_obj_set_flex_flow(hdr, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(hdr, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);

    lv_obj_t *back = lv_button_create(hdr);
    lv_obj_set_height(back, 40);
    lv_obj_set_style_bg_color(back, COLOR_SCENE, 0);
    lv_obj_set_style_radius(back, 10, 0);
    lv_obj_set_style_shadow_width(back, 0, 0);
    lv_obj_add_event_cb(back, on_drawer_back, LV_EVENT_CLICKED, drawer);
    lv_obj_t *back_lbl = lv_label_create(back);
    lv_label_set_text(back_lbl, LV_SYMBOL_LEFT "  Terug");
    lv_obj_set_style_text_font(back_lbl, &lv_font_montserrat_18, 0);
    lv_obj_set_style_text_color(back_lbl, COLOR_TEXT, 0);
    lv_obj_center(back_lbl);

    lv_obj_t *title = lv_label_create(hdr);
    lv_label_set_text_fmt(title, "%s  \xE2\x80\x94  alle lampen", tab->name);
    lv_obj_set_style_text_font(title, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(title, COLOR_TEXT, 0);
    lv_obj_set_style_margin_left(title, 16, 0);

    /* Scrollable wrap of compact device tiles */
    lv_obj_t *list = lv_obj_create(drawer);
    lv_obj_set_width(list, LV_PCT(100));
    lv_obj_set_flex_grow(list, 1);
    lv_obj_set_style_bg_opa(list, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(list, 0, 0);
    lv_obj_set_style_pad_all(list, 16, 0);
    lv_obj_set_style_pad_gap(list, 12, 0);
    lv_obj_set_flex_flow(list, LV_FLEX_FLOW_ROW_WRAP);
    lv_obj_set_flex_align(list, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START,
                          LV_FLEX_ALIGN_START);

    for (int i = 0; i < tab->device_count; i++) {
        create_device_tile(list, &tab->devices[i]);
    }
    return drawer;
}

/* Vertical brightness slider on the right edge, spanning only the tile-grid
 * area (above the scene row, so it doesn't steal the bottom row's space).
 * Sets the active tab's area brightness on release. */
static void create_bright_slider(lv_obj_t *screen)
{
    const int32_t top = HEADER_H + TABBAR_H + 26;             /* start a bit lower */
    const int32_t bottom = LV_VER_RES - SCENE_ROW_H - 8;      /* stop above scene row */
    const int32_t slider_x = LV_HOR_RES - SLIDER_W - 12;

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
    lv_obj_set_pos(s_bright_label, slider_x, HEADER_H + TABBAR_H + 2);
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
    init_slider_grads();

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

/* ---- Night dim / screensaver -------------------------------------------- */

static void on_saver_click(lv_event_t *e)
{
    (void)e;
    lv_obj_add_flag(s_saver, LV_OBJ_FLAG_HIDDEN);
}

static void saver_timer_cb(lv_timer_t *t)
{
    (void)t;
    time_t now = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    if (tm_now.tm_year > 100) {
        lv_label_set_text_fmt(s_saver_clock, "%02d:%02d", tm_now.tm_hour, tm_now.tm_min);
    }
    if (s_saver_timeout_ms > 0 &&
        lv_display_get_inactive_time(NULL) > s_saver_timeout_ms &&
        lv_obj_has_flag(s_saver, LV_OBJ_FLAG_HIDDEN)) {
        lv_obj_remove_flag(s_saver, LV_OBJ_FLAG_HIDDEN);
        lv_obj_move_foreground(s_saver);
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

    s_saver_clock = lv_label_create(s_saver);
    lv_label_set_text(s_saver_clock, "--:--");
    lv_obj_set_style_text_font(s_saver_clock, &lv_font_montserrat_46, 0);
    lv_obj_set_style_text_color(s_saver_clock, lv_color_hex(0x2e3340), 0); /* dim */
    lv_obj_center(s_saver_clock);

    lv_timer_create(saver_timer_cb, 1000, NULL);
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

/* Load the saved screensaver-timeout index, apply it, and return it. */
static int saver_load_idx(void)
{
    const int n = sizeof(SAVER_OPTS_MS) / sizeof(SAVER_OPTS_MS[0]);
    uint8_t idx = 1; /* default: 1 min */
    nvs_handle_t h;
    if (nvs_open("panel", NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "saver_idx", &idx);
        nvs_close(h);
    }
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
    lv_obj_set_style_pad_ver(row, 18, 0);
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
    lv_obj_set_style_pad_gap(s_settings, 10, 0);
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

    /* --- Wi-Fi row: title left, SSID/status + connect button right. --- */
    lv_obj_t *wr = settings_row(s_settings, LV_SYMBOL_WIFI "  Wi-Fi");
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
    lv_obj_t *sr = settings_row(s_settings, LV_SYMBOL_EYE_OPEN "  Screensaver na");
    s_saver_dd = lv_dropdown_create(sr);
    lv_dropdown_set_options(s_saver_dd, SAVER_OPTS_STR);
    lv_obj_set_width(s_saver_dd, 170);
    lv_dropdown_set_selected(s_saver_dd, saver_load_idx());
    lv_obj_add_event_cb(s_saver_dd, on_saver_dd_changed, LV_EVENT_VALUE_CHANGED, NULL);

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
    for (int i = 0; i < s_tile_count; i++) {
        if (strcmp(s_tiles[i].entity->entity_id, entity_id) == 0) {
            s_tiles[i].caps = caps;
            s_tiles[i].min_k = min_kelvin;
            s_tiles[i].max_k = max_kelvin;
        }
    }
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
    if (s_wifi_sel_lbl == NULL || !bsp_display_lock(500)) {
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
static void mark_snapshots_dirty(void)
{
    for (int i = 0; i < (int)PANEL_TAB_COUNT; i++) {
        s_snap_dirty[i] = true;
    }
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
    lv_draw_buf_t *ns = lv_snapshot_take(s_tab_content[i], LV_COLOR_FORMAT_RGB565);
    if (ns != NULL) {
        lv_draw_buf_t *old = s_tab_snap[i];
        s_tab_snap[i] = ns;
        s_snap_dirty[i] = false;
        if (old) {
            lv_draw_buf_destroy(old);
        }
    }
}

/* Keep off-screen/dirty snapshots warm while idle so a swipe can start instantly.
 * One snapshot per tick bounds the cost; skipped entirely while swiping. */
static void snap_timer_cb(lv_timer_t *t)
{
    (void)t;
    if (s_swiping || s_tabview == NULL) {
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
    const int y = HEADER_H + TABBAR_H;

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
    /* Only start tracking for touches that begin inside the tile area, clear of
     * the header/tab bar, the right-edge brightness slider, and any overlay. */
    if (p.y < HEADER_H + TABBAR_H || p.x > LV_HOR_RES - SLIDER_W - 24 || overlays_open()) {
        return;
    }
    s_drag_press = true;
    s_drag_on = false;
    s_drag_suppress_click = false;
    s_drag_x0 = p.x;
    s_drag_indev = indev;
    s_drag_from = (int)lv_tabview_get_tab_active(s_tabview);
}

/* Polls the touch point ~60Hz while a press is active (LVGL doesn't deliver
 * PRESSING at the indev level, so we can't get continuous move events there). */
static void drag_poll_cb(lv_timer_t *t)
{
    (void)t;
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
        return;
    }
    const int dx = lv_obj_get_x(s_drag_from_img); /* last dragged position */
    const int dir = s_drag_to > s_drag_from ? 1 : -1;
    /* Commit if dragged far enough, OR flicked quickly toward the target, so a
     * short fast swipe still advances (s_drag_vel is peak toward-target speed). */
    const bool far = (dx < 0 ? -dx : dx) > LV_HOR_RES / 5;
    const bool flick = s_drag_vel > 6 && (-dir * dx) > 24;
    drag_end(far || flick);
}


/* ---- Screen dump (verification helper) ---------------------------------- */
/* Snapshots the active screen, downsamples 2x, and streams it over the serial
 * console as base64 RGB565 so the host can rebuild a PNG. Framed with SNAPBEGIN
 * / SNAPDATA / SNAPEND and each data line prefixed so interleaved logs filter
 * out cleanly. */
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


void panel_ui_create(panel_ui_light_cb_t light_cb, panel_ui_scene_cb_t scene_cb,
                     panel_ui_brightness_cb_t brightness_cb)
{
    s_light_cb = light_cb;
    s_scene_cb = scene_cb;
    s_brightness_cb = brightness_cb;
    s_tile_count = 0;
    for (int t = 0; t < (int)PANEL_TAB_COUNT; t++) {
        s_tab_brightness[t] = -1;
    }

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

        create_light_grid(tab, tab_cfg);
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
        s_drawers[i] = create_drawer(&PANEL_TABS[i]);
    }

    /* Overlays on the top layer so they cover everything, including drawers. */
    create_popup(lv_layer_top());
    create_settings(lv_layer_top());
    create_screensaver(lv_layer_top());

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
    for (int i = 0; i < s_tile_count; i++) {
        light_tile_t *t = &s_tiles[i];
        if (strcmp(t->entity->entity_id, entity_id) != 0) {
            continue; /* same entity may appear on several tabs: keep looking */
        }
        const bool on = strcmp(state, "on") == 0;
        const bool unavailable = strcmp(state, "unavailable") == 0 ||
                                 strcmp(state, "unknown") == 0 ||
                                 strcmp(state, "none") == 0;
        if (!bsp_display_lock(1000)) {
            ESP_LOGW(TAG, "LVGL lock timeout");
            return;
        }
        if (unavailable) {
            /* Physically unreachable (e.g. wall switch off): dim the whole tile,
             * show a warning glyph and greyed text so it reads as disabled. */
            lv_obj_set_style_opa(t->tile, LV_OPA_50, 0);
            lv_obj_set_style_bg_color(t->tile, COLOR_TILE_OFF, 0);
            lv_label_set_text(t->icon, LV_SYMBOL_WARNING);
            lv_obj_set_style_text_color(t->icon, COLOR_TEXT_DIM, 0);
            lv_obj_set_style_text_color(t->name_label, COLOR_TEXT_DIM, 0);
            lv_label_set_text(t->state_label, "niet beschikbaar");
            lv_obj_set_style_text_color(t->state_label, COLOR_TEXT_DIM, 0);
        } else {
            lv_obj_set_style_opa(t->tile, LV_OPA_COVER, 0);
            lv_obj_set_style_bg_color(t->tile, on ? COLOR_TILE_ON : COLOR_TILE, 0);
            lv_label_set_text(t->icon, LV_SYMBOL_POWER);
            lv_obj_set_style_text_color(t->icon, on ? COLOR_ON_TEXT : COLOR_TEXT_DIM, 0);
            lv_obj_set_style_text_color(t->name_label, on ? COLOR_ON_TEXT : COLOR_TEXT, 0);
            lv_label_set_text(t->state_label, on ? "aan" : "uit");
            lv_obj_set_style_text_color(t->state_label,
                                        on ? lv_color_hex(0x6b5518) : COLOR_TEXT_DIM, 0);
        }
        bsp_display_unlock();
        mark_snapshots_dirty(); /* tile visuals changed -> refresh cache */
    }
}

void panel_ui_toggle_tab(void)
{
    if (s_tabview == NULL || !bsp_display_lock(200)) {
        return;
    }
    const uint32_t idx = lv_tabview_get_tab_active(s_tabview);
    lv_tabview_set_active(s_tabview, idx == 0 ? 1 : 0, LV_ANIM_ON);
    bsp_display_unlock();
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
            for (int j = 0; j < s_scene_counts[t]; j++) {
                lv_obj_set_style_bg_color(s_scene_chips[t][j], COLOR_SCENE, 0);
            }
            lv_obj_set_style_bg_color(s_scene_chips[t][i], COLOR_SCENE_ON, 0);
            bsp_display_unlock();
            mark_snapshots_dirty();
            return;
        }
    }
}

void panel_ui_set_area_brightness(const char *entity_id, int brightness_pct)
{
    if (entity_id == NULL || brightness_pct < 0) {
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

void panel_ui_set_link_status(bool wifi_up, bool ha_up)
{
    if (!bsp_display_lock(1000)) {
        return;
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
