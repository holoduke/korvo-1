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


def parse_air_sensors(src):
    body = array_body(src, "PANEL_AIR_SENSORS")
    rows = re.findall(r"\{\s*" + r"\s*,\s*".join([r'"([^"]*)"'] * 8) + r"\s*\}", body, re.S)
    if not rows:
        fail("PANEL_AIR_SENSORS is empty or unparsable")
    keys = ("label", "short", "abbr", "co2", "pm25", "quality", "temp", "humidity")
    return [dict(zip(keys, row)) for row in rows]


def parse_vacuum(src):
    m = re.search(r"\bPANEL_VACUUM\s*=\s*\{(.*?)\};", src, re.S)
    if not m:
        fail("PANEL_VACUUM not found")
    vals = re.findall(r'"([^"]*)"', m.group(1))
    keys = ("label", "vacuum", "status", "battery", "area", "mode", "fan", "water", "locate", "roomsDomain")
    if len(vals) != len(keys):
        fail(f"PANEL_VACUUM: expected {len(keys)} strings, found {len(vals)}")
    vac = dict(zip(keys, vals))
    rooms = re.findall(r'\{\s*(\d+)\s*,\s*"([^"]*)"\s*\}', array_body(src, "PANEL_VACUUM_ROOMS"))
    vac["rooms"] = [{"id": int(i), "label": l} for i, l in rooms]
    return vac


def parse_bike(src):
    m = re.search(r"\bPANEL_BIKE\s*=\s*\{(.*?)\};", src, re.S)
    if not m:
        fail("PANEL_BIKE not found")
    vals = re.findall(r'"([^"]*)"', m.group(1))
    keys = ("label", "battery", "location", "lock", "speed")
    if len(vals) != len(keys):
        fail(f"PANEL_BIKE: expected {len(keys)} strings, found {len(vals)}")
    return dict(zip(keys, vals))


# Tesla Fleet entities by role: (key, domain, object id after "<car name>_").
TESLA_FLEET_ENTITIES = (
    ("battery", "sensor", "battery_level"), ("usable", "sensor", "usable_battery_level"),
    ("range", "sensor", "battery_range"), ("estRange", "sensor", "estimate_battery_range"),
    ("charging", "sensor", "charging"), ("charge", "switch", "charge"),
    ("chargeLimit", "number", "charge_limit"), ("chargeAmps", "number", "charge_current"),
    ("chargerPower", "sensor", "charger_power"), ("chargerVoltage", "sensor", "charger_voltage"),
    ("chargerCurrent", "sensor", "charger_current"), ("chargeRate", "sensor", "charge_rate"),
    ("energyAdded", "sensor", "charge_energy_added"), ("timeToFull", "sensor", "time_to_full_charge"),
    ("cable", "binary_sensor", "charge_cable"), ("port", "cover", "charge_port_door"),
    ("cableLock", "lock", "charge_cable_lock"), ("lock", "lock", "lock"),
    ("sentry", "switch", "sentry_mode"), ("frunk", "cover", "frunk"), ("trunk", "cover", "trunk"),
    ("windows", "cover", "windows"),
    ("doorFL", "binary_sensor", "front_driver_door"), ("doorFR", "binary_sensor", "front_passenger_door"),
    ("doorRL", "binary_sensor", "rear_driver_door"), ("doorRR", "binary_sensor", "rear_passenger_door"),
    ("winFL", "binary_sensor", "front_driver_window"), ("winFR", "binary_sensor", "front_passenger_window"),
    ("winRL", "binary_sensor", "rear_driver_window"), ("winRR", "binary_sensor", "rear_passenger_window"),
    ("climate", "climate", "climate"), ("inside", "sensor", "inside_temperature"),
    ("outside", "sensor", "outside_temperature"), ("defrost", "switch", "defrost"),
    ("seatFL", "select", "seat_heater_front_left"), ("seatFR", "select", "seat_heater_front_right"),
    ("seatRL", "select", "seat_heater_rear_left"), ("seatRC", "select", "seat_heater_rear_center"),
    ("seatRR", "select", "seat_heater_rear_right"), ("wheel", "select", "steering_wheel_heater"),
    ("precond", "binary_sensor", "preconditioning"), ("battHeater", "binary_sensor", "battery_heater"),
    ("online", "binary_sensor", "status"), ("present", "binary_sensor", "user_present"),
    ("location", "device_tracker", "location"), ("shift", "sensor", "shift_state"),
    ("speed", "sensor", "speed"), ("power", "sensor", "power"), ("odometer", "sensor", "odometer"),
    ("tireFL", "sensor", "tire_pressure_front_left"), ("tireFR", "sensor", "tire_pressure_front_right"),
    ("tireRL", "sensor", "tire_pressure_rear_left"), ("tireRR", "sensor", "tire_pressure_rear_right"),
    ("tireWarnFL", "binary_sensor", "tire_pressure_warning_front_left"),
    ("tireWarnFR", "binary_sensor", "tire_pressure_warning_front_right"),
    ("tireWarnRL", "binary_sensor", "tire_pressure_warning_rear_left"),
    ("tireWarnRR", "binary_sensor", "tire_pressure_warning_rear_right"),
    ("destination", "sensor", "destination"), ("distToArrival", "sensor", "distance_to_arrival"),
    ("timeToArrival", "sensor", "time_to_arrival"), ("socAtArrival", "sensor", "state_of_charge_at_arrival"),
    ("trafficDelay", "sensor", "traffic_delay"),
    ("flash", "button", "flash_lights"), ("honk", "button", "honk_horn"), ("homelink", "button", "homelink"),
    ("keyless", "button", "keyless_driving"), ("fart", "button", "play_fart"), ("wake", "button", "wake"),
    ("media", "media_player", "media_player"), ("update", "update", "update"),
)


