/* Wall panel configuration: Home Assistant endpoint and the entities shown. */
#pragma once

#define HA_WEBSOCKET_URI   "ws://192.168.2.111:8123/api/websocket"

/* Europe/Amsterdam for the clock */
#define PANEL_TIMEZONE     "CET-1CEST,M3.5.0,M10.5.0/3"
#define PANEL_SNTP_SERVER  "pool.ntp.org"

typedef struct {
    const char *entity_id;
    const char *label;
} panel_entity_t;

typedef struct {
    const char *name;              /* tab title */
    const panel_entity_t *lights;  /* toggle tiles (max 6 per tab) */
    int light_count;
    const panel_entity_t *scenes;  /* chips along the bottom */
    int scene_count;
} panel_tab_t;

/* ---- Tab: Thuis (ground floor) ------------------------------------------ */
static const panel_entity_t TAB_THUIS_LIGHTS[] = {
    { "light.lampen_woonkamer",          "Woonkamer" },
    { "light.lampen_keuken_groep",       "Keuken" },
    { "light.lampen_gang_beneden",       "Gang" },
    { "light.lampen_beneden_verdieping", "Beneden" },
    { "light.lampen_kinderkamers",       "Kinderkamers" },
    { "light.lampen_bovenverdieping",    "Boven" },
};
static const panel_entity_t TAB_THUIS_SCENES[] = {
    { "scene.woonkamer_avond",       "Avond sfeer" },
    { "scene.woonkamer_avond_licht", "Avond licht" },
    { "scene.woonkamer_alles_uit",   "Alles uit" },
};

/* ---- Tab: Boven (upper floors) ------------------------------------------ */
static const panel_entity_t TAB_BOVEN_LIGHTS[] = {
    { "light.lampen_bovenverdieping",       "Alles boven" },
    { "light.lamp_slaapkamer_gillis_ilse",  "Slaapkamer" },
    { "light.lamp_valerie_kamer_1",         "Valerie" },
    { "light.lamp_jongens_kamer_1",         "Jongens" },
    { "light.lamp_badkamer_1",              "Badkamer" },
    { "light.lamp_zolder_gang",             "Zolder gang" },
};
static const panel_entity_t TAB_BOVEN_SCENES[] = {
    { "scene.slaapkamer_aan",     "Slaapk. aan" },
    { "scene.slaapkamer_aan_fel", "Slaapk. fel" },
    { "scene.slaapkamer_uit",     "Slaapk. uit" },
};

#define TAB_ENTRY(name, lights, scenes) \
    { name, lights, sizeof(lights) / sizeof((lights)[0]), \
      scenes, sizeof(scenes) / sizeof((scenes)[0]) }

static const panel_tab_t PANEL_TABS[] = {
    TAB_ENTRY("Thuis", TAB_THUIS_LIGHTS, TAB_THUIS_SCENES),
    TAB_ENTRY("Boven", TAB_BOVEN_LIGHTS, TAB_BOVEN_SCENES),
};
#define PANEL_TAB_COUNT (sizeof(PANEL_TABS) / sizeof(PANEL_TABS[0]))

/* Upper bound for the tile registry / subscribe list */
#define PANEL_MAX_LIGHTS 24

/* Weather entity shown in the header */
#define PANEL_WEATHER_ENTITY "weather.buienradar"
