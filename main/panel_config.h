/* Wall panel configuration: Home Assistant endpoint and the entities shown. */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "lvgl.h" /* LV_SYMBOL_* icons in the scene tables */

#define HA_WEBSOCKET_URI   "ws://192.168.2.111:8123/api/websocket"

/* Europe/Amsterdam for the clock */
#define PANEL_TIMEZONE     "CET-1CEST,M3.5.0,M10.5.0/3"
#define PANEL_SNTP_SERVER  "pool.ntp.org"

typedef struct {
    const char *entity_id;
    const char *label;
} panel_entity_t;

/* Colour swatch for a compact scene tile: solid `a`, or a horizontal a->b
 * gradient when b != 0. SWATCH_RAINBOW as `a` draws the full hue wheel. */
typedef struct {
    uint32_t a;
    uint32_t b;
} panel_swatch_t;
#define SWATCH_RAINBOW 0xFFFFFFFFu

typedef struct {
    const char *name;              /* tab title */
    const panel_entity_t *lights;  /* toggle tiles (max 6 per tab); on a scene tab
                                    * these aren't shown but still scope the
                                    * brightness slider (lights[0] feeds it back) */
    int light_count;
    const panel_entity_t *scenes;  /* chips along the bottom, or the tiles on a scene tab */
    int scene_count;
    const panel_entity_t *devices; /* individual lights shown in the slide-out drawer */
    int device_count;
    const char *const *scene_icons; /* optional LV_SYMBOL_* per scene (scene tabs) */
    const panel_swatch_t *scene_swatches; /* optional colour dot per scene (scene tabs) */
    int quick_scenes;              /* the last N scenes render as small icon buttons in
                                    * the bottom row instead of grid tiles (scene tabs) */
    bool scene_tiles;              /* true: grid shows scenes as tiles and the bottom
                                    * row shows the active scene instead of chips */
} panel_tab_t;

/* ---- Tab: Beneden (ground-floor zone) ----------------------------------- */
/* Scene tab: the tiles ARE the ground-floor scenes (HA has no reliable
 * per-room groups here: gang/WC are unavailable most of the time). The
 * brightness slider still targets the whole floor group. */
static const panel_entity_t TAB_THUIS_LIGHTS[] = {
    { "light.lampen_beneden_verdieping", "Beneden" },
};
static const panel_entity_t TAB_THUIS_SCENES[] = {
    { "scene.woonkamer_alles_aan",   "Alles aan" },
    { "scene.woonkamer_avond",       "Avond sfeer" },
    { "scene.woonkamer_avond_licht", "Avond licht" },
    { "scene.woonkamer_paars_rood",  "Paars rood" },
    { "scene.woonkamer_alles_uit",   "Alles uit" },
    /* Cuba: the garage's cyan/orange/yellow/pink rotation on the ground floor
     * (scene created in HA 2026-09-06). Shown with a colour swatch. */
    { "scene.woonkamer_cuba",        "Cuba" },
    /* Quick buttons (bottom row): every ground-floor light on at minimum /
     * full brightness. Scenes created in HA's scene editor on 2026-09-06. */
    { "scene.woonkamer_min",         "Min" },
    { "scene.woonkamer_max",         "Max" },
};
/* Tile icons, same order as TAB_THUIS_SCENES. */
static const char *const TAB_THUIS_ICONS[] = {
    LV_SYMBOL_CHARGE, LV_SYMBOL_EYE_CLOSE, LV_SYMBOL_EYE_OPEN, LV_SYMBOL_TINT, LV_SYMBOL_POWER,
    NULL, LV_SYMBOL_MINUS, LV_SYMBOL_PLUS,
};
/* Swatches, same order; 0 = use the icon instead. */
static const panel_swatch_t TAB_THUIS_SWATCHES[] = {
    { 0, 0 }, { 0, 0 }, { 0, 0 }, { 0, 0 }, { 0, 0 },
    { 0x1fb8a6, 0xffc857 }, /* Cuba: teal -> gold */
    { 0, 0 }, { 0, 0 },
};
/* Drawer: every individual ground-floor light, grouped by room, taken from the
 * members of HA's light.lampen_beneden_verdieping and the scenes above. */
