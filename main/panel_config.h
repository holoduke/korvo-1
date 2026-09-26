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
    /* Dinner, fridge (a dim night light), kitchen and party: created in HA's
     * scene editor on 2026-09-13. Shown with swatches of their light. */
    { "scene.beneden_dinner",        "Diner" },
    { "scene.beneden_fridge",        "Koelkast" },
    { "scene.beneden_kitchen",       "Keuken" },
    { "scene.beneden_party",         "Party" },
    /* Quick buttons (bottom row): every ground-floor light on at minimum /
     * full brightness. Scenes created in HA's scene editor on 2026-09-06. */
    { "scene.woonkamer_min",         "Min" },
    { "scene.woonkamer_max",         "Max" },
};
/* Tile icons, same order as TAB_THUIS_SCENES. */
static const char *const TAB_THUIS_ICONS[] = {
    LV_SYMBOL_CHARGE, LV_SYMBOL_EYE_CLOSE, LV_SYMBOL_EYE_OPEN, LV_SYMBOL_TINT, LV_SYMBOL_POWER,
    NULL, NULL, NULL, NULL, NULL, LV_SYMBOL_MINUS, LV_SYMBOL_PLUS,
};
/* Swatches, same order; 0 = use the icon instead. */
static const panel_swatch_t TAB_THUIS_SWATCHES[] = {
    { 0, 0 }, { 0, 0 }, { 0, 0 }, { 0, 0 }, { 0, 0 },
    { 0x1fb8a6, 0xffc857 }, /* Cuba: teal -> gold */
    { 0xff8a2a, 0xffc27a }, /* Diner: warm white (2200 K) */
    { 0x6b3d17, 0 },        /* Koelkast: dim warm night light */
    { 0xfff1dc, 0 },        /* Keuken: neutral white (4000 K) */
    { 0xa020f0, 0x2f50ff }, /* Party: purple -> blue */
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
/* First floor (2026-09-13, completed 2026-09-26): every lamp there, by room.
 * The back bedroom is Gillis en Ilse's, the two front rooms Valerie's and
 * Naomi's. The bathroom ceiling's plafond 2 and 3 are IKEA KAJPLATS bulbs over
 * Matter (2026-09-26); plafond 1 is the old Zigbee bulb. The bedside and floor
 * lamps are often off at the wall, so they show as out of reach. Left out:
 * light.lamp_slaapkamer_gillis_ilse, an old pairing last seen in April. */
static const panel_entity_t TAB_BOVEN_LIGHTS[] = {
    { "light.lamp_gang_boven_plafond_1",          "Gang plafond 1" },
    { "light.lamp_gang_boven_plafond_2",          "Gang plafond 2" },
    { "light.lamp_gang_boven_plafond_3",          "Gang plafond 3" },
    { "light.lamp_gang_boven_plafond_4",          "Gang plafond 4" },
    { "light.lamp_slaapkamer_plafond_achter_1",   "Gillis en Ilse plafond" },
    { "light.lamp_slaapkamer_achter_nachtkast_1", "Gillis en Ilse nachtkast" },
    { "light.lamp_gillis_ilse_nachtkasje_lamp_gillis_ilse_nachtkasje", "Gillis en Ilse nachtkast 2" },
    { "light.lamp_slaapkamer_achter_1",           "Gillis en Ilse lamp" },
    { "light.lamp_slaapkamer_staand_ilse_gillis", "Gillis en Ilse staande lamp" },
    { "light.lamp_slaapkamer_staand_ilse_gillis_2", "Gillis en Ilse staande lamp 2" },
    { "light.lamp_valerie_kamer_1",               "Valerie" },
    { "light.lamp_jongens_kamer_1",               "Naomi" },
    { "light.lamp_badkamer_2_plafond_1",          "Badkamer plafond 1" },
    { "light.lamp_badkamer_2_plafond_2",          "Badkamer plafond 2" },
    { "light.lamp_badkamer_2_plafond_3",          "Badkamer plafond 3" },
    { "light.lamp_badkamer_3",                    "Badkamer lamp" },
    { "light.lamp_badkamer_muur_1",               "Badkamer muur 1" },
    { "light.lamp_badkamer_muur_2",               "Badkamer muur 2" },
    { "light.lamp_badkamer_spiegel_1",            "Badkamer spiegel" },
    { "light.lamp_kledingkast_plafond_1",         "Kledingkast 1" },
    { "light.lamp_kledingkast_plafond_2",         "Kledingkast 2" },
};
static const panel_entity_t TAB_BOVEN_SCENES[] = {
    { "scene.slaapkamer_aan",     "Slaapk. aan" },
    { "scene.slaapkamer_aan_fel", "Slaapk. fel" },
    { "scene.slaapkamer_uit",     "Slaapk. uit" },
};
static const panel_entity_t TAB_BOVEN_DEVICES[] = {
    { "light.lamp_gang_boven_plafond_1",          "Gang plafond 1" },
    { "light.lamp_gang_boven_plafond_2",          "Gang plafond 2" },
    { "light.lamp_gang_boven_plafond_3",          "Gang plafond 3" },
    { "light.lamp_gang_boven_plafond_4",          "Gang plafond 4" },
    { "light.lamp_slaapkamer_plafond_achter_1",   "Gillis en Ilse plafond" },
    { "light.lamp_slaapkamer_achter_nachtkast_1", "Gillis en Ilse nachtkast" },
    { "light.lamp_gillis_ilse_nachtkasje_lamp_gillis_ilse_nachtkasje", "Gillis en Ilse nachtkast 2" },
    { "light.lamp_slaapkamer_achter_1",           "Gillis en Ilse lamp" },
    { "light.lamp_slaapkamer_staand_ilse_gillis", "Gillis en Ilse staande lamp" },
    { "light.lamp_slaapkamer_staand_ilse_gillis_2", "Gillis en Ilse staande lamp 2" },
    { "light.lamp_valerie_kamer_1",               "Valerie" },
    { "light.lamp_jongens_kamer_1",               "Naomi" },
    { "light.lamp_badkamer_2_plafond_1",          "Badkamer plafond 1" },
    { "light.lamp_badkamer_2_plafond_2",          "Badkamer plafond 2" },
    { "light.lamp_badkamer_2_plafond_3",          "Badkamer plafond 3" },
    { "light.lamp_badkamer_3",                    "Badkamer lamp" },
    { "light.lamp_badkamer_muur_1",               "Badkamer muur 1" },
    { "light.lamp_badkamer_muur_2",               "Badkamer muur 2" },
    { "light.lamp_badkamer_spiegel_1",            "Badkamer spiegel" },
    { "light.lamp_kledingkast_plafond_1",         "Kledingkast 1" },
    { "light.lamp_kledingkast_plafond_2",         "Kledingkast 2" },
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
    /* Z2M "sensor zolder 1" hangs on the attic landing. */
    { "sensor.sensor_zolder_1_temperature",
      "sensor.sensor_zolder_1_humidity",                "Zoldergang", "ZGA", true },
    { "sensor.sensor_zolder_voorkamer_1_temperature",
      "sensor.sensor_zolder_voorkamer_1_humidity",      "Zolder voor", "ZVO", true },
    { "sensor.sensor_zolder_achterkamer_1_temperature",
      "sensor.sensor_zolder_achterkamer_1_humidity",    "Zolder achter", "ZAC", true },
    { "sensor.sensor_garage_1_temperature",
      "sensor.sensor_garage_1_humidity",                "Garage",    "GAR", true },
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
    /* selects that change mode, suction and water: xiaomi_miot exposes the
     * robot's set-*-mode actions for these, because the xm2216 does not answer
     * writes to the properties above (it only reports them) */
    const char *set_mode_id;
    const char *set_fan_id;
    const char *set_water_id;
    const char *locate_id;  /* button: make the robot play a sound */
    const char *rooms_domain; /* HA integration with stofzuig(gebieden) and naar_station */
    const char *floor;        /* web app: the PANEL_FLOORS label of the floor it cleans */
} panel_vacuum_t;

/* Room numbers as the robot knows them; the same table lives under
 * "robotkamers: kamers:" in Home Assistant's configuration.yaml. */
static const panel_room_t PANEL_VACUUM_ROOMS[] = {
    { 5, "Keuken" },
    { 8, "Eetkamer" },
    { 3, "Zitkamer achter" },
    { 7, "Gameroom" },
    { 9, "Gang" },
    { 4, "Garage" },
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
    "select.stofzuiger_xiaomi_set_clean_mode",
    "select.stofzuiger_xiaomi_set_fan_mode",
    "select.stofzuiger_xiaomi_set_water_mode",
    "button.stofzuiger_xiaomi_seek_robot",
    "robotkamers",
    "0",
};

/* More robot vacuums in the web app's Schoonmaak section, one per floor next to
 * PANEL_VACUUM (the panel's firmware does not show them): Tuya Local robots
 * (the ILIFE A30 Pro upstairs, set up with tuya-local's ilife_v30_vacuum
 * config: the same data points, and more of them than its A30 Pro config).
 * name is the device's part of its entity ids (vacuum.<name>,
 * sensor.<name>_battery, ...); floor is the PANEL_FLOORS label of the floor it
 * cleans, which also picks it on the page's floor rail. */
typedef struct {
    const char *label;
    const char *floor;
    const char *name;
} panel_tuya_vacuum_t;
static const panel_tuya_vacuum_t PANEL_TUYA_VACUUMS[] = {
    { "Stofzuiger boven", "1", "stofzuiger" },
};

/* E-bike in the web app's header: battery, where it is, lock and speed
 * (Stromer integration; the panel's firmware does not show it). */
typedef struct {
    const char *label;
    const char *battery_id;  /* % */
    const char *location_id; /* device_tracker: home / not_home / zone name */
    const char *lock_id;     /* binary_sensor: on = locked */
    const char *speed_id;    /* km/h */
} panel_bike_t;
static const panel_bike_t PANEL_BIKE = {
    "Fiets",
    "sensor.st7_battery",
    "device_tracker.st7_location",
    "binary_sensor.st7_bike_lock",
    "sensor.st7_bike_speed",
};

/* Car in the web app (header column and the Tesla section; the panel's
 * firmware does not show it). Tesla Fleet names every entity after the car,
 * e.g. sensor.vlm_battery_level; tools/gen_web_config.py derives the full
 * set from that name. */
typedef struct {
    const char *label;
    const char *name; /* the car's name in its entity ids */
} panel_car_t;
static const panel_car_t PANEL_CAR = { "Tesla", "vlm" };

/* Rooms of a floor, as buttons in the web app's bottom row (the panel's
 * firmware ignores this). A room filters the floor's lamp list to its own
 * lamps and scopes the brightness slider to them; its scenes (PANEL_AREA_SCENES)
 * replace the floor's while it is chosen, if it has any.
 * Lamps are space-separated entity ids. */
typedef struct {
    const char *tab;    /* PANEL_TABS name of the floor */
    const char *label;
    const char *lights;
} panel_area_t;
static const panel_area_t PANEL_AREAS[] = {
    { "Beneden", "Keuken", "light.lamp_keuken_plafond_1 light.lamp_keuken_plafond_2 light.lamp_keuken_plafond_3 light.lamp_keuken_plafond_4 light.lamp_keuken_plafond_5 light.lamp_keuken_plafond_6 light.lamp_keuken_plafond_7 light.lamp_keuken_muur_1 light.lamp_keuken_muur_2 light.lamp_keuken_muur_3" },
    { "Beneden", "Eetkamer", "light.lamp_keuken_eettafel_1" },
    { "Beneden", "Zitkamer", "light.lamp_zitkamer_voor_1 light.lamp_zitkamer_voor_2 light.lamp_zitkamer_1 light.lamp_grond_1 light.lamp_woonkamer_kubus_1 light.lamp_valerie_rieten_1" },
    { "Beneden", "Zitk. achter", "light.lamp_zitkamer_achter_1 light.lamp_zitkamer_achter_2 light.lamp_zitkamer_achter_3 light.lamp_zitkamer_achter_muur_1 light.lamp_zitkamer_achter_muur_2" },
    { "Beneden", "Gameroom", "light.lamp_playroom_1 light.lamp_playroom_led_1 light.lamp_playroom_muur_1 light.lamp_playroom_muur_2 light.lamp_playroom_muur_3" },
    { "Beneden", "Gang", "light.lamp_gang_plafond_1 light.lamp_gang_plafond_2 light.lamp_gang_plafond_3 light.lamp_gang_deur_1 light.lamp_gang_trap_beneden_1 light.lamp_wc_beneden_1" },
    { "Beneden", "Buiten", "light.lamp_buiten_1" },
    /* lamp_slaapkamer_gillis_ilse: the old ceiling lamp, gone but still in the bedroom's scenes */
    { "Boven", "Gillis en Ilse", "light.lamp_slaapkamer_plafond_achter_1 light.lamp_slaapkamer_achter_nachtkast_1 light.lamp_gillis_ilse_nachtkasje_lamp_gillis_ilse_nachtkasje light.lamp_slaapkamer_achter_1 light.lamp_slaapkamer_staand_ilse_gillis light.lamp_slaapkamer_staand_ilse_gillis_2 light.lamp_slaapkamer_gillis_ilse" },
    { "Boven", "Valerie", "light.lamp_valerie_kamer_1" },
    { "Boven", "Naomi", "light.lamp_jongens_kamer_1" },
    { "Boven", "Badkamer", "light.lamp_badkamer_2_plafond_1 light.lamp_badkamer_2_plafond_2 light.lamp_badkamer_2_plafond_3 light.lamp_badkamer_3 light.lamp_badkamer_muur_1 light.lamp_badkamer_muur_2 light.lamp_badkamer_spiegel_1" },
    /* the wardrobe lamps go with the landing: its scenes set them too */
    { "Boven", "Gang", "light.lamp_gang_boven_plafond_1 light.lamp_gang_boven_plafond_2 light.lamp_gang_boven_plafond_3 light.lamp_gang_boven_plafond_4 light.lamp_kledingkast_plafond_1 light.lamp_kledingkast_plafond_2" },
    { "Zolder", "Gang", "light.lamp_zolder_gang light.lamp_zolder_tussengang_1" },
    { "Zolder", "Babykamer", "light.lamp_zolder_baby_kamer_1 light.lamp_zolder_baby_kamer_2" },
    { "Zolder", "Voorkamer", "light.lamp_zolder_voorkamer_1" },
    { "Zolder", "Achterkamer", "light.lamp_zolder_achterkamer_1" },
};

/* Scenes of one room, in the web app only (the panel's firmware keeps its
 * tabs' scenes). They join their floor's scenes under the room's name, and a
 * room chosen in the bottom row shows just its own. The bathroom's are for
 * its three ceiling globes and two wall lamps, the landing's for its four
 * ceiling lamps and the wardrobe's two (packages/gang_boven.yaml: the six
 * lamps hang on a relay, which its script switches on before the scene). */
typedef struct {
    const char *tab;    /* PANEL_TABS name of the floor */
    const char *area;   /* PANEL_AREAS label of the room */
    const char *id;
    const char *label;
    uint32_t swatch_a;  /* as panel_swatch_t, for a scene whose stored states HA's */
    uint32_t swatch_b;  /* config API cannot give (a YAML scene); 0 = none */
    const char *script; /* NULL, or a script that sets the scene, given it as `scene` */
} panel_area_scene_t;
static const panel_area_scene_t PANEL_AREA_SCENES[] = {
    { "Boven", "Badkamer", "scene.badkamer_heel_warm",       "Heel warm",     0,        0,        NULL },
    { "Boven", "Badkamer", "scene.badkamer_beetje_warm",     "Beetje warm",   0,        0,        NULL },
    { "Boven", "Badkamer", "scene.badkamer_vol_aan",         "Vol aan",       0,        0,        NULL },
    { "Boven", "Badkamer", "scene.badkamer_party",           "Party",         0,        0,        NULL },
    { "Boven", "Badkamer", "scene.badkamer_erotisch",        "Erotisch",      0,        0,        NULL },
    { "Boven", "Badkamer", "scene.badkamer_blauw",           "Blauw",         0,        0,        NULL },
    { "Boven", "Badkamer", "scene.badkamer_groen",           "Groen",         0,        0,        NULL },
    { "Boven", "Gang",     "scene.gang_boven_hoog",          "Hoog",          0xffe2c0, 0,        "script.gang_boven_scene" },
    { "Boven", "Gang",     "scene.gang_boven_helder_warm",   "Helder warm",   0xffc27a, 0,        "script.gang_boven_scene" },
    { "Boven", "Gang",     "scene.gang_boven_laag",          "Laag",          0x9c6a34, 0,        "script.gang_boven_scene" },
    { "Boven", "Gang",     "scene.gang_boven_sfeervol",      "Sfeervol",      0xd97a26, 0x6e3f14, "script.gang_boven_scene" },
    { "Boven", "Gang",     "scene.gang_boven_zonsondergang", "Zonsondergang", 0xff7814, 0xff9a3c, "script.gang_boven_scene" },
    { "Boven", "Gang",     "scene.gang_boven_avond_paars",   "Avond paars",   0x8f3cff, 0xb450ff, "script.gang_boven_scene" },
    { "Boven", "Gang",     "scene.gang_boven_nacht",         "Nacht",         0x7a1600, 0,        "script.gang_boven_scene" },
};

/* Appliances in the web app's "Apparaten" section (the panel's firmware does
 * not show them). kind selects the integration's entity naming, name is the
 * device's part of its entity ids (e.g. "wasruimte_wasmachine" in
 * sensor.wasruimte_wasmachine_job_state); tools/gen_web_config.py derives the
 * rest. Kinds: washer, dryer (SmartThings), dishwasher, oven, hob (Home
 * Connect via hcpy), filter (ATAG plasma filter over MQTT), fridge (Liebherr),
 * tv (a DLNA media player; a Wake on LAN button named button.<name>_aanzetten
 * switches it on), speakers (WiiM: name lists the players' object ids,
 * each also in PANEL_MEDIA_PLAYERS, which gives their labels), robot (a
 * robot vacuum from the Schoonmaak section, PANEL_VACUUM or
 * PANEL_TUYA_VACUUMS: name is the PANEL_FLOORS label of the floor it cleans)
 * and pc (a Windows pc behind a template switch switch.<name>: on wakes it
 * over the network, off puts it to sleep; binary_sensor.<name>_online pings it). */
typedef struct {
    const char *kind;
    const char *label;
    const char *name;
} panel_appliance_t;
static const panel_appliance_t PANEL_APPLIANCES[] = {
    /* The two PCs first: switched most from the panel. */
    { "pc",         "PC-Defender", "no_defender" },
    { "pc",         "PC-430",      "garage430" },
    { "heatpump",   "Warmtepomp",  "f1253_6_r_pc_em" }, /* NIBE F1253-6, nibe_heatpump over Modbus */
    { "washer",     "Wasmachine", "wasruimte_wasmachine" },
    { "dryer",      "Droger",     "wasruimte_droger" },
    { "dishwasher", "Vaatwasser", "dishwasher" },
    { "oven",       "Oven",       "oven" },
    { "filter",     "Filter",     "atag_plasmafilter" },
    { "hob",        "Kookplaat",  "hob" },
    { "fridge",     "Koelkast",   "koelkast_1" },
    { "speakers",   "WiiM",       "living_room kitchen media_room" },
    { "tv",         "Samsung TV", "signage_big_ass_tv" },
    { "robot",      "Stofzuiger beneden", "0" },
    { "robot",      "Stofzuiger boven",   "1" },
};

/* Health (the web app's Instellingen and the house readout): the Zigbee
 * bridge and the internet connection, as Home Assistant reports them. */
#define PANEL_ZIGBEE_BRIDGE "binary_sensor.zigbee2mqtt_bridge_connection_state"
#define PANEL_INTERNET      "binary_sensor.internetbox_wan_status"
/* Rain over the house right now: Buienradar's radar nowcast at the house's
 * coordinates (mm/h over the next 10 minutes), not a weather station's condition. */
#define PANEL_RAIN_NOW      "sensor.buienradar_precipitation_forecast_average"

/* Sensor cards in the web app's "Sensoren" section (the panel's firmware does
 * not show them): kind selects which entities a device has, name is the
 * device's part of its entity ids (Zigbee2MQTT names, e.g. "sensor_keuken_1"
 * in sensor.sensor_keuken_1_temperature); tools/gen_web_config.py derives the
 * rest. Kinds: presence (mmWave presence with temperature, humidity and light),
 * motion (PIR), door (contact), window (a contact on a window), air (air quality monitor), climate
 * (temperature and humidity), plant (a soil sensor in a pot: moisture, dry, and the air). Order =
 * display order within each group. */
typedef struct {
    const char *kind;
    const char *label;
    const char *name;
} panel_sensor_card_t;
static const panel_sensor_card_t PANEL_SENSOR_CARDS[] = {
    { "presence", "Gang beneden",     "sensor_aanwezigheid_gang_beneden_1" },
    { "presence", "Garage",           "sensor_aanwezigheid_garage_1" },
    { "presence", "Aanwezigheid",     "sensor_aanwezigheid_1" },
    { "motion",   "Beweging",         "bewegingssensor_1" },
    { "motion",   "Beweging kast",    "bewegingssensor_kast_2" },
    { "door",     "Garage tussendeur", "sensor_deur_garage_1" }, /* the door from the big room into the garage */
    { "door",     "Garagedeur 2",     "sensor_deur_garage_2" },
    { "door",     "Voordeur",         "sensor_deur_voordeur_1" }, /* IKEA MYGGBETT over Thread: no tamper contact */
    { "door",     "Schuifpui keuken", "sensor_deur_keuken_1" },   /* idem */
    { "door",     "Deur gameroom",    "sensor_deur_gameroom_buiten_1" }, /* idem, the door out at the back */
    { "door",     "Meterkast",        "sensor_deur_meterkast_1" }, /* idem, the meter cupboard in the hall */
    { "window",   "Raam gameroom",    "sensor_raam_gameroom_klapraam_1" }, /* idem, the top-hung window beside it */
    { "window",   "Raam Valerie 1",   "sensor_raam_valerie_1" }, /* idem, the big front bedroom upstairs: its two windows, */
    { "window",   "Raam Valerie 2",   "sensor_raam_valerie_2" }, /* left and right seen from inside */
    { "window",   "Raam Naomi links",  "sensor_raam_voorkamer_boven_links_1" }, /* idem, the small front bedroom upstairs: */
    { "window",   "Raam Naomi rechts", "sensor_deur_voorkamer_boven_links_1" }, /* the two panes of its window, seen from inside */
    { "window",   "Raam gameroom zij", "sensor_raam_gameroom_zijkant_1" }, /* idem, the side pane of the corner window */
    { "window",   "Raam achterkamer Gillis en Ilse 1", "sensor_raam_achterkamer_boven_1" }, /* idem, the back bedroom upstairs: */
    { "window",   "Raam achterkamer Gillis en Ilse 2", "sensor_raam_achterkamer_boven_2" }, /* the two panes of its right-hand window, */
    { "window",   "Raam achterkamer Gillis en Ilse 3", "sensor_raam_achterkamer_boven_3" }, /* and the two of the left-hand one */
    { "window",   "Raam achterkamer Gillis en Ilse 4", "sensor_raam_achterkamer_boven_4" },
    { "air",      "Lucht keuken",     "luchtkwaliteit_keuken" },
    { "climate",  "Voorkamer",        "sensor_voorkamer_1" },
    { "climate",  "Zitkamer achter",  "sensor_zitkamer_achter_1" },
    { "climate",  "Keuken",           "sensor_keuken_1" },
    /* the three bedrooms on the first floor (added 2026-09-24); web only, the
     * firmware's header has no room for them */
    { "climate",  "Naomi",            "sensor_naomi_1" },
    { "climate",  "Valerie",          "sensor_valerie_1" },
    { "climate",  "Gillis en Ilse",   "sensor_achterkamer_boven_1" },
    { "climate",  "Zoldergang",       "sensor_zolder_1" },
    { "climate",  "Zolder voor",      "sensor_zolder_voorkamer_1" },
    { "climate",  "Zolder achter",    "sensor_zolder_achterkamer_1" },
    { "climate",  "Garage",           "sensor_garage_1" },
    { "climate",  "Buiten voor",      "sensor_buiten_voor_1" },
    /* two soil sensors in plant pots (AOYAN AY-303Z, added 2026-09-24) */
    { "plant",    "Plant voorkamer",  "sensor_plant_voorkamer_1" },
    { "plant",    "Plant zitkamer achter", "sensor_plant_zitkamer_achter_1" },
};

/* Doors the web app drives (the firmware does not show them): a cover entity
 * with open, close and stop, an optional button that puts it in a partly open
 * ventilation position, the lighting tab whose page shows its controls, and
 * the keyed opening in the 3D house (web/js/house-plan.js) that is this door:
 * a tap on it there opens the same controls. */
typedef struct {
    const char *label;
    const char *tab;     /* a PANEL_TABS name */
    const char *opening; /* an opening key in the house plan */
    const char *cover;   /* cover.* */
    const char *vent;    /* button.* for the ventilation position, or NULL */
} panel_cover_t;
static const panel_cover_t PANEL_COVERS[] = {
    { "Garagedeur", "Garage", "garagedeur", "cover.garagedeur", "button.garagedeur_ventilatie" },
};

/* The web app's "Energie" section (the panel's firmware does not show it): one
 * row per meter, device or battery; kind selects which entities it has, name
 * is the device's part of its entity ids; tools/gen_web_config.py derives the
 * rest. Kinds:
 *   grid     the smart meter, with the entity names of Home Assistant's DSMR
 *            integration (sensor.<name>_power_consumption, _power_production,
 *            _energy_consumption_tarif_1 ..., _voltage_phase_l1 ...). At most
 *            one; until it reports, the page leaves it out.
 *   washer, dryer   power, energy and water of the laundry appliances
 *   car      Tesla Fleet charging (name = the car name, as in PANEL_CAR)
 *   bike     Stromer (name = the bike name)
 *   battery  a JK BMS on the JKBMS-ESP32 firmware
 * Order = display order. */
typedef struct {
    const char *kind;
    const char *label;
    const char *name;
} panel_energy_t;
static const panel_energy_t PANEL_ENERGY[] = {
    { "grid",    "Slimme meter", "electricity_meter" }, /* DSMR over the P1 port */
    { "washer",  "Wasmachine",   "wasruimte_wasmachine" },
    { "dryer",   "Droger",       "wasruimte_droger" },
    { "car",     "Tesla",        "vlm" },
    { "bike",    "Stromer",      "st7" },
    { "battery", "Accu 1",       "jk_bms_1" },
    { "battery", "Accu 2",       "jk_bms_2" },
    /* Last: its kWh counters are delivered heat, so it counts towards nothing. */
    { "heatpump", "Warmtepomp",   "f1253_6_r_pc_em" },
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
    /* The garage's lights as a floor of their own in the rail, below the ground floor. */
    { "Garage",  "G", "Garage" },
};

typedef struct {
    const char *name;
    const char *kind; /* "floors", "appliances", "vacuum", "car", "sensors", "energy", or "tab" (one PANEL_TABS entry) */
    const char *tab;  /* for "tab": the PANEL_TABS name */
} panel_section_t;
static const panel_section_t PANEL_SECTIONS[] = {
    { "Start",       "start",  NULL },
    { "Verlichting", "floors", NULL },
    { "Apparaten",   "appliances", NULL },
    { "Schoonmaak",  "vacuum", NULL },
    { "Tesla",       "car",    NULL },
    { "Sensoren",    "sensors", NULL },
    { "Energie",     "energy", NULL },
};
