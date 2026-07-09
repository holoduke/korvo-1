#include "panel_ui.h"

#include <math.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "bsp/esp32_s31_korvo.h"
#include "esp_log.h"
#include "lvgl.h"
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

#define HEADER_H        56
#define TABBAR_H        46

typedef struct {
    const panel_entity_t *entity;
    lv_obj_t *tile;
    lv_obj_t *icon;
    lv_obj_t *name_label;
    lv_obj_t *state_label;
} light_tile_t;

static light_tile_t s_tiles[PANEL_MAX_LIGHTS];
static int s_tile_count;
static lv_obj_t *s_clock_label;
static lv_obj_t *s_status_dot;
static lv_obj_t *s_drawers[PANEL_TAB_COUNT];
static lv_obj_t *s_tabview;
static lv_obj_t *s_date_label;
static lv_obj_t *s_temp_label;
static lv_obj_t *s_wx_sun;        /* drawn weather icon parts */
static lv_obj_t *s_wx_cloud;
static lv_obj_t *s_settings;      /* settings overlay */
static lv_obj_t *s_kb;
static lv_obj_t *s_ssid_ta;
static lv_obj_t *s_pass_ta;
static panel_ui_wifi_cb_t s_wifi_cb;
static lv_obj_t *s_saver;         /* night dim / screensaver overlay */
static lv_obj_t *s_saver_clock;
static lv_obj_t *s_popup;         /* long-press per-light brightness popup */
static lv_obj_t *s_popup_title;
static lv_obj_t *s_popup_slider;
static const panel_entity_t *s_popup_entity;

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
    const light_tile_t *tile = lv_event_get_user_data(e);
    if (s_light_cb) {
        s_light_cb(tile->entity->entity_id);
    }
}

