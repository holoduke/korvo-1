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
    const panel_entity_t *devices; /* individual lights shown in the slide-out drawer */
    int device_count;
} panel_tab_t;

/* ---- Tab: Beneden (ground-floor zone) ----------------------------------- */
/* Zone tab: the brightness slider targets exactly these lights, so keep it to
 * ground-floor groups only (no upstairs groups leak in). */
static const panel_entity_t TAB_THUIS_LIGHTS[] = {
    { "light.lampen_woonkamer",          "Woonkamer" },
    { "light.lampen_keuken_groep",       "Keuken" },
    { "light.lampen_gang_beneden",       "Gang" },
    { "light.lamp_wc_beneden_1",         "WC" },
};
static const panel_entity_t TAB_THUIS_SCENES[] = {
    { "scene.woonkamer_avond",       "Avond sfeer" },
    { "scene.woonkamer_avond_licht", "Avond licht" },
    { "scene.woonkamer_alles_uit",   "Alles uit" },
};
static const panel_entity_t TAB_THUIS_DEVICES[] = {
    { "light.lamp_woonkamer_kubus_1",      "Kubus" },
    { "light.lamp_valerie_rieten_1",       "Rieten" },
    { "light.lamp_woonkamer_plafond_tv_2", "Plafond TV 2" },
    { "light.lamp_woonkamer_plafond_tv_3", "Plafond TV 3" },
    { "light.lamp_keuken_plafond_1",       "Keuken 1" },
    { "light.lamp_keuken_plafond_2",       "Keuken 2" },
    { "light.lamp_keuken_plafond_3",       "Keuken 3" },
    { "light.lamp_gang_deur_1",            "Gang deur" },
    { "light.lamp_gang_trap_beneden_1",    "Gang trap" },
    { "light.lamp_wc_beneden_1",           "WC" },
    { "light.lamp_grond_1",                "Grond" },
    { "light.lamp_trap_kast",              "Trapkast" },
};

/* ---- Tab: Boven (upper floors) ------------------------------------------ */
static const panel_entity_t TAB_BOVEN_LIGHTS[] = {
    { "light.lampen_bovenverdieping",       "Alles boven" },
    { "light.lamp_slaapkamer_gillis_ilse",  "Slaapkamer" },
    { "light.lamp_valerie_kamer_1",         "Valerie" },
    { "light.lamp_jongens_kamer_1",         "Jongens" },
    { "light.lamp_badkamer_1",              "Badkamer" },
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
    { "light.lamp_badkamer_1",                   "Badkamer" },
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
      devices, sizeof(devices) / sizeof((devices)[0]) }

/* ---- Tab: Tuin (garden) ------------------------------------------------- */
/* PLACEHOLDER entities: HA has no named garden lights yet (only scene.twingly
 * lives in the "Tuin achter" area). Replace these light IDs with the real
 * garden lights once they exist (e.g. in the new house). */
static const panel_entity_t TAB_TUIN_LIGHTS[] = {
    { "light.tuin_terras",  "Terras" },
    { "light.tuin_achter",  "Achtertuin" },
    { "light.tuin_schuur",  "Schuur" },
};
static const panel_entity_t TAB_TUIN_SCENES[] = {
    { "scene.twingly", "Twinkly" },
};
static const panel_entity_t TAB_TUIN_DEVICES[] = {
    { "light.tuin_terras",  "Terras" },
    { "light.tuin_achter",  "Achtertuin" },
    { "light.tuin_schuur",  "Schuur" },
};

/* Tab with no scenes (just the tiles + "Alle lampen" drawer). */
#define TAB_ENTRY_NS(name, lights, devices) \
    { name, lights, sizeof(lights) / sizeof((lights)[0]), \
      NULL, 0, devices, sizeof(devices) / sizeof((devices)[0]) }

static const panel_tab_t PANEL_TABS[] = {
    TAB_ENTRY("Beneden", TAB_THUIS_LIGHTS, TAB_THUIS_SCENES, TAB_THUIS_DEVICES),
    TAB_ENTRY("Boven", TAB_BOVEN_LIGHTS, TAB_BOVEN_SCENES, TAB_BOVEN_DEVICES),
    TAB_ENTRY_NS("Zolder", TAB_ZOLDER_LIGHTS, TAB_ZOLDER_DEVICES),
    TAB_ENTRY("Tuin", TAB_TUIN_LIGHTS, TAB_TUIN_SCENES, TAB_TUIN_DEVICES),
};
#define PANEL_TAB_COUNT (sizeof(PANEL_TABS) / sizeof(PANEL_TABS[0]))

/* Upper bound for the tile registry / subscribe list (main tiles + drawer devices) */
#define PANEL_MAX_LIGHTS 64

/* Weather entity shown in the header */
#define PANEL_WEATHER_ENTITY "weather.buienradar"