static const panel_entity_t TAB_THUIS_DEVICES[] = {
    { "light.lamp_woonkamer_kubus_1",        "Kubus" },
    { "light.lamp_valerie_rieten_1",         "Rieten" },
    { "light.lamp_woonkamer_plafond_tv_2",   "Plafond TV 2" },
    { "light.lamp_woonkamer_plafond_tv_3",   "Plafond TV 3" },
    { "light.lamp_grond_1",                  "Grond" },
    { "light.lamp_keuken_eettafel_1",        "Eettafel" },
    { "light.lamp_keuken_plafond_1",         "Keuken plafond" },
    { "light.lamp_keuken_muur_1",            "Keuken muur 1" },
    { "light.lamp_keuken_muur_2",            "Keuken muur 2" },
    { "light.lamp_keuken_muur_3",            "Keuken muur 3" },
    { "light.lamp_zitkamer_1",               "Zitkamer" },
    { "light.lamp_zitkamer_achter_1",        "Zitk. achter 1" },
    { "light.lamp_zitkamer_achter_2",        "Zitk. achter 2" },
    { "light.lamp_zitkamer_achter_3",        "Zitk. achter 3" },
    { "light.lamp_zitkamer_achter_muur_1",   "Zitk. muur 1" },
    { "light.lamp_zitkamer_achter_muur_2",   "Zitk. muur 2" },
    { "light.lamp_playroom_1",               "Gameroom" },
    { "light.lamp_playroom_muur_1",          "Gameroom muur 1" },
    { "light.lamp_playroom_muur_2",          "Gameroom muur 2" },
    { "light.lamp_playroom_muur_3",          "Gameroom muur 3" },
    { "light.lamp_gang_deur_1",              "Gang deur" },
    { "light.lamp_gang_trap_beneden_1",      "Gang trap" },
    { "light.lamp_wc_beneden_1",             "WC" },
    { "light.lamp_buiten_1",                 "Buiten" },
};

/* ---- Tab: Boven (upper floors) ------------------------------------------ */
/* HA's light.lampen_bovenverdieping group is broken (no members) and
 * light.lamp_badkamer_1 no longer exists; the bathroom is badkamer_2_plafond_*. */
static const panel_entity_t TAB_BOVEN_LIGHTS[] = {
    { "light.lamp_slaapkamer_gillis_ilse",  "Slaapkamer" },
    { "light.lamp_valerie_kamer_1",         "Valerie" },
    { "light.lamp_jongens_kamer_1",         "Jongens" },
    { "light.lamp_badkamer_2_plafond_2",    "Badkamer 2" },
    { "light.lamp_badkamer_2_plafond_3",    "Badkamer 3" },
};
static const panel_entity_t TAB_BOVEN_SCENES[] = {
    { "scene.slaapkamer_aan",     "Slaapk. aan" },
    { "scene.slaapkamer_aan_fel", "Slaapk. fel" },
    { "scene.slaapkamer_uit",     "Slaapk. uit" },
};
static const panel_entity_t TAB_BOVEN_DEVICES[] = {
    { "light.lamp_slaapkamer_gillis_ilse",       "Slaapkamer" },
    { "light.lamp_slaapkamer_staand_ilse_gillis","Slaapk. staand" },
    { "light.lamp_gillis_ilse_nachtkasje_lamp_gillis_ilse_nachtkasje", "Nachtkastje" },
    { "light.lamp_valerie_kamer_1",              "Valerie" },
    { "light.lamp_jongens_kamer_1",              "Jongens" },
    { "light.lamp_badkamer_2_plafond_1",         "Badkamer 1" },
    { "light.lamp_badkamer_2_plafond_2",         "Badkamer 2" },
    { "light.lamp_badkamer_2_plafond_3",         "Badkamer 3" },
};

/* ---- Tab: Zolder (attic) ------------------------------------------------ */
static const panel_entity_t TAB_ZOLDER_LIGHTS[] = {
    { "light.lamp_zolder_gang",         "Gang" },
    { "light.lamp_zolder_baby_kamer_1", "Baby 1" },
    { "light.lamp_zolder_baby_kamer_2", "Baby 2" },
};
static const panel_entity_t TAB_ZOLDER_DEVICES[] = {
    { "light.lamp_zolder_gang",         "Gang" },
    { "light.lamp_zolder_baby_kamer_1", "Baby 1" },
    { "light.lamp_zolder_baby_kamer_2", "Baby 2" },
};

#define TAB_ENTRY(name, lights, scenes, devices) \
    { name, lights, sizeof(lights) / sizeof((lights)[0]), \
      scenes, sizeof(scenes) / sizeof((scenes)[0]), \
      devices, sizeof(devices) / sizeof((devices)[0]), NULL, NULL, 0, false }

/* Scene tab: scenes are the tiles (with icons and/or colour swatches; either
 * may be NULL), the bottom row shows the active scene plus a power toggle for
 * lights[0]. More than 6 scenes -> compact 4x3 tiles. */
