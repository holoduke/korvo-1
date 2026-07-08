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

#define COLOR_BG        lv_color_hex(0x14161a)
#define COLOR_TILE      lv_color_hex(0x232833)
#define COLOR_TILE_ON   lv_color_hex(0xffb84d)
#define COLOR_TEXT      lv_color_hex(0xe8eaf0)
#define COLOR_TEXT_DIM  lv_color_hex(0x8a90a0)
#define COLOR_SCENE     lv_color_hex(0x2d3645)
#define COLOR_OK        lv_color_hex(0x4dd06a)
#define COLOR_WARN      lv_color_hex(0xe0a555)
#define COLOR_BAD       lv_color_hex(0xe05555)

#define HEADER_HEIGHT   52
#define TILE_GRID_H     288
#define TILE_W          244
#define TILE_H          128

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
static panel_ui_light_cb_t s_light_cb;
static panel_ui_scene_cb_t s_scene_cb;

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

static void create_header(lv_obj_t *parent)
{
    lv_obj_t *bar = lv_obj_create(parent);
    lv_obj_set_size(bar, LV_PCT(100), HEADER_HEIGHT);
    lv_obj_set_style_bg_color(bar, COLOR_BG, 0);
    lv_obj_set_style_border_width(bar, 0, 0);
    lv_obj_set_style_radius(bar, 0, 0);
    lv_obj_set_style_pad_hor(bar, 24, 0);
    lv_obj_set_style_pad_ver(bar, 4, 0);
    lv_obj_clear_flag(bar, LV_OBJ_FLAG_SCROLLABLE);

    s_weather_label = lv_label_create(bar);
    lv_label_set_text(s_weather_label, "--");
    lv_obj_set_style_text_font(s_weather_label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(s_weather_label, COLOR_TEXT_DIM, 0);
    lv_obj_align(s_weather_label, LV_ALIGN_LEFT_MID, 0, 0);

    s_clock_label = lv_label_create(bar);
    lv_label_set_text(s_clock_label, "--:--");
    lv_obj_set_style_text_font(s_clock_label, &lv_font_montserrat_32, 0);
    lv_obj_set_style_text_color(s_clock_label, COLOR_TEXT, 0);
    lv_obj_align(s_clock_label, LV_ALIGN_RIGHT_MID, -28, 0);

    s_status_dot = lv_obj_create(bar);
    lv_obj_set_size(s_status_dot, 14, 14);
    lv_obj_set_style_radius(s_status_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(s_status_dot, COLOR_BAD, 0);
    lv_obj_set_style_border_width(s_status_dot, 0, 0);
    lv_obj_align(s_status_dot, LV_ALIGN_RIGHT_MID, 0, 0);

    lv_timer_create(on_clock_timer, 1000, NULL);
}

static void create_light_grid(lv_obj_t *parent, const panel_tab_t *tab)
{
    lv_obj_t *grid = lv_obj_create(parent);
    lv_obj_set_size(grid, LV_PCT(100), TILE_GRID_H);
    lv_obj_set_style_bg_opa(grid, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(grid, 0, 0);
    lv_obj_set_style_pad_all(grid, 8, 0);
    lv_obj_set_style_pad_gap(grid, 10, 0);
    lv_obj_set_flex_flow(grid, LV_FLEX_FLOW_ROW_WRAP);
    lv_obj_clear_flag(grid, LV_OBJ_FLAG_SCROLLABLE);

    for (int i = 0; i < tab->light_count && s_tile_count < PANEL_MAX_LIGHTS; i++) {
        light_tile_t *t = &s_tiles[s_tile_count++];
        t->entity = &tab->lights[i];

        t->tile = lv_button_create(grid);
        lv_obj_set_size(t->tile, TILE_W, TILE_H);
        lv_obj_set_style_bg_color(t->tile, COLOR_TILE, 0);
        lv_obj_set_style_radius(t->tile, 16, 0);
        lv_obj_set_style_shadow_width(t->tile, 0, 0);
        lv_obj_add_event_cb(t->tile, on_tile_clicked, LV_EVENT_CLICKED, t);

        t->icon = lv_label_create(t->tile);
        lv_label_set_text(t->icon, LV_SYMBOL_POWER);
        lv_obj_set_style_text_font(t->icon, &lv_font_montserrat_32, 0);
        lv_obj_set_style_text_color(t->icon, COLOR_TEXT_DIM, 0);
        lv_obj_align(t->icon, LV_ALIGN_TOP_LEFT, 4, 2);

        t->name_label = lv_label_create(t->tile);
        lv_label_set_text(t->name_label, t->entity->label);
        lv_obj_set_style_text_font(t->name_label, &lv_font_montserrat_24, 0);
        lv_obj_set_style_text_color(t->name_label, COLOR_TEXT, 0);
        lv_obj_align(t->name_label, LV_ALIGN_BOTTOM_LEFT, 4, -24);

        t->state_label = lv_label_create(t->tile);
        lv_label_set_text(t->state_label, "...");
        lv_obj_set_style_text_font(t->state_label, &lv_font_montserrat_18, 0);
        lv_obj_set_style_text_color(t->state_label, COLOR_TEXT_DIM, 0);
        lv_obj_align(t->state_label, LV_ALIGN_BOTTOM_LEFT, 4, 0);
    }
}

static void create_scene_row(lv_obj_t *parent, const panel_tab_t *tab)
{
    lv_obj_t *row = lv_obj_create(parent);
    lv_obj_set_size(row, LV_PCT(100), 78);
    lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(row, 0, 0);
    lv_obj_set_style_pad_hor(row, 8, 0);
    lv_obj_set_style_pad_gap(row, 10, 0);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);

    for (int i = 0; i < tab->scene_count; i++) {
        lv_obj_t *chip = lv_button_create(row);
        lv_obj_set_flex_grow(chip, 1);
        lv_obj_set_height(chip, 60);
        lv_obj_set_style_bg_color(chip, COLOR_SCENE, 0);
        lv_obj_set_style_radius(chip, 12, 0);
        lv_obj_set_style_shadow_width(chip, 0, 0);
        lv_obj_add_event_cb(chip, on_scene_clicked, LV_EVENT_CLICKED,
                            (void *)&tab->scenes[i]);

        lv_obj_t *label = lv_label_create(chip);
        lv_label_set_text(label, tab->scenes[i].label);
        lv_obj_set_style_text_font(label, &lv_font_montserrat_18, 0);
        lv_obj_set_style_text_color(label, COLOR_TEXT, 0);
        lv_obj_center(label);
    }
}

static void style_tab_bar(lv_obj_t *tabview)
{
    lv_obj_t *bar = lv_tabview_get_tab_bar(tabview);
    lv_obj_set_style_bg_color(bar, COLOR_BG, 0);
    lv_obj_set_style_border_width(bar, 0, 0);

    const uint32_t count = lv_obj_get_child_count(bar);
    for (uint32_t i = 0; i < count; i++) {
        lv_obj_t *btn = lv_obj_get_child(bar, i);
        lv_obj_set_style_bg_color(btn, COLOR_BG, 0);
        lv_obj_set_style_text_color(btn, COLOR_TEXT_DIM, 0);
        lv_obj_set_style_text_font(btn, &lv_font_montserrat_24, 0);
        lv_obj_set_style_text_color(btn, COLOR_TILE_ON, LV_STATE_CHECKED);
        lv_obj_set_style_border_color(btn, COLOR_TILE_ON, LV_STATE_CHECKED);
    }
}

void panel_ui_create(panel_ui_light_cb_t light_cb, panel_ui_scene_cb_t scene_cb)
{
    s_light_cb = light_cb;
    s_scene_cb = scene_cb;
    s_tile_count = 0;

    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, COLOR_BG, 0);
    lv_obj_set_style_pad_all(screen, 0, 0);
    lv_obj_set_flex_flow(screen, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_gap(screen, 0, 0);
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);

    create_header(screen);

    lv_obj_t *tabview = lv_tabview_create(screen);
    lv_obj_set_size(tabview, LV_PCT(100), LV_VER_RES - HEADER_HEIGHT);
    lv_tabview_set_tab_bar_position(tabview, LV_DIR_TOP);
    lv_tabview_set_tab_bar_size(tabview, 48);
    lv_obj_set_style_bg_color(tabview, COLOR_BG, 0);

    for (int i = 0; i < (int)PANEL_TAB_COUNT; i++) {
        const panel_tab_t *tab_cfg = &PANEL_TABS[i];
        lv_obj_t *tab = lv_tabview_add_tab(tabview, tab_cfg->name);
        lv_obj_set_style_bg_color(tab, COLOR_BG, 0);
        lv_obj_set_style_pad_all(tab, 0, 0);
        lv_obj_set_flex_flow(tab, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_style_pad_gap(tab, 0, 0);
        lv_obj_clear_flag(tab, LV_OBJ_FLAG_SCROLLABLE);

        create_light_grid(tab, tab_cfg);
        create_scene_row(tab, tab_cfg);
    }
    style_tab_bar(tabview);

    /* Swiping left/right on the content switches tabs. */
    lv_obj_t *content = lv_tabview_get_content(tabview);
    lv_obj_add_flag(content, LV_OBJ_FLAG_SCROLL_ONE);
    lv_obj_set_scroll_snap_x(content, LV_SCROLL_SNAP_CENTER);

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
                                 strcmp(state, "unknown") == 0;
        if (!bsp_display_lock(1000)) {
            ESP_LOGW(TAG, "LVGL lock timeout");
            return;
        }
        lv_obj_set_style_bg_color(t->tile, on ? COLOR_TILE_ON : COLOR_TILE, 0);
        lv_obj_set_style_text_color(t->icon,
                                    on ? lv_color_hex(0x14161a) : COLOR_TEXT_DIM, 0);
        lv_obj_set_style_text_color(t->name_label,
                                    on ? lv_color_hex(0x14161a) : COLOR_TEXT, 0);
        lv_label_set_text(t->state_label,
                          unavailable ? "niet beschikbaar" : (on ? "aan" : "uit"));
        lv_obj_set_style_text_color(t->state_label,
                                    on ? lv_color_hex(0x5a4a20) : COLOR_TEXT_DIM, 0);
        bsp_display_unlock();
    }
}

void panel_ui_set_weather(const char *condition, float temperature)
{
    if (!bsp_display_lock(1000)) {
        return;
    }
    if (!isnan(temperature) && condition != NULL) {
        lv_label_set_text_fmt(s_weather_label, "%s  %.1f\xC2\xB0", condition, (double)temperature);
    } else if (condition != NULL) {
        lv_label_set_text(s_weather_label, condition);
    } else if (!isnan(temperature)) {
        lv_label_set_text_fmt(s_weather_label, "%.1f\xC2\xB0", (double)temperature);
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
