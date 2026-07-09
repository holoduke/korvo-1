#include "panel_ui.h"

#include <math.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "bsp/esp32_s31_korvo.h"
#include "esp_log.h"
#include "lvgl.h"
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
static lv_obj_t *s_weather_label;
static lv_obj_t *s_status_dot;
static lv_obj_t *s_drawers[PANEL_TAB_COUNT];
static lv_obj_t *s_tabview;
static panel_ui_light_cb_t s_light_cb;
static panel_ui_scene_cb_t s_scene_cb;

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

static void on_scene_clicked(lv_event_t *e)
{
    const panel_entity_t *scene = lv_event_get_user_data(e);
    if (s_scene_cb) {
        s_scene_cb(scene->entity_id);
    }
}

static void on_clock_timer(lv_timer_t *t)
{
    (void)t;
    time_t now = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    if (tm_now.tm_year > 100) { /* only once SNTP has synced */
        lv_label_set_text_fmt(s_clock_label, "%02d:%02d", tm_now.tm_hour, tm_now.tm_min);
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

static void create_header(lv_obj_t *parent)
{
    lv_obj_t *bar = lv_obj_create(parent);
    lv_obj_set_size(bar, LV_PCT(100), HEADER_H);
    make_plain(bar);
    lv_obj_set_style_pad_hor(bar, 24, 0);
    lv_obj_set_flex_flow(bar, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(bar, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    s_weather_label = lv_label_create(bar);
    lv_label_set_text(s_weather_label, LV_SYMBOL_REFRESH "  --");
    lv_obj_set_style_text_font(s_weather_label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(s_weather_label, COLOR_TEXT_DIM, 0);
    lv_obj_set_flex_grow(s_weather_label, 1); /* pushes clock + dot to the right */

    s_clock_label = lv_label_create(bar);
    lv_label_set_text(s_clock_label, "--:--");
    lv_obj_set_style_text_font(s_clock_label, &lv_font_montserrat_32, 0);
    lv_obj_set_style_text_color(s_clock_label, COLOR_TEXT, 0);

    s_status_dot = lv_obj_create(bar);
    lv_obj_set_size(s_status_dot, 14, 14);
    lv_obj_set_style_radius(s_status_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(s_status_dot, COLOR_BAD, 0);
    lv_obj_set_style_border_width(s_status_dot, 0, 0);
    lv_obj_set_style_margin_left(s_status_dot, 16, 0);
}

static void create_light_grid(lv_obj_t *parent, const panel_tab_t *tab)
{
    lv_obj_t *grid = lv_obj_create(parent);
    lv_obj_set_width(grid, LV_PCT(100));
    lv_obj_set_flex_grow(grid, 1);
    make_plain(grid);
    lv_obj_set_style_pad_all(grid, 16, 0);
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
        lv_obj_add_event_cb(t->tile, on_tile_clicked, LV_EVENT_CLICKED, t);

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

static void create_scene_row(lv_obj_t *parent, const panel_tab_t *tab)
{
    lv_obj_t *row = lv_obj_create(parent);
    lv_obj_set_size(row, LV_PCT(100), 84);
    make_plain(row);
    lv_obj_set_style_pad_hor(row, 16, 0);
    lv_obj_set_style_pad_bottom(row, 14, 0);
    lv_obj_set_style_pad_gap(row, 12, 0);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);

    for (int i = 0; i < tab->scene_count; i++) {
        lv_obj_t *chip = lv_button_create(row);
        lv_obj_set_flex_grow(chip, 1);
        lv_obj_set_height(chip, LV_PCT(100));
        lv_obj_set_style_bg_color(chip, COLOR_SCENE, 0);
        lv_obj_set_style_radius(chip, 14, 0);
        lv_obj_set_style_shadow_width(chip, 0, 0);
        lv_obj_set_style_bg_opa(chip, LV_OPA_70, LV_STATE_PRESSED);
        lv_obj_add_event_cb(chip, on_scene_clicked, LV_EVENT_CLICKED,
                            (void *)&tab->scenes[i]);

        lv_obj_t *label = lv_label_create(chip);
        lv_label_set_text(label, tab->scenes[i].label);
        lv_obj_set_style_text_font(label, &lv_font_montserrat_18, 0);
        lv_obj_set_style_text_color(label, COLOR_TEXT, 0);
        lv_obj_center(label);
    }
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

static void on_handle_clicked(lv_event_t *e)
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
    lv_obj_add_event_cb(t->tile, on_tile_clicked, LV_EVENT_CLICKED, t);

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

/* Full-height handle on the far right edge that pulls in the active tab's drawer.
 * A screen-level child (not inside the tabview) so the tab-swipe gesture can't
 * swallow the press. */
#define HANDLE_W 52

static void create_handle(lv_obj_t *screen)
{
    lv_obj_t *handle = lv_button_create(screen);
    lv_obj_add_flag(handle, LV_OBJ_FLAG_FLOATING);
    lv_obj_set_size(handle, HANDLE_W, LV_VER_RES - HEADER_H - TABBAR_H);
    lv_obj_set_pos(handle, LV_HOR_RES - HANDLE_W, HEADER_H + TABBAR_H);
    lv_obj_set_style_bg_color(handle, COLOR_SCENE, 0);
    lv_obj_set_style_radius(handle, 0, 0);
    lv_obj_set_style_border_width(handle, 0, 0);
    lv_obj_set_style_shadow_width(handle, 0, 0);
    lv_obj_set_style_bg_opa(handle, LV_OPA_70, LV_STATE_PRESSED);
    lv_obj_add_event_cb(handle, on_handle_clicked, LV_EVENT_CLICKED, NULL);

    lv_obj_t *chev = lv_label_create(handle);
    lv_label_set_text(chev, LV_SYMBOL_LEFT);
    lv_obj_set_style_text_font(chev, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(chev, COLOR_TEXT, 0);
    lv_obj_center(chev);
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

void panel_ui_create(panel_ui_light_cb_t light_cb, panel_ui_scene_cb_t scene_cb)
{
    s_light_cb = light_cb;
    s_scene_cb = scene_cb;
    s_tile_count = 0;

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

    for (int i = 0; i < (int)PANEL_TAB_COUNT; i++) {
        const panel_tab_t *tab_cfg = &PANEL_TABS[i];
        lv_obj_t *tab = lv_tabview_add_tab(s_tabview, tab_cfg->name);
        lv_obj_set_style_bg_color(tab, COLOR_BG, 0);
        make_plain(tab);
        lv_obj_set_style_pad_right(tab, HANDLE_W + 4, 0); /* lane for the drawer handle */
        lv_obj_set_flex_flow(tab, LV_FLEX_FLOW_COLUMN);

        create_light_grid(tab, tab_cfg);
        create_scene_row(tab, tab_cfg);
    }
    style_tab_bar(s_tabview);

    /* Handle sits above the tabview (clickable); drawers are created afterwards
     * so they render on top of the handle and cover it when open. */
    create_handle(screen);
    for (int i = 0; i < (int)PANEL_TAB_COUNT; i++) {
        s_drawers[i] = create_drawer(&PANEL_TABS[i]);
    }

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

void panel_ui_set_weather(const char *condition, float temperature)
{
    if (!bsp_display_lock(1000)) {
        return;
    }
    if (!isnan(temperature) && condition != NULL) {
        lv_label_set_text_fmt(s_weather_label, LV_SYMBOL_REFRESH "  %s  %.1f\xC2\xB0",
                              condition, (double)temperature);
    } else if (condition != NULL) {
        lv_label_set_text_fmt(s_weather_label, LV_SYMBOL_REFRESH "  %s", condition);
    } else if (!isnan(temperature)) {
        lv_label_set_text_fmt(s_weather_label, LV_SYMBOL_REFRESH "  %.1f\xC2\xB0",
                              (double)temperature);
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