#define TAB_ENTRY_SCENES(name, lights, scenes, icons, swatches, quick, devices) \
    { name, lights, sizeof(lights) / sizeof((lights)[0]), \
      scenes, sizeof(scenes) / sizeof((scenes)[0]), \
      devices, sizeof(devices) / sizeof((devices)[0]), icons, swatches, quick, true }

/* ---- Tab: Garage -------------------------------------------------------- */
/* 17 colour bulbs driven by scenes: four white levels, then colour moods. The
 * power toggle in the bottom row and the brightness slider act on the group. */
static const panel_entity_t TAB_GARAGE_LIGHTS[] = {
    { "light.lampen_garage", "Garage" },
};
static const panel_entity_t TAB_GARAGE_SCENES[] = {
    { "scene.garage_fel",              "Fel" },
    { "scene.garage_half",             "Half" },
    { "scene.garage_gedimd",           "Gedimd" },
    { "scene.garage_warm",             "Warm" },
    { "scene.garage_oranje",           "Oranje" },
    { "scene.garage_rood",             "Rood" },
    { "scene.garage_blauw",            "Blauw" },
    { "scene.garage_rood_blauw",       "Rood blauw" },
    { "scene.garage_pink_paars_groen", "Roze paars" },
    { "scene.garage_cuba",             "Cuba" },
    { "scene.garage_regenboog",        "Regenboog" },
};
/* Swatch per scene, same order as TAB_GARAGE_SCENES. */
static const panel_swatch_t TAB_GARAGE_SWATCHES[] = {
    { 0xffffff, 0 },        /* Fel */
    { 0xaeb3bd, 0 },        /* Half */
    { 0x5a5f6a, 0 },        /* Gedimd */
    { 0xffb46b, 0 },        /* Warm */
    { 0xff8a1f, 0 },        /* Oranje */
    { 0xe0323c, 0 },        /* Rood */
    { 0x3b6cff, 0 },        /* Blauw */
    { 0xe0323c, 0x3b6cff }, /* Rood blauw */
    { 0xff5fb4, 0x39d98a }, /* Roze paars groen */
    { 0x1fb8a6, 0xffc857 }, /* Cuba */
    { SWATCH_RAINBOW, 0 },  /* Regenboog */
};
static const panel_entity_t TAB_GARAGE_DEVICES[] = {
    /* HA has no lamp_garage_4 / _10 (the numbers were skipped); 18-21 are Innr GU10s added 2026-09-09. */
    { "light.lamp_garage_1",  "Lamp 1" },  { "light.lamp_garage_2",  "Lamp 2" },
    { "light.lamp_garage_3",  "Lamp 3" },  { "light.lamp_garage_5",  "Lamp 5" },
    { "light.lamp_garage_6",  "Lamp 6" },  { "light.lamp_garage_7",  "Lamp 7" },
    { "light.lamp_garage_8",  "Lamp 8" },  { "light.lamp_garage_9",  "Lamp 9" },
    { "light.lamp_garage_11", "Lamp 11" },  { "light.lamp_garage_12", "Lamp 12" },
    { "light.lamp_garage_13", "Lamp 13" },  { "light.lamp_garage_14", "Lamp 14" },
    { "light.lamp_garage_15", "Lamp 15" },  { "light.lamp_garage_16", "Lamp 16" },
    { "light.lamp_garage_17", "Lamp 17" },  { "light.lamp_garage_18", "Lamp 18" },
    { "light.lamp_garage_19", "Lamp 19" },  { "light.lamp_garage_20", "Lamp 20" },
    { "light.lamp_garage_21", "Lamp 21" },
};

/* ---- Tab: Tuin (garden) --- not shown yet ------------------------------- */
/* HA has no garden lights (scene.twingly points at a dead light.ilse), so a
 * Tuin tab would only show placeholder tiles. Add a TAB_ENTRY once real garden
 * entities exist. */

/* Tab with no scenes (just the tiles + "Alle lampen" drawer). */
#define TAB_ENTRY_NS(name, lights, devices) \
    { name, lights, sizeof(lights) / sizeof((lights)[0]), \
      NULL, 0, devices, sizeof(devices) / sizeof((devices)[0]), NULL, NULL, 0, false }

