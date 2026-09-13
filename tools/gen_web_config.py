#!/usr/bin/env python3
"""Generate web/js/config.js from the firmware's panel_config.h and themes.h.

The wall panel (C/LVGL) and the web app share one source of truth: the tabs,
scenes, drawer devices, climate sensors, media players, comfort bands and
colour themes all live in main/panel_config.h and main/themes.h. This script
parses those headers and writes the same data as a JavaScript object, so a
change to the panel config reaches the web app with one command:

    python3 tools/gen_web_config.py

The parser understands exactly the constructs those headers use (entity
tables, icon tables, swatch tables, the TAB_ENTRY* macros, the sensor table
and the theme table) and fails loudly on anything it does not recognise, so a
header change can never silently produce a wrong web config.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG_H = ROOT / "main" / "panel_config.h"
THEMES_H = ROOT / "main" / "themes.h"
OUT = ROOT / "web" / "js" / "config.js"

# LVGL symbol name -> icon name used by the web app's icon set.
LV_SYMBOLS = {
    "LV_SYMBOL_CHARGE": "bolt",
    "LV_SYMBOL_EYE_CLOSE": "eye-off",
    "LV_SYMBOL_EYE_OPEN": "eye",
    "LV_SYMBOL_TINT": "drop",
    "LV_SYMBOL_POWER": "power",
    "LV_SYMBOL_MINUS": "minus",
    "LV_SYMBOL_PLUS": "plus",
    "LV_SYMBOL_LIST": "list",
    "LV_SYMBOL_HOME": "home",
    "LV_SYMBOL_SETTINGS": "gear",
    "LV_SYMBOL_AUDIO": "music",
    "LV_SYMBOL_BELL": "bell",
    "LV_SYMBOL_OK": "check",
    "LV_SYMBOL_WARNING": "warning",
}


def fail(msg):
    sys.exit(f"gen_web_config: {msg}")


def strip_comments(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def array_body(src, name):
    m = re.search(r"\b%s\s*\[\s*\]\s*=\s*\{(.*?)\n\};" % re.escape(name), src, re.S)
    if not m:
        fail(f"array {name} not found")
    return m.group(1)


def entity_table(src, name):
    body = array_body(src, name)
    rows = re.findall(r'\{\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\}', body)
    if not rows:
        fail(f"entity table {name} is empty or unparsable")
    return [{"id": e, "label": l} for e, l in rows]


def icon_table(src, name):
    body = array_body(src, name)
    out = []
    for tok in [t.strip() for t in body.split(",") if t.strip()]:
        if tok == "NULL":
            out.append(None)
        elif tok in LV_SYMBOLS:
            out.append(LV_SYMBOLS[tok])
        else:
            fail(f"unknown icon token {tok!r} in {name} (add it to LV_SYMBOLS)")
    return out


def swatch_table(src, name, rainbow):
    body = array_body(src, name)
    out = []
    for a, b in re.findall(r"\{\s*([^,{}]+?)\s*,\s*([^,{}]+?)\s*\}", body):
        def colour(tok):
            tok = tok.strip()
            if tok == "SWATCH_RAINBOW":
                return "rainbow"
            v = int(tok, 0)
            return None if v == 0 else "#%06x" % v
        out.append({"a": colour(a), "b": colour(b)} if colour(a) else None)
    if not out:
        fail(f"swatch table {name} is empty")
    return out


def c_string_or_null(tok):
    tok = tok.strip()
    if tok == "NULL":
        return None
    m = re.fullmatch(r'"([^"]*)"', tok)
    if not m:
        fail(f"expected string or NULL, got {tok!r}")
    return m.group(1)


def split_args(s):
    return [a.strip() for a in s.split(",")]


def parse_tabs(src):
    body = array_body(src, "PANEL_TABS")
    tabs = []
    for macro, args in re.findall(r"(TAB_ENTRY(?:_SCENES|_NS)?)\s*\((.*?)\)\s*,", body, re.S):
        a = split_args(args)
        name = c_string_or_null(a[0])
        if macro == "TAB_ENTRY":
            lights, scenes, devices = a[1], a[2], a[3]
            tab = {"name": name, "lights": entity_table(src, lights),
                   "scenes": entity_table(src, scenes), "devices": entity_table(src, devices),
                   "icons": None, "swatches": None, "quick": 0, "sceneTiles": False}
        elif macro == "TAB_ENTRY_NS":
            lights, devices = a[1], a[2]
            tab = {"name": name, "lights": entity_table(src, lights), "scenes": [],
                   "devices": entity_table(src, devices), "icons": None, "swatches": None,
                   "quick": 0, "sceneTiles": False}
        else:
            lights, scenes, icons, swatches, quick, devices = a[1:7]
            tab = {"name": name, "lights": entity_table(src, lights),
                   "scenes": entity_table(src, scenes), "devices": entity_table(src, devices),
                   "icons": None if icons == "NULL" else icon_table(src, icons),
                   "swatches": None if swatches == "NULL" else swatch_table(src, swatches, True),
                   "quick": int(quick, 0), "sceneTiles": True}
        for key in ("icons", "swatches"):
            if tab[key] is not None and len(tab[key]) != len(tab["scenes"]):
                fail(f"tab {name}: {key} has {len(tab[key])} entries for {len(tab['scenes'])} scenes")
        tabs.append(tab)
    if not tabs:
        fail("PANEL_TABS has no entries")
    return tabs


def parse_sensors(src):
    body = array_body(src, "PANEL_TEMP_SENSORS")
    rows = re.findall(r"\{\s*(\"[^\"]+\")\s*,\s*(\"[^\"]+\"|NULL)\s*,\s*(\"[^\"]*\")\s*,"
                      r"\s*(\"[^\"]*\")\s*,\s*(true|false)\s*\}", body, re.S)
    if not rows:
        fail("PANEL_TEMP_SENSORS is empty or unparsable")
    return [{"temp": c_string_or_null(t), "humidity": c_string_or_null(h),
             "label": c_string_or_null(l), "abbr": c_string_or_null(ab), "indoor": ind == "true"}
            for t, h, l, ab, ind in rows]


def define(src, name, kind):
    m = re.search(r"#define\s+%s\s+(\S+)" % re.escape(name), src)
    if not m:
        fail(f"#define {name} not found")
    tok = m.group(1)
    if kind == "str":
        return c_string_or_null(tok)
    return float(tok.rstrip("fF"))


def parse_themes(src):
    body = array_body(src, "PANEL_THEMES")
    themes = []
    for block in re.findall(r"\{(\s*\.name.*?)\}", body, re.S):
        name = re.search(r'\.name\s*=\s*"([^"]+)"', block).group(1)
        colours = {k: "#%06x" % int(v, 16)
                   for k, v in re.findall(r"\.(\w+)\s*=\s*0x([0-9a-fA-F]{6})", block)}
        if len(colours) != 16:
            fail(f"theme {name}: expected 16 colours, found {len(colours)}")
        themes.append({"name": name, **colours})
    if not themes:
        fail("PANEL_THEMES is empty")
    return themes


def main():
    cfg = strip_comments(CONFIG_H.read_text())
    config = {
        "weather": define(cfg, "PANEL_WEATHER_ENTITY", "str"),
        "tabs": parse_tabs(cfg),
        "sensors": parse_sensors(cfg),
        "media": entity_table(cfg, "PANEL_MEDIA_PLAYERS"),
        "comfort": {
            "tempMin": define(cfg, "COMFORT_TEMP_MIN", "num"),
            "tempMax": define(cfg, "COMFORT_TEMP_MAX", "num"),
            "tempHot": define(cfg, "COMFORT_TEMP_HOT", "num"),
            "humMin": define(cfg, "COMFORT_HUM_MIN", "num"),
            "humMax": define(cfg, "COMFORT_HUM_MAX", "num"),
            "humMargin": define(cfg, "COMFORT_HUM_MARGIN", "num"),
        },
        "themes": parse_themes(strip_comments(THEMES_H.read_text())),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        "/* GENERATED by tools/gen_web_config.py from main/panel_config.h and main/themes.h.\n"
        " * Do not edit by hand: change the headers and re-run the script. */\n"
        "window.PANEL_CONFIG = " + json.dumps(config, indent=2, ensure_ascii=False) + ";\n")
    n_dev = sum(len(t["devices"]) for t in config["tabs"])
    print(f"wrote {OUT.relative_to(ROOT)}: {len(config['tabs'])} tabs, {n_dev} drawer devices, "
          f"{len(config['sensors'])} sensors, {len(config['themes'])} themes")


if __name__ == "__main__":
    main()
