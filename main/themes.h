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
    /* The web panel's look beyond colour (the firmware ignores these): */
    const char *font;    /* its typeface (a Google Fonts family in web/index.html), NULL = Montserrat */
    const char *display; /* the display face of the clock and the house readout, NULL = Orbitron */
    int round;           /* corner roundness in % of the usual (0 = usual; 0..200) */
    uint32_t edge;       /* a line along the edge of tiles and cards, 0 = none */
    int glow;            /* 1: tiles that are on glow in their colour */
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
    { .name = "Party",       /* neon magenta and cyan on near-black, very round, glowing edges */
      .bg = 0x0a0014, .toolbar = 0x05000c, .tile = 0x1c0b33, .tile_off = 0x12061f,
      .tile_on = 0xff2bd6, .on_text = 0x2a0022, .on_sub = 0x7a1a68,
      .text = 0xfdf2ff, .text_dim = 0xb98ad1, .text_soft = 0xe3c9f2,
      .scene = 0x24123f, .scene_on = 0x22e6ff, .scene_text = 0x03222a, .scene_sub = 0x0c6d7a,
      .accent = 0xff2bd6, .grid = 0x2c1550,
      .font = "Audiowide", .display = "Audiowide", .round = 160, .edge = 0x6d28d9, .glow = 1 },
    { .name = "Rood",        /* crimson and amber, a condensed face, angular */
      .bg = 0x160607, .toolbar = 0x0e0304, .tile = 0x3a1013, .tile_off = 0x260a0c,
      .tile_on = 0xff3b3b, .on_text = 0x2a0505, .on_sub = 0x7a1c1c,
      .text = 0xfff1f1, .text_dim = 0xc08a8a, .text_soft = 0xe8c4c4,
      .scene = 0x4a171b, .scene_on = 0xffb347, .scene_text = 0x2b1600, .scene_sub = 0x7a4a10,
      .accent = 0xff3b3b, .grid = 0x3d1a1d,
      .font = "Rajdhani", .display = "Rajdhani", .round = 50, .edge = 0x8b1e24, .glow = 1 },
    { .name = "Paars",       /* deep violet with lilac and pink, soft and round */
      .bg = 0x120a1f, .toolbar = 0x0c0616, .tile = 0x2a1a45, .tile_off = 0x1c1130,
      .tile_on = 0xc084fc, .on_text = 0x24103d, .on_sub = 0x5b3a85,
      .text = 0xf5f0ff, .text_dim = 0xa58fc6, .text_soft = 0xd6c7ec,
      .scene = 0x35234f, .scene_on = 0xf472b6, .scene_text = 0x3a0a25, .scene_sub = 0x8a2d64,
      .accent = 0xc084fc, .grid = 0x33244f,
      .font = "Comfortaa", .display = "Comfortaa", .round = 140, .edge = 0x4c2a80, .glow = 1 },
    { .name = "Cyberpunk",   /* acid yellow and cyan on navy, sharp corners, cyan edges */
      .bg = 0x070b14, .toolbar = 0x03060c, .tile = 0x11192a, .tile_off = 0x0b1120,
      .tile_on = 0xfcee0a, .on_text = 0x1f1a00, .on_sub = 0x6b5d00,
      .text = 0xeaf6ff, .text_dim = 0x6f8aa8, .text_soft = 0xb6cbe0,
      .scene = 0x172236, .scene_on = 0x00f0ff, .scene_text = 0x00252a, .scene_sub = 0x006b73,
      .accent = 0xfcee0a, .grid = 0x1a2740,
      .font = "Rajdhani", .display = "Orbitron", .round = 15, .edge = 0x0e7c85, .glow = 1 },
    { .name = "Terminal",    /* green phosphor on black, monospace, square */
      .bg = 0x000000, .toolbar = 0x000000, .tile = 0x0a1a0a, .tile_off = 0x061006,
      .tile_on = 0x33ff66, .on_text = 0x03230d, .on_sub = 0x0f6b2a,
      .text = 0xb8ffc8, .text_dim = 0x3f9a58, .text_soft = 0x7fd694,
      .scene = 0x0f2612, .scene_on = 0x7dffa5, .scene_text = 0x05260f, .scene_sub = 0x1b6b33,
      .accent = 0x33ff66, .grid = 0x123a18,
      .font = "Space Mono", .display = "VT323", .round = 0, .edge = 0x1e6b33, .glow = 1 },
    { .name = "Zonsondergang", /* plum, coral and apricot, friendly and round */
      .bg = 0x1c0f1a, .toolbar = 0x140a12, .tile = 0x3a1f33, .tile_off = 0x2a1626,
      .tile_on = 0xff7a59, .on_text = 0x2e0f05, .on_sub = 0x7a3520,
      .text = 0xfff3ec, .text_dim = 0xc498a8, .text_soft = 0xe9c9d3,
      .scene = 0x47263d, .scene_on = 0xffc46b, .scene_text = 0x332000, .scene_sub = 0x8a5a10,
      .accent = 0xff7a59, .grid = 0x41273a,
      .font = "Poppins", .display = "Poppins", .round = 120, .edge = 0x6b2f52 },
    { .name = "Goud",        /* black and gold, a serif face, restrained corners */
      .bg = 0x0b0a08, .toolbar = 0x060504, .tile = 0x1d1a14, .tile_off = 0x14120e,
      .tile_on = 0xd4af37, .on_text = 0x241c04, .on_sub = 0x6f5a13,
      .text = 0xf5efe0, .text_dim = 0x9a917c, .text_soft = 0xcfc6ad,
      .scene = 0x26221a, .scene_on = 0xf1e5b8, .scene_text = 0x2a2410, .scene_sub = 0x7a6a2c,
      .accent = 0xd4af37, .grid = 0x2a2619,
      .font = "Cinzel", .display = "Cinzel", .round = 30, .edge = 0x8a7328 },
    { .name = "IJs",         /* white and sky blue, ink text, a clean grotesk, thin grey edges */
      .bg = 0xf7f9fb, .toolbar = 0xffffff, .tile = 0xffffff, .tile_off = 0xe9eef3,
      .tile_on = 0x0ea5e9, .on_text = 0xffffff, .on_sub = 0xdbf2fd,
      .text = 0x0f172a, .text_dim = 0x64748b, .text_soft = 0x334155,
      .scene = 0xe6ecf2, .scene_on = 0x111827, .scene_text = 0xffffff, .scene_sub = 0x9ca3af,
      .accent = 0x0284c7, .grid = 0xdbe2ea,
      .font = "Inter", .display = "Inter", .round = 70, .edge = 0xd6dee8 },
    { .name = "Arcade",      /* indigo, yellow and red like a cabinet, a tall display face */
      .bg = 0x1a1030, .toolbar = 0x120a24, .tile = 0x2b1b4d, .tile_off = 0x20143a,
      .tile_on = 0xffd23f, .on_text = 0x2a2200, .on_sub = 0x7a6600,
      .text = 0xfff7ff, .text_dim = 0xa892c9, .text_soft = 0xd9cbef,
      .scene = 0x37245f, .scene_on = 0xff5e5b, .scene_text = 0x3a0a09, .scene_sub = 0x8a2a28,
      .accent = 0x3cf2ff, .grid = 0x34245a,
      .font = "Josefin Sans", .display = "Bebas Neue", .round = 20, .edge = 0x5b3aa0, .glow = 1 },
};
#define PANEL_THEME_COUNT (sizeof(PANEL_THEMES) / sizeof(PANEL_THEMES[0]))