static const panel_tab_t PANEL_TABS[] = {
    TAB_ENTRY_SCENES("Beneden", TAB_THUIS_LIGHTS, TAB_THUIS_SCENES, TAB_THUIS_ICONS,
                     TAB_THUIS_SWATCHES, 2, TAB_THUIS_DEVICES),
    TAB_ENTRY("Boven", TAB_BOVEN_LIGHTS, TAB_BOVEN_SCENES, TAB_BOVEN_DEVICES),
    TAB_ENTRY_NS("Zolder", TAB_ZOLDER_LIGHTS, TAB_ZOLDER_DEVICES),
    TAB_ENTRY_SCENES("Garage", TAB_GARAGE_LIGHTS, TAB_GARAGE_SCENES, NULL, TAB_GARAGE_SWATCHES, 0,
                     TAB_GARAGE_DEVICES),
};
#define PANEL_TAB_COUNT (sizeof(PANEL_TABS) / sizeof(PANEL_TABS[0]))

/* Upper bound for the tile registry / subscribe list (main tiles + drawer
 * devices + scene-tab power toggles) */
#define PANEL_MAX_LIGHTS 96

/* Media players (WiiM) whose "now playing" shows in the screensaver while one
 * of them is playing. First playing one wins. */
static const panel_entity_t PANEL_MEDIA_PLAYERS[] = {
    { "media_player.living_room", "Woonkamer" },
    { "media_player.kitchen",     "Keuken" },
    { "media_player.media_room",  "Media room" },
};
#define PANEL_MEDIA_COUNT (sizeof(PANEL_MEDIA_PLAYERS) / sizeof(PANEL_MEDIA_PLAYERS[0]))

/* Weather entity shown in the header */
#define PANEL_WEATHER_ENTITY "weather.buienradar"

/* Climate sensors shown in the header next to the weather forecast: a
 * temperature entity (°C) with an optional humidity entity (%). Order =
 * display order. The header fits five columns next to a 4-day forecast. */
typedef struct {
    const char *temp_id;
    const char *humidity_id; /* NULL = no humidity line */
    const char *label;
    const char *abbr;        /* 3-letter tag for compact views (screensaver) */
    bool indoor;             /* colour the readings against the comfort bands below */
} panel_sensor_t;

/* Comfort bands (indoor sensors only): temperature 19-24 C is green, below is
 * blue, above is orange, above 26 red. Humidity 40-60 % is green, outside is
 * orange, more than 10 points outside (below 30 / above 70) is red. */
#define COMFORT_TEMP_MIN     19.0f
#define COMFORT_TEMP_MAX     24.0f
#define COMFORT_TEMP_HOT     26.0f
#define COMFORT_HUM_MIN      40.0f
#define COMFORT_HUM_MAX      60.0f
#define COMFORT_HUM_MARGIN   10.0f
static const panel_sensor_t PANEL_TEMP_SENSORS[] = {
    { "sensor.sensor_buiten_voor_1_temperature",
      "sensor.sensor_buiten_voor_1_humidity",           "Buiten",    "BUI", false },
    /* Z2M "sensor voorkamer 1" (0xa4c138c1a5a2f0aa) sits in the zitkamer. */
    { "sensor.sensor_voorkamer_1_temperature",
      "sensor.sensor_voorkamer_1_humidity",             "Zitkamer",  "ZIT", true },
    { "sensor.sensor_keuken_1_temperature",
      "sensor.sensor_keuken_1_humidity",                "Keuken",    "KEU", true },
    /* Z2M "sensor zitkamer achter 1" is the gameroom (playroom). */
    { "sensor.sensor_zitkamer_achter_1_temperature",
      "sensor.sensor_zitkamer_achter_1_humidity",       "Gameroom",  "GAM", true },
    { "sensor.sensor_zolder_1_temperature",
      "sensor.sensor_zolder_1_humidity",                "Zolder",    "ZOL", true },
};
#define PANEL_TEMP_SENSOR_COUNT (sizeof(PANEL_TEMP_SENSORS) / sizeof(PANEL_TEMP_SENSORS[0]))

/* Air-quality monitors: every reading of the device (CO2, PM2.5, the device's
 * own quality verdict, temperature, humidity). Shown in the web app's header
 * next to the climate sensors, with a 24 h CO2/PM2.5 chart on tap. The panel's
 * own 800 px header has no room left, so the firmware does not display these. */
typedef struct {
    const char *label;       /* popup title */
    const char *short_label; /* header column */
    const char *abbr;        /* screensaver tag */
    const char *co2_id;      /* ppm */
    const char *pm25_id;     /* ug/m3 */
    const char *quality_id;  /* enum: good fair moderate poor very_poor extremely_poor */
    const char *temp_id;     /* C */
    const char *humidity_id; /* % */
} panel_air_sensor_t;

