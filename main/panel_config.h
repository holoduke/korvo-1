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

/* Light groups shown as toggle tiles (3 x 2 grid) */
static const panel_entity_t PANEL_LIGHTS[] = {
    { "light.lampen_woonkamer",          "Woonkamer" },
    { "light.lampen_keuken_groep",       "Keuken" },
    { "light.lampen_gang_beneden",       "Gang" },
    { "light.lampen_beneden_verdieping", "Beneden" },
    { "light.lampen_kinderkamers",       "Kinderkamers" },
    { "light.lampen_bovenverdieping",    "Boven" },
};
#define PANEL_LIGHT_COUNT (sizeof(PANEL_LIGHTS) / sizeof(PANEL_LIGHTS[0]))

/* Scenes shown as chips along the bottom */
static const panel_entity_t PANEL_SCENES[] = {
    { "scene.woonkamer_avond",       "Avond sfeer" },
    { "scene.woonkamer_avond_licht", "Avond licht" },
    { "scene.woonkamer_alles_uit",   "Alles uit" },
    { "scene.slaapkamer_aan",        "Slaapk. aan" },
    { "scene.slaapkamer_aan_fel",    "Slaapk. fel" },
    { "scene.slaapkamer_uit",        "Slaapk. uit" },
};
#define PANEL_SCENE_COUNT (sizeof(PANEL_SCENES) / sizeof(PANEL_SCENES[0]))

/* Weather entity shown in the header */
#define PANEL_WEATHER_ENTITY "weather.buienradar"
