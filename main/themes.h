/* Colour themes for the panel. Selected in Settings, stored in NVS ("panel"/
 * "theme"), applied on the next start. Every UI colour that defines the look
 * comes from here; status colours (ok/warn/bad/cold) stay fixed so a red
 * reading means the same thing in every theme. */
#pragma once

#include <stdint.h>

typedef struct {
    const char *name;    /* shown in the settings dropdown */
    uint32_t bg;         /* screen background */
    uint32_t toolbar;    /* header bar */
    uint32_t tile;       /* tiles, popups, buttons at rest */
    uint32_t tile_off;   /* sunken surfaces: unavailable tiles, chart bg, pills */
    uint32_t tile_on;    /* a light that is on (also the brightness slider) */
    uint32_t on_text;    /* text on tile_on */
    uint32_t on_sub;     /* "aan" sub-label on tile_on */
    uint32_t text;       /* primary text */
    uint32_t text_dim;   /* secondary text */
    uint32_t text_soft;  /* weekday in the header */
    uint32_t scene;      /* scene chips at rest */
    uint32_t scene_on;   /* active scene */
    uint32_t scene_text; /* text on scene_on */
    uint32_t scene_sub;  /* "actief" sub-label on scene_on */
    uint32_t accent;     /* highlights: active tab, "Alle lampen", today */
    uint32_t grid;       /* chart grid lines */
} panel_theme_t;

static const panel_theme_t PANEL_THEMES[] = {
    { .name = "Nacht",       /* the original: graphite with amber */
      .bg = 0x111318, .toolbar = 0x0c0e12, .tile = 0x232833, .tile_off = 0x1a1d24,
      .tile_on = 0xffb84d, .on_text = 0x241a05, .on_sub = 0x6b5518,
      .text = 0xeef0f5, .text_dim = 0x848b9c, .text_soft = 0xc6cbd6,
      .scene = 0x2b3444, .scene_on = 0xa78bfa, .scene_text = 0x1a1030, .scene_sub = 0x3b2d66,
      .accent = 0xffb84d, .grid = 0x2b3140 },
    { .name = "Middernacht", /* true black for the LCD at night, ice-cyan accents */
      .bg = 0x000000, .toolbar = 0x000000, .tile = 0x15181d, .tile_off = 0x0b0d10,
      .tile_on = 0x3ee0d8, .on_text = 0x03211f, .on_sub = 0x0e5c58,
      .text = 0xf2f4f8, .text_dim = 0x7d8494, .text_soft = 0xb9bfcc,
      .scene = 0x1c2027, .scene_on = 0x5ad1ff, .scene_text = 0x06202c, .scene_sub = 0x0f4b66,
      .accent = 0x3ee0d8, .grid = 0x22262d },
    { .name = "Warm",        /* espresso browns, terracotta and copper */
      .bg = 0x1a1412, .toolbar = 0x120d0b, .tile = 0x2e2420, .tile_off = 0x221a17,
      .tile_on = 0xff8c42, .on_text = 0x2b1200, .on_sub = 0x7a3f1a,
      .text = 0xf6ede6, .text_dim = 0x9c8b82, .text_soft = 0xd3c4ba,
      .scene = 0x3a2c27, .scene_on = 0xe8a27a, .scene_text = 0x2b1a12, .scene_sub = 0x6b3d2a,
      .accent = 0xff8c42, .grid = 0x3a2e29 },
    { .name = "Licht",       /* daylight: paper white, ink text, amber and violet */
      .bg = 0xf3f4f7, .toolbar = 0xffffff, .tile = 0xffffff, .tile_off = 0xe6e8ee,
      .tile_on = 0xffb84d, .on_text = 0x241a05, .on_sub = 0x6b5518,
      .text = 0x1c2230, .text_dim = 0x6b7280, .text_soft = 0x4b5563,
      .scene = 0xe4e7ee, .scene_on = 0x8b5cf6, .scene_text = 0xffffff, .scene_sub = 0xede9fe,
      .accent = 0xd97706, .grid = 0xd9dce3 },
    { .name = "Bos",         /* deep forest greens with a lime highlight */
      .bg = 0x0f1a14, .toolbar = 0x0a120e, .tile = 0x1d2e24, .tile_off = 0x16241c,
      .tile_on = 0xa3e635, .on_text = 0x14260a, .on_sub = 0x4d6d1a,
      .text = 0xeaf3ec, .text_dim = 0x86a08f, .text_soft = 0xc2d3c6,
      .scene = 0x25392d, .scene_on = 0x6ee7b7, .scene_text = 0x06301f, .scene_sub = 0x1f5a41,
      .accent = 0xa3e635, .grid = 0x243a2e },
    { .name = "Oceaan",      /* midnight navy, sky blue and a gold scene marker */
      .bg = 0x0b1626, .toolbar = 0x070f1b, .tile = 0x162a44, .tile_off = 0x102036,
      .tile_on = 0x38bdf8, .on_text = 0x06263a, .on_sub = 0x0b4a66,
      .text = 0xe6f0fb, .text_dim = 0x7f95b0, .text_soft = 0xbccbe0,
      .scene = 0x1d3556, .scene_on = 0xfbbf24, .scene_text = 0x3a2a05, .scene_sub = 0x5c4408,
      .accent = 0x38bdf8, .grid = 0x1c3352 },
};
#define PANEL_THEME_COUNT (sizeof(PANEL_THEMES) / sizeof(PANEL_THEMES[0]))