/* Bands: CO2 up to 800 ppm is fresh, above 1200 ppm is stale; PM2.5 up to the
 * WHO 24 h guideline of 15 ug/m3 is good, above 35 is poor. The ALPSTUGA
 * reports 0 ppm while its CO2 sensor warms up after a restart, so readings
 * below AIR_CO2_MIN_VALID are shown as "no value yet". */
#define AIR_CO2_GOOD       800.0f
#define AIR_CO2_POOR       1200.0f
#define AIR_CO2_MIN_VALID  250.0f
#define AIR_PM25_GOOD      15.0f
#define AIR_PM25_POOR      35.0f
static const panel_air_sensor_t PANEL_AIR_SENSORS[] = {
    /* IKEA ALPSTUGA (Matter over Thread), commissioned 2026-09-13. */
    { "Luchtkwaliteit keuken", "Lucht keuken", "CO2",
      "sensor.luchtkwaliteit_keuken_carbon_dioxide",
      "sensor.luchtkwaliteit_keuken_pm2_5",
      "sensor.luchtkwaliteit_keuken_air_quality",
      "sensor.luchtkwaliteit_keuken_temperature",
      "sensor.luchtkwaliteit_keuken_humidity" },
};
#define PANEL_AIR_SENSOR_COUNT (sizeof(PANEL_AIR_SENSORS) / sizeof(PANEL_AIR_SENSORS[0]))

/* Robot vacuum: the web app's "Schoonmaak" section (the panel's firmware does
 * not show it). Room cleaning goes straight to the robot via
 * xiaomi_miot call_action: siid 17 aiid 1 start-clean with clean-type 3
 * (AreaClean) and clean-values as a JSON list of room ids, e.g. "[8,5]" -- the
 * value the robot itself reported for a two-room run on 2026-09-13. Room names
 * live only in the Xiaomi cloud map, so they are set here by hand. */
typedef struct {
    int id;            /* room id on the robot's map */
    const char *label;
} panel_room_t;

typedef struct {
    const char *label;
    const char *vacuum_id;  /* vacuum entity (start / pause / return_to_base) */
    const char *status_id;  /* text status sensor */
    const char *battery_id; /* % */
    const char *area_id;    /* m2 cleaned in the current run */
    const char *mode_id;    /* select: sweep / mop combination */
    const char *fan_id;     /* select: suction */
    const char *water_id;   /* select: water flow */
    const char *locate_id;  /* button: make the robot play a sound */
} panel_vacuum_t;

/* Ids seen in the robot's clean-values on 2026-09-13 (4, 5, 7, 8); the names
 * are placeholders until the rooms are identified. */
static const panel_room_t PANEL_VACUUM_ROOMS[] = {
    { 4, "Kamer 4" },
    { 5, "Kamer 5" },
    { 7, "Kamer 7" },
    { 8, "Kamer 8" },
};
static const panel_vacuum_t PANEL_VACUUM = {
    "Stofzuiger",
    "vacuum.stofzuiger_xiaomi_robot_cleaner",
    "sensor.stofzuiger_xiaomi_status",
    "sensor.stofzuiger_xiaomi_battery_level",
    "sensor.stofzuiger_xiaomi_clean_area",
    "select.stofzuiger_xiaomi_clean_mode",
    "select.stofzuiger_xiaomi_fan_mode",
    "select.stofzuiger_xiaomi_water_mode",
    "button.stofzuiger_xiaomi_seek_robot",
};

/* Web app layout (the panel's firmware keeps its own tabs). The top tabs are
 * sections; "Verlichting" shows one floor at a time, picked with the vertical
 * floor buttons on the left. Floors refer to tabs in PANEL_TABS by name. */
typedef struct {
    const char *tab;   /* PANEL_TABS entry with that floor's lights and scenes */
    const char *label; /* button text */
    const char *name;  /* caption under the button */
} panel_floor_t;
static const panel_floor_t PANEL_FLOORS[] = {
    { "Beneden", "0", "Begane grond" },
    { "Boven",   "1", "1e verdieping" },
    { "Zolder",  "2", "Zolder" },
};

typedef struct {
    const char *name;
    const char *kind; /* "floors", "vacuum", or "tab" (one PANEL_TABS entry) */
    const char *tab;  /* for "tab": the PANEL_TABS name */
} panel_section_t;
static const panel_section_t PANEL_SECTIONS[] = {
    { "Verlichting", "floors", NULL },
    { "Schoonmaak",  "vacuum", NULL },
    { "Garage",      "tab",    "Garage" },
};