/* Long-press a tile -> open the per-light brightness popup. */
static void on_tile_long_pressed(lv_event_t *e)
{
    const light_tile_t *tile = lv_event_get_user_data(e);
    if (s_popup == NULL) {
        return;
    }
    s_popup_entity = tile->entity;
    lv_label_set_text(s_popup_title, tile->entity->label);
    lv_slider_set_value(s_popup_slider, 50, LV_ANIM_OFF);
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
        lv_label_set_text_fmt(s_clock_label, "%02d:%02d", tm_now.tm_hour, tm_now.tm_min);
        if (s_date_label) {
            lv_label_set_text_fmt(s_date_label, "%s %d %s", days[tm_now.tm_wday],
                                  tm_now.tm_mday, mons[tm_now.tm_mon]);
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

static void wx_cloud_color(lv_color_t c)
{
    if (!s_wx_cloud) {
        return;
    }
    const uint32_t n = lv_obj_get_child_count(s_wx_cloud);
    for (uint32_t i = 0; i < n; i++) {
        lv_obj_set_style_bg_color(lv_obj_get_child(s_wx_cloud, i), c, 0);
    }
}

/* Drawn sun + cloud; panel_ui_set_weather shows/tints them per condition. */
static void create_weather_icon(lv_obj_t *parent)
{
    lv_obj_t *box = lv_obj_create(parent);
    lv_obj_set_size(box, 46, 42);
    make_plain(box);

    s_wx_sun = wx_shape(box, 26, 26, LV_RADIUS_CIRCLE, lv_color_hex(0xffcf4d));
    lv_obj_align(s_wx_sun, LV_ALIGN_TOP_LEFT, 0, 0);

    s_wx_cloud = lv_obj_create(box);
    lv_obj_set_size(s_wx_cloud, 46, 24);
    make_plain(s_wx_cloud);
    lv_obj_align(s_wx_cloud, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_align(wx_shape(s_wx_cloud, 44, 13, 7, COLOR_TEXT_DIM), LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_align(wx_shape(s_wx_cloud, 18, 18, LV_RADIUS_CIRCLE, COLOR_TEXT_DIM),
                 LV_ALIGN_BOTTOM_LEFT, 5, -3);
    lv_obj_align(wx_shape(s_wx_cloud, 22, 22, LV_RADIUS_CIRCLE, COLOR_TEXT_DIM),
                 LV_ALIGN_BOTTOM_MID, 3, -2);
}

static void create_header(lv_obj_t *parent)
{
    lv_obj_t *bar = lv_obj_create(parent);
    lv_obj_set_size(bar, LV_PCT(100), HEADER_H);
    make_plain(bar);
    lv_obj_set_style_pad_hor(bar, 20, 0);
    lv_obj_set_flex_flow(bar, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(bar, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    lv_obj_t *wx = lv_obj_create(bar);
    lv_obj_set_size(wx, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    make_plain(wx);
    lv_obj_set_style_pad_gap(wx, 10, 0);
    lv_obj_set_flex_flow(wx, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(wx, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_flex_grow(wx, 1); /* pushes clock + dot to the right */
    create_weather_icon(wx);
    s_temp_label = lv_label_create(wx);
    lv_label_set_text(s_temp_label, "--");
    lv_obj_set_style_text_font(s_temp_label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(s_temp_label, COLOR_TEXT, 0);

    lv_obj_t *timebox = lv_obj_create(bar);
    lv_obj_set_size(timebox, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    make_plain(timebox);
    lv_obj_set_flex_flow(timebox, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(timebox, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_END,
                          LV_FLEX_ALIGN_END);

    s_clock_label = lv_label_create(timebox);
    lv_label_set_text(s_clock_label, "--:--");
    lv_obj_set_style_text_font(s_clock_label, &lv_font_montserrat_32, 0);
    lv_obj_set_style_text_color(s_clock_label, COLOR_TEXT, 0);

    s_date_label = lv_label_create(timebox);
    lv_label_set_text(s_date_label, "");
    lv_obj_set_style_text_font(s_date_label, &lv_font_montserrat_18, 0);
    lv_obj_set_style_text_color(s_date_label, COLOR_TEXT_DIM, 0);

    s_status_dot = lv_obj_create(bar);
    lv_obj_set_size(s_status_dot, 14, 14);
    lv_obj_set_style_radius(s_status_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(s_status_dot, COLOR_BAD, 0);
    lv_obj_set_style_border_width(s_status_dot, 0, 0);
    lv_obj_set_style_margin_left(s_status_dot, 16, 0);

    lv_obj_t *gear = lv_button_create(bar);
    lv_obj_set_size(gear, 46, 46);
    lv_obj_set_style_bg_opa(gear, LV_OPA_TRANSP, 0);
    lv_obj_set_style_bg_opa(gear, LV_OPA_30, LV_STATE_PRESSED);
    lv_obj_set_style_bg_color(gear, COLOR_TILE, LV_STATE_PRESSED);
    lv_obj_set_style_shadow_width(gear, 0, 0);
    lv_obj_set_style_margin_left(gear, 8, 0);
    lv_obj_add_event_cb(gear, on_settings_open, LV_EVENT_CLICKED, NULL);
    lv_obj_t *gl = lv_label_create(gear);
    lv_label_set_text(gl, LV_SYMBOL_SETTINGS);
    lv_obj_set_style_text_font(gl, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(gl, COLOR_TEXT_DIM, 0);
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

static void drawer_open(lv_obj_t *drawer)
{
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, drawer);
    lv_anim_set_values(&a, LV_HOR_RES, 0);
    lv_anim_set_duration(&a, 260);
    lv_anim_set_exec_cb(&a, anim_x_cb);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
    lv_anim_start(&a);
}

static void drawer_close(lv_obj_t *drawer)
{
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, drawer);
    lv_anim_set_values(&a, 0, LV_HOR_RES);
    lv_anim_set_duration(&a, 240);
    lv_anim_set_exec_cb(&a, anim_x_cb);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_in);
    lv_anim_start(&a);
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

static void on_popup_close(lv_event_t *e)
{
    (void)e;
    lv_obj_add_flag(s_popup, LV_OBJ_FLAG_HIDDEN);
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
    lv_obj_set_size(box, 460, 200);
    lv_obj_center(box);
    lv_obj_set_style_bg_color(box, COLOR_TILE, 0);
    lv_obj_set_style_radius(box, 20, 0);
    lv_obj_set_style_border_width(box, 0, 0);
    lv_obj_set_style_pad_all(box, 24, 0);
    lv_obj_clear_flag(box, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(box, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(box, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);

    s_popup_title = lv_label_create(box);
    lv_label_set_text(s_popup_title, "");
    lv_obj_set_style_text_font(s_popup_title, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(s_popup_title, COLOR_TEXT, 0);
    lv_obj_set_style_pad_bottom(s_popup_title, 20, 0);

    s_popup_slider = lv_slider_create(box);
    lv_obj_set_size(s_popup_slider, LV_PCT(100), 40);
    lv_slider_set_range(s_popup_slider, 0, 100);
    lv_obj_set_style_bg_color(s_popup_slider, COLOR_TILE_OFF, LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_popup_slider, COLOR_TILE_ON, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(s_popup_slider, COLOR_TEXT, LV_PART_KNOB);
    lv_obj_set_style_pad_all(s_popup_slider, 6, LV_PART_KNOB);
    lv_obj_add_event_cb(s_popup_slider, on_popup_slider, LV_EVENT_RELEASED, NULL);
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

static void on_wifi_connect(lv_event_t *e)
{
    (void)e;
    const char *ssid = lv_textarea_get_text(s_ssid_ta);
    const char *pass = lv_textarea_get_text(s_pass_ta);
    if (s_wifi_cb && ssid && strlen(ssid) > 0) {
        s_wifi_cb(ssid, pass);
    }
    if (s_kb) {
        lv_obj_add_flag(s_kb, LV_OBJ_FLAG_HIDDEN);
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

    settings_label(s_settings, LV_SYMBOL_WIFI "  Wi-Fi", &lv_font_montserrat_24, COLOR_ACCENT);

    settings_label(s_settings, "Netwerk (SSID)", &lv_font_montserrat_18, COLOR_TEXT_DIM);
    s_ssid_ta = lv_textarea_create(s_settings);
    lv_textarea_set_one_line(s_ssid_ta, true);
    lv_obj_set_width(s_ssid_ta, LV_PCT(70));
    lv_obj_add_event_cb(s_ssid_ta, on_ta_event, LV_EVENT_ALL, NULL);

    settings_label(s_settings, "Wachtwoord", &lv_font_montserrat_18, COLOR_TEXT_DIM);
    s_pass_ta = lv_textarea_create(s_settings);
    lv_textarea_set_one_line(s_pass_ta, true);
    lv_textarea_set_password_mode(s_pass_ta, true);
    lv_obj_set_width(s_pass_ta, LV_PCT(70));
    lv_obj_add_event_cb(s_pass_ta, on_ta_event, LV_EVENT_ALL, NULL);

    lv_obj_t *connect = lv_button_create(s_settings);
    lv_obj_set_style_bg_color(connect, COLOR_TILE_ON, 0);
    lv_obj_set_style_radius(connect, 12, 0);
    lv_obj_set_style_shadow_width(connect, 0, 0);
    lv_obj_set_style_margin_top(connect, 6, 0);
    lv_obj_add_event_cb(connect, on_wifi_connect, LV_EVENT_CLICKED, NULL);
    lv_obj_center(settings_label(connect, "Verbinden", &lv_font_montserrat_24,
                                 lv_color_hex(0x241a05)));

    settings_label(s_settings, LV_SYMBOL_EYE_OPEN "  Screensaver na",
                   &lv_font_montserrat_24, COLOR_ACCENT);
    s_saver_dd = lv_dropdown_create(s_settings);
    lv_dropdown_set_options(s_saver_dd, SAVER_OPTS_STR);
    lv_obj_set_width(s_saver_dd, LV_PCT(45));
    lv_dropdown_set_selected(s_saver_dd, saver_load_idx());
    lv_obj_add_event_cb(s_saver_dd, on_saver_dd_changed, LV_EVENT_VALUE_CHANGED, NULL);

    s_kb = lv_keyboard_create(s_settings);
    lv_obj_add_flag(s_kb, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_event_cb(s_kb, on_kb_done, LV_EVENT_READY, NULL);
    lv_obj_add_event_cb(s_kb, on_kb_done, LV_EVENT_CANCEL, NULL);
}

void panel_ui_set_wifi_callback(panel_ui_wifi_cb_t cb, const char *current_ssid)
{
    s_wifi_cb = cb;
    if (s_ssid_ta && current_ssid && bsp_display_lock(500)) {
        lv_textarea_set_text(s_ssid_ta, current_ssid);
        bsp_display_unlock();
    }
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
        lv_obj_set_style_bg_color(tab, COLOR_BG, 0);
        make_plain(tab);
        lv_obj_set_flex_flow(tab, LV_FLEX_FLOW_COLUMN);

        create_light_grid(tab, tab_cfg);
        create_scene_row(tab, tab_cfg, i);
    }
    style_tab_bar(s_tabview);

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

void panel_ui_set_weather(const char *condition, float temperature)
{
    if (!bsp_display_lock(1000)) {
        return;
    }
    if (!isnan(temperature) && s_temp_label) {
        lv_label_set_text_fmt(s_temp_label, "%.0f\xC2\xB0", (double)temperature);
    }
    if (condition != NULL && s_wx_sun && s_wx_cloud) {
        bool sun = false, cloud = false;
        lv_color_t cc = COLOR_TEXT_DIM;
        if (strstr(condition, "partlycloudy")) {
            sun = true;
            cloud = true;
        } else if (strstr(condition, "sunny") || strstr(condition, "clear")) {
            sun = true;
        } else if (strstr(condition, "rain") || strstr(condition, "pour") ||
                   strstr(condition, "lightning")) {
            cloud = true;
            cc = lv_color_hex(0x7fa8d0);
        } else if (strstr(condition, "snow")) {
            cloud = true;
            cc = lv_color_hex(0xdfe6f0);
        } else {
            cloud = true; /* cloudy / fog / windy / exceptional */
        }
        lv_obj_set_style_bg_color(s_wx_sun,
                                  strstr(condition, "night") ? lv_color_hex(0xc3c9d6)
                                                             : lv_color_hex(0xffcf4d), 0);
        wx_cloud_color(cc);
        if (sun) {
            lv_obj_remove_flag(s_wx_sun, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s_wx_sun, LV_OBJ_FLAG_HIDDEN);
        }
        if (cloud) {
            lv_obj_remove_flag(s_wx_cloud, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s_wx_cloud, LV_OBJ_FLAG_HIDDEN);
        }
    }
    bsp_display_unlock();
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