def parse_car(src):
    m = re.search(r"\bPANEL_CAR\s*=\s*\{(.*?)\};", src, re.S)
    if not m:
        fail("PANEL_CAR not found")
    vals = re.findall(r'"([^"]*)"', m.group(1))
    if len(vals) != 2 or not re.fullmatch(r"[a-z0-9_]+", vals[1]):
        fail(f"PANEL_CAR: expected a label and a car name like \"vlm\", found {vals}")
    label, name = vals
    entities = {key: f"{domain}.{name}_{object_id}" for key, domain, object_id in TESLA_FLEET_ENTITIES}
    return {"label": label, "name": name, "entities": entities,
            # the header column's four
            "battery": entities["battery"], "range": entities["range"],
            "charging": entities["charging"], "lock": entities["lock"]}


def parse_layout(src, tabs):
    names = [t["name"] for t in tabs]

    def tab_index(name, where):
        if name not in names:
            fail(f"{where}: no tab named {name!r} in PANEL_TABS")
        return names.index(name)

    floors = [{"tab": tab_index(t, "PANEL_FLOORS"), "label": l, "name": n}
              for t, l, n in re.findall(r'\{\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\}',
                                        array_body(src, "PANEL_FLOORS"))]
    sections = []
    for name, kind, tab in re.findall(r'\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*("[^"]*"|NULL)\s*\}',
                                      array_body(src, "PANEL_SECTIONS")):
        if kind not in ("floors", "vacuum", "car", "tab"):
            fail(f"PANEL_SECTIONS: unknown kind {kind!r}")
        tab_name = c_string_or_null(tab)
        if (kind == "tab") != (tab_name is not None):
            fail(f"PANEL_SECTIONS: {name!r} of kind {kind!r} {'needs' if kind == 'tab' else 'takes no'} tab")
        sections.append({"name": name, "kind": kind,
                         "tab": tab_index(tab_name, "PANEL_SECTIONS") if tab_name else None})
    if not floors or not sections:
        fail("PANEL_FLOORS / PANEL_SECTIONS empty")
    return floors, sections


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
    tabs = parse_tabs(cfg)
    floors, sections = parse_layout(cfg, tabs)
    config = {
        "weather": define(cfg, "PANEL_WEATHER_ENTITY", "str"),
        "tabs": tabs,
        "floors": floors,
        "sections": sections,
        "sensors": parse_sensors(cfg),
        "air": parse_air_sensors(cfg),
        "airBands": {
            "co2Good": define(cfg, "AIR_CO2_GOOD", "num"),
            "co2Poor": define(cfg, "AIR_CO2_POOR", "num"),
            "co2MinValid": define(cfg, "AIR_CO2_MIN_VALID", "num"),
            "pm25Good": define(cfg, "AIR_PM25_GOOD", "num"),
            "pm25Poor": define(cfg, "AIR_PM25_POOR", "num"),
        },
        "vacuum": parse_vacuum(cfg),
        "bike": parse_bike(cfg),
        "car": parse_car(cfg),
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
          f"{len(config['sensors'])} sensors, {len(config['air'])} air monitors, "
          f"{len(config['themes'])} themes")


if __name__ == "__main__":
    main()
