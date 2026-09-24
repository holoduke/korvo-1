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
    """C comments removed; a string literal is kept whole (a "//" inside one is not a comment)."""
    return re.sub(r'("(?:\\.|[^"\\])*")|/\*.*?\*/|//[^\n]*', lambda m: m.group(1) or "", src, flags=re.S)


def table_rows(src, name, pattern):
    """The {...} rows of a C array, each matched whole against pattern: a row
    that does not fit fails the build instead of silently dropping out."""
    rows = []
    for m in re.finditer(r"\{[^{}]*\}", array_body(src, name)):
        row = re.fullmatch(pattern, m.group(0), re.S)
        if not row:
            fail(f"{name}: row {m.group(0).strip()!r} does not have the expected shape")
        rows.append(row.groups())
    return rows


def array_body(src, name):
    m = re.search(r"\b%s\s*\[\s*\]\s*=\s*\{(.*?)\n\};" % re.escape(name), src, re.S)
    if not m:
        fail(f"array {name} not found")
    return m.group(1)


def entity_table(src, name):
    rows = table_rows(src, name, r'\{\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\}')
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


def swatch_table(src, name):
    out = []
    for a, b in table_rows(src, name, r"\{\s*([^,{}]+?)\s*,\s*([^,{}]+?)\s*\}"):
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
    for macro, args in re.findall(r"(TAB_ENTRY(?:_SCENES|_NS)?)\s*\((.*?)\)\s*(?=,|\Z)", body, re.S):
        a = split_args(args)
        icons = swatches = "NULL"
        if macro == "TAB_ENTRY":
            lights, scenes, devices = a[1:4]
        elif macro == "TAB_ENTRY_NS":
            lights, scenes, devices = a[1], None, a[2]
        else:  # TAB_ENTRY_SCENES; its quick-button count is the firmware's own
            lights, scenes, icons, swatches, _quick, devices = a[1:7]
        name = c_string_or_null(a[0])
        tab = {"name": name, "lights": entity_table(src, lights),
               "scenes": entity_table(src, scenes) if scenes else [],
               "devices": entity_table(src, devices),
               "icons": None if icons == "NULL" else icon_table(src, icons),
               "swatches": None if swatches == "NULL" else swatch_table(src, swatches),
               "sceneTiles": macro == "TAB_ENTRY_SCENES"}
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


def string_struct(src, name, keys):
    """A struct of strings, e.g. PANEL_BIKE = { "Fiets", "sensor.x", ... }, as a dict."""
    m = re.search(r"\b%s\s*=\s*\{(.*?)\};" % re.escape(name), src, re.S)
    if not m:
        fail(f"{name} not found")
    vals = re.findall(r'"([^"]*)"', m.group(1))
    if len(vals) != len(keys):
        fail(f"{name}: expected {len(keys)} strings, found {len(vals)}")
    return dict(zip(keys, vals))


def parse_vacuum(src):
    vac = string_struct(src, "PANEL_VACUUM",
                        ("label", "vacuum", "status", "battery", "area", "mode", "fan", "water",
                         "setMode", "setFan", "setWater", "locate", "roomsDomain", "floor"))
    rooms = re.findall(r'\{\s*(\d+)\s*,\s*"([^"]*)"\s*\}', array_body(src, "PANEL_VACUUM_ROOMS"))
    vac["rooms"] = [{"id": int(i), "label": l} for i, l in rooms]
    return vac


# A Tuya Local robot vacuum's entities, as tuya-local's ilife_v30_vacuum config names
# them (used for the ILIFE A30 Pro): key -> template ({n} = the device name).
TUYA_VACUUM_ENTITIES = {
    "vacuum": "vacuum.{n}", "battery": "sensor.{n}_battery", "area": "sensor.{n}_cleaning_area",
    "time": "sensor.{n}_cleaning_time", "problem": "binary_sensor.{n}_problem",
    "mopping": "select.{n}_mopping", "efficiency": "select.{n}_cleaning_efficiency",
    "dnd": "switch.{n}_do_not_disturb", "breakClean": "switch.{n}_break_clean",
    "autoBoost": "switch.{n}_auto_boost", "yMopping": "switch.{n}_y_mopping",
    # per part: minutes of life left, "clean me", and the reset button
    **{f"{key}{what}": template
       for key, part in (("edge", "edge_brush"), ("roll", "roll_brush"), ("filter", "filter"))
       for what, template in (("Life", f"sensor.{{n}}_{part}_life"), ("Dirty", f"binary_sensor.{{n}}_clean_{part}"),
                              ("Reset", f"button.{{n}}_reset_{part}"))},
    "totalArea": "sensor.{n}_total_cleaning_area", "totalRuns": "sensor.{n}_total_cleaning_times",
    "totalTime": "sensor.{n}_total_cleaning_time",
}


def parse_tuya_vacuums(src, floors, taken):
    """PANEL_TUYA_VACUUMS -> [{label, floor, name, entities}]; one robot per floor
    (`taken`: floors that already have one)."""
    labels = [f["label"] for f in floors]
    out = []
    for label, floor, name in table_rows(src, "PANEL_TUYA_VACUUMS", r'\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}'):
        if floor not in labels:
            fail(f"PANEL_TUYA_VACUUMS {label!r}: no floor labelled {floor!r} in PANEL_FLOORS")
        if floor in taken:
            fail(f"PANEL_TUYA_VACUUMS {label!r}: floor {floor!r} already has a robot")
        if not re.fullmatch(r"[a-z0-9_]+", name):
            fail(f"PANEL_TUYA_VACUUMS {label!r}: bad name {name!r}")
        taken.add(floor)
        out.append({"label": label, "floor": floor, "name": name,
                    "entities": {k: t.format(n=name) for k, t in TUYA_VACUUM_ENTITIES.items()}})
    return out


def parse_bike(src):
    return string_struct(src, "PANEL_BIKE", ("label", "battery", "location", "lock", "speed"))


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


# Appliance entities by kind: key -> entity id template ({n} = the device name).
_LAUNDRY = {
    "state": "select.{n}", "machine": "sensor.{n}_machine_state", "job": "sensor.{n}_job_state",
    "done": "sensor.{n}_completion_time", "power": "sensor.{n}_power", "energy": "sensor.{n}_energy",
    "remote": "binary_sensor.{n}_remote_control", "lock": "binary_sensor.{n}_child_lock", "on": "binary_sensor.{n}_power",
}
# NIBE F1253 heat pump (nibe_heatpump over Modbus): its readings and its settings.
# Its kWh counters are DELIVERED heat, not electricity — the pump has no power meter.
_HEATPUMP = {
    # what it is doing
    "status": "sensor.{n}_status", "compressor": "sensor.{n}_status_compressor",
    "alarm": "binary_sensor.{n}_alarm", "online": "binary_sensor.{n}_connectivity",
    "add": "sensor.{n}_int_elec_add_heat",
    # temperatures
    "outdoor": "sensor.{n}_outdoor_temperature", "outdoorAvg": "sensor.{n}_average_outdoor_temp_bt1",
    "room": "sensor.{n}_room_temperature_bt50",
    "supply": "sensor.{n}_supply_line_bt2", "ret": "sensor.{n}_return_line_bt3",
    "calcSupply": "sensor.{n}_calculated_supply_climate_system_1",
    "hotWaterTop": "sensor.{n}_hot_water_top_bt7", "hotWaterCharge": "sensor.{n}_hot_water_charging_bt6",
    "brineIn": "sensor.{n}_brine_in_bt10", "brineOut": "sensor.{n}_brine_out_bt11",
    "condenser": "sensor.{n}_condenser_bt12", "discharge": "sensor.{n}_discharge_bt14",
    "liquid": "sensor.{n}_liquid_line_bt15", "suction": "sensor.{n}_suction_gas_bt17",
    "inverter": "sensor.{n}_inverter_temperature",
    # the machine
    "freq": "sensor.{n}_current_compressor_frequency", "freqMin": "sensor.{n}_min_compressor_frequency",
    "freqMax": "sensor.{n}_max_compressor_frequency", "degreeMinutes": "sensor.{n}_degree_minutes",
    "flow": "sensor.{n}_flow_sensor_bf1", "pumpHeat": "sensor.{n}_heating_medium_pump_speed_gp1",
    "pumpBrine": "sensor.{n}_brine_pump_speed_gp2",
    "operTime": "sensor.{n}_total_operating_time", "operHotWater": "sensor.{n}_oper_time_hot_water",
    "starts": "sensor.{n}_number_of_compressor_starts", "hotWaterAmount": "sensor.{n}_hot_water_amount",
    # delivered energy (kWh counters)
    "heat": "sensor.{n}_heating_compressor_only", "heatAdd": "sensor.{n}_heating_including_int_add_heat",
    "water": "sensor.{n}_hot_water_compressor_only", "waterAdd": "sensor.{n}_hot_water_including_int_add_heat",
    "cool": "sensor.{n}_built_in_passive_cooling",
    # settings
    "opMode": "select.{n}_op_mode", "demand": "select.{n}_hot_water_demand",
    "boost": "select.{n}_hot_water_boost", "maxAdd": "select.{n}_set_max_electrical_add",
    "coolSensor": "select.{n}_cool_heat_sensor",
    "lux": "switch.{n}_temporary_lux", "smart": "switch.{n}_smart_control",
    "offset": "number.{n}_offset", "roomHeat": "number.{n}_room_sensor_set_point_value_heating_climate_system_1",
    "roomCool": "number.{n}_room_sensor_set_point_value_cooling_climate_system_1",
    "coolOffset": "number.{n}_cooling_offset_climate_system_1", "coolStart": "number.{n}_start_cooling",
}
APPLIANCE_ENTITIES = {
    # A Windows pc: a template switch (on = awake; on -> Wake-on-LAN, off -> sleep)
    # with the Wake-on-LAN and sleep buttons behind it, and a ping sensor.
    "pc": {"on": "switch.{n}", "online": "binary_sensor.{n}_online", "wake": "button.{n}_aanzetten", "sleep": "button.{n}_sleep"},
    "heatpump": _HEATPUMP,
    "washer": {**_LAUNDRY, "water": "sensor.{n}_water_consumption"},
    "dryer": _LAUNDRY,
    "dishwasher": {
        "op": "sensor.{n}_bsh_common_status_operationstate", "door": "sensor.{n}_bsh_common_status_doorstate",
        "phase": "sensor.{n}_dishcare_dishwasher_status_programphase",
        "selected": "select.{n}_bsh_common_root_selectedprogram", "active": "select.{n}_bsh_common_root_activeprogram",
        "remaining": "sensor.{n}_bsh_common_option_remainingprogramtime", "progress": "sensor.{n}_bsh_common_option_programprogress",
        "startAllowed": "binary_sensor.{n}_bsh_common_status_remotecontrolstartallowed",
        "abort": "button.{n}_bsh_common_command_abortprogram",
        "energy": "sensor.{n}_bsh_common_option_energyforecast", "water": "sensor.{n}_bsh_common_option_waterforecast",
        "care": "sensor.{n}_dishcare_dishwasher_status_machinecarereminder_remainingprogramruns",
        "extradry": "switch.{n}_dishcare_dishwasher_setting_extradry", "hygiene": "switch.{n}_dishcare_dishwasher_option_hygieneplus",
        "speed": "switch.{n}_dishcare_dishwasher_option_variospeedplus", "silence": "switch.{n}_dishcare_dishwasher_option_silenceondemand",
    },
    "oven": {
        "op": "sensor.{n}_bsh_common_status_operationstate", "door": "sensor.{n}_bsh_common_status_doorstate",
        "temp": "sensor.{n}_cooking_oven_status_cavity_001_currenttemperature",
        "setpoint": "sensor.{n}_cooking_oven_status_cavity_001_setpointtemperature",
        "program": "sensor.{n}_bsh_common_option_programname",
        "remaining": "sensor.{n}_bsh_common_option_remainingprogramtime", "elapsed": "sensor.{n}_bsh_common_option_elapsedprogramtime",
        "progress": "sensor.{n}_bsh_common_option_programprogress",
        "pause": "button.{n}_bsh_common_command_pauseprogram", "resume": "button.{n}_bsh_common_command_resumeprogram",
        "abort": "button.{n}_bsh_common_command_abortprogram", "childlock": "switch.{n}_bsh_common_setting_childlock",
        "light": "binary_sensor.{n}_bsh_common_status_interiorilluminationactive",
        # remote control: choose a program, set its options, then start it
        "selected": "select.{n}_bsh_common_root_selectedprogram", "active": "select.{n}_bsh_common_root_activeprogram",
        "setpointSet": "number.{n}_cooking_oven_option_setpointtemperature", "duration": "number.{n}_bsh_common_option_duration",
        "fastpreheat": "switch.{n}_cooking_oven_option_fastpreheat", "lamp": "switch.{n}_cooking_oven_setting_light_cavity_001_power",
        "startAllowed": "binary_sensor.{n}_bsh_common_status_remotecontrolstartallowed",
        "powerstate": "select.{n}_bsh_common_setting_powerstate",
    },
    "hob": {
        "op": "sensor.{n}_bsh_common_status_operationstate", "power": "sensor.{n}_bsh_common_setting_powerstate",
        "zone1": "sensor.{n}_cooking_hob_status_zone_100_powerlevel", "zone2": "sensor.{n}_cooking_hob_status_zone_200_powerlevel",
        "zone3": "sensor.{n}_cooking_hob_status_zone_300_powerlevel", "zone4": "sensor.{n}_cooking_hob_status_zone_400_powerlevel",
        "childlock": "binary_sensor.{n}_bsh_common_setting_childlock",
        "filter": "sensor.{n}_cooking_hob_status_carbonfiltersaturation", "filterReset": "button.{n}_cooking_hob_command_carbonfilterreset",
        "vent": "select.{n}_cooking_hob_setting_ventilation", "airmode": "select.{n}_cooking_hob_setting_aircirculationmode",
    },
    "filter": {
        "active": "binary_sensor.{n}_statisch_4_kv_filter", "mode": "sensor.{n}_modus", "airflow": "sensor.{n}_luchtstroom",
        "cell1": "sensor.{n}_looptijd_plasmacel_1", "cell2": "sensor.{n}_looptijd_plasmacel_2",
        "voltage": "sensor.{n}_spanning", "current": "sensor.{n}_stroom",
    },
    "fridge": {
        "temp": "sensor.{n}", "setpoint": "number.{n}_setpoint", "supercool": "switch.{n}_supercool",
        "party": "switch.{n}_partymode", "night": "switch.{n}_nightmode",
    },
    # A DLNA media player, with a Wake on LAN button renamed after it in Home Assistant.
    "tv": {"player": "media_player.{n}", "wake": "button.{n}_aanzetten"},
}


# Sensor card entities by kind: key -> entity id template ({n} = the device name).
SENSOR_ENTITIES = {
    "presence": {"presence": "binary_sensor.{n}_presence", "temperature": "sensor.{n}_temperature",
                 "humidity": "sensor.{n}_humidity", "illuminance": "sensor.{n}_illuminance",
                 "distance": "sensor.{n}_target_distance", "battery": "sensor.{n}_battery"},
    "motion": {"occupancy": "binary_sensor.{n}_occupancy", "battery": "sensor.{n}_battery"},
    "door": {"contact": "binary_sensor.{n}_contact", "tamper": "binary_sensor.{n}_tamper", "battery": "sensor.{n}_battery"},
    "window": {"contact": "binary_sensor.{n}_contact", "tamper": "binary_sensor.{n}_tamper", "battery": "sensor.{n}_battery"},
    "air": {"co2": "sensor.{n}_carbon_dioxide", "pm25": "sensor.{n}_pm2_5", "quality": "sensor.{n}_air_quality",
            "temperature": "sensor.{n}_temperature", "humidity": "sensor.{n}_humidity"},
    "climate": {"temperature": "sensor.{n}_temperature", "humidity": "sensor.{n}_humidity", "battery": "sensor.{n}_battery"},
    # a soil sensor in a plant pot (AOYAN AY-303Z): the soil's moisture, the
    # sensor's own verdict that it is dry and the level it warns at, and the air
    "plant": {"moisture": "sensor.{n}_soil_moisture", "dry": "binary_sensor.{n}_dry", "warning": "number.{n}_soil_warning",
              "temperature": "sensor.{n}_temperature", "humidity": "sensor.{n}_humidity", "battery": "sensor.{n}_battery"},
}


# Energy section entities by kind: key -> entity id template ({n} = the device name).
ENERGY_ENTITIES = {
    # The smart meter, as Home Assistant's DSMR integration names it (device
    # "Electricity meter"): what the house takes and gives back, both positive, in
    # total and per phase; four counters, tariff 1 (dal) and 2 (normaal) for each
    # direction; the phases' current and voltage; the grid's quality as the meter
    # counts it. "net" is the net power Home Assistant's energy dashboard derives
    # (signed, W), which has history for the chart.
    "grid": {
        "powerIn": "sensor.{n}_power_consumption", "powerOut": "sensor.{n}_power_production",
        "net": "sensor.energy_grid_{n}_power_consumption_{n}_power_production_net_power",
        "import1": "sensor.{n}_energy_consumption_tarif_1", "import2": "sensor.{n}_energy_consumption_tarif_2",
        "export1": "sensor.{n}_energy_production_tarif_1", "export2": "sensor.{n}_energy_production_tarif_2",
        "tariff": "sensor.{n}_active_tariff",
        "failShort": "sensor.{n}_short_power_failure_count", "failLong": "sensor.{n}_long_power_failure_count",
        **{f"{key}{p}": f"sensor.{{n}}_{obj}_phase_l{p}" for p in (1, 2, 3) for key, obj in (
            ("in", "power_consumption"), ("out", "power_production"), ("current", "current"),
            ("voltage", "voltage"), ("sags", "voltage_sags"), ("swells", "voltage_swells"))},
    },
    "washer": {k: APPLIANCE_ENTITIES["washer"][k] for k in ("power", "energy", "water", "machine")},
    "dryer": {k: APPLIANCE_ENTITIES["dryer"][k] for k in ("power", "energy", "machine")},
    "car": {key: f"{domain}.{{n}}_{object_id}" for key, domain, object_id in TESLA_FLEET_ENTITIES
            if key in ("battery", "charging", "chargerPower", "chargerVoltage", "chargerCurrent", "energyAdded", "location")},
    "bike": {"battery": "sensor.{n}_battery", "energy": "sensor.{n}_energy_used_total",
             "average": "sensor.{n}_energy_used_average", "distance": "sensor.{n}_total_distance"},
    # the heat pump's own counters: heat delivered, not electricity used
    "heatpump": {k: _HEATPUMP[k] for k in ("status", "compressor", "alarm", "freq", "outdoor", "room",
                                           "hotWaterTop", "heat", "heatAdd", "water", "waterAdd", "cool")},
    "battery": {"soc": "sensor.{n}_soc", "power": "sensor.{n}_power", "voltage": "sensor.{n}_voltage",
                **{f"cell{c}": f"sensor.{{n}}_cell_{c}" for c in (1, 2, 3, 4)}, "delta": "sensor.{n}_cell_delta",
                "cycles": "sensor.{n}_cycles", "health": "sensor.{n}_health", "temp": "sensor.{n}_mosfet_temp",
                "charged": "sensor.{n}_energy_charged", "discharged": "sensor.{n}_energy_discharged"},
}


def parse_device_table(src, table, kinds):
    """A table of { kind, label, name } rows -> [{kind, label, name, entities}],
    the entity ids filled in from the kind's templates."""
    rows = table_rows(src, table, r'\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}')
    if not rows:
        fail(f"{table} is empty or unparsable")
    out = []
    for kind, label, name in rows:
        if kind not in kinds:
            fail(f"{table} {label!r}: unknown kind {kind!r}")
        if not re.fullmatch(r"[a-z0-9_]+", name):
            fail(f"{table} {label!r}: bad name {name!r}")
        out.append({"kind": kind, "label": label, "name": name,
                    "entities": {k: t.format(n=name) for k, t in kinds[kind].items()}})
    return out


def parse_energy(src):
    devices = parse_device_table(src, "PANEL_ENERGY", ENERGY_ENTITIES)
    if sum(d["kind"] == "grid" for d in devices) > 1:
        fail("PANEL_ENERGY: more than one grid meter")
    return devices


def parse_appliances(src, media, robots):
    """robots: floor label -> {"type", "entities"} of the Schoonmaak section's robots."""
    rows = table_rows(src, "PANEL_APPLIANCES", r'\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}')
    if not rows:
        fail("PANEL_APPLIANCES is empty or unparsable")
    labels = {m["id"]: m["label"] for m in media}
    out = []
    for kind, label, name in rows:
        if kind == "robot":
            # name is the floor of a robot in PANEL_VACUUM / PANEL_TUYA_VACUUMS
            if name not in robots:
                fail(f"PANEL_APPLIANCES {label!r}: no robot vacuum on floor {name!r}")
            out.append({"kind": kind, "label": label, "name": name, "floor": name,
                        "robot": robots[name]["type"], "entities": robots[name]["entities"]})
            continue
        if kind == "speakers":
            # name lists the players' object ids; their labels come from PANEL_MEDIA_PLAYERS
            keys = name.split()
            missing = [k for k in keys if f"media_player.{k}" not in labels]
            if not keys or missing:
                fail(f"PANEL_APPLIANCES {label!r}: players {missing or 'none'} are not in PANEL_MEDIA_PLAYERS")
            out.append({"kind": kind, "label": label, "name": name,
                        "entities": {k: f"media_player.{k}" for k in keys},
                        "players": [{"key": k, "label": labels[f"media_player.{k}"]} for k in keys]})
            continue
        if kind not in APPLIANCE_ENTITIES:
            fail(f"PANEL_APPLIANCES {label!r}: unknown kind {kind!r}")
        if not re.fullmatch(r"[a-z0-9_]+", name):
            fail(f"PANEL_APPLIANCES {label!r}: bad name {name!r}")
        out.append({"kind": kind, "label": label, "name": name,
                    "entities": {k: t.format(n=name) for k, t in APPLIANCE_ENTITIES[kind].items()}})
    return out


def parse_car(src):
    car = string_struct(src, "PANEL_CAR", ("label", "name"))
    label, name = car["label"], car["name"]
    if not re.fullmatch(r"[a-z0-9_]+", name):
        fail(f"PANEL_CAR: expected a car name like \"vlm\", found {name!r}")
    entities = {key: f"{domain}.{name}_{object_id}" for key, domain, object_id in TESLA_FLEET_ENTITIES}
    return {"label": label, "name": name, "entities": entities,
            # the header column's four
            "battery": entities["battery"], "range": entities["range"],
            "charging": entities["charging"], "lock": entities["lock"]}


def parse_covers(src, tabs):
    """PANEL_COVERS -> [{label, tab (index), opening, entities: {cover, vent}}]."""
    rows = table_rows(src, "PANEL_COVERS",
                      r'\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*("[^"]+"|NULL)\s*\}')
    names = [t["name"] for t in tabs]
    plan = (ROOT / "web" / "js" / "house-plan.js").read_text()
    out = []
    for label, tab, opening, cover, vent in rows:
        if tab not in names:
            fail(f"PANEL_COVERS {label!r}: no tab {tab!r}")
        if not re.search(r'key:\s*"' + re.escape(opening) + '"', plan):
            fail(f"PANEL_COVERS {label!r}: no opening {opening!r} in house-plan.js")
        if not cover.startswith("cover."):
            fail(f"PANEL_COVERS {label!r}: {cover!r} is not a cover entity")
        out.append({"label": label, "tab": names.index(tab), "opening": opening,
                    "entities": {"cover": cover, "vent": c_string_or_null(vent)}})
    return out


def parse_areas(src, tabs):
    """PANEL_AREAS -> tabs[i]["areas"] = [{label, lights: [ids]}]."""
    names = [t["name"] for t in tabs]
    for t in tabs:
        t["areas"] = []
    rows = table_rows(src, "PANEL_AREAS", r'\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\}')
    if not rows:
        fail("PANEL_AREAS is empty or unparsable")
    for tab, label, lights in rows:
        if tab not in names:
            fail(f"PANEL_AREAS: no tab named {tab!r}")
        ids = lights.split()
        bad = [i for i in ids if not re.fullmatch(r"light\.[a-z0-9_]+", i)]
        if not ids or bad:
            fail(f"PANEL_AREAS {label!r}: expected light entity ids, got {bad or 'nothing'}")
        tabs[names.index(tab)]["areas"].append({"label": label, "lights": ids})


def parse_layout(src, tabs):
    names = [t["name"] for t in tabs]

    def tab_index(name, where):
        if name not in names:
            fail(f"{where}: no tab named {name!r} in PANEL_TABS")
        return names.index(name)

    floors = [{"tab": tab_index(t, "PANEL_FLOORS"), "label": l, "name": n}
              for t, l, n in table_rows(src, "PANEL_FLOORS", r'\{\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\}')]
    # Tab icon per section kind (name from web/js/icons.js). "tab" is the
    # garage lights page; adjust here if a different tab is ever added.
    section_icons = {"start": "home", "floors": "lights", "appliances": "plug", "vacuum": "vacuum",
                     "car": "car", "sensors": "eye", "energy": "bolt", "tab": "garage"}
    sections = []
    for name, kind, tab in table_rows(src, "PANEL_SECTIONS", r'\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*("[^"]*"|NULL)\s*\}'):
        if kind not in section_icons:
            fail(f"PANEL_SECTIONS: unknown kind {kind!r}")
        tab_name = c_string_or_null(tab)
        if (kind == "tab") != (tab_name is not None):
            fail(f"PANEL_SECTIONS: {name!r} of kind {kind!r} {'needs' if kind == 'tab' else 'takes no'} tab")
        sections.append({"name": name, "kind": kind, "icon": section_icons.get(kind, "power"),
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
    try:
        return float(tok.rstrip("fF"))
    except ValueError:
        fail(f"#define {name}: expected a number, got {tok!r}")


def parse_themes(src):
    body = array_body(src, "PANEL_THEMES")
    themes = []
    for block in re.findall(r"\{(\s*\.name.*?)\}", body, re.S):
        name = re.search(r'\.name\s*=\s*"([^"]+)"', block).group(1)
        colours = {k: "#%06x" % int(v, 16)
                   for k, v in re.findall(r"\.(\w+)\s*=\s*0x([0-9a-fA-F]{6})", block)}
        edge = colours.pop("edge", None)
        if len(colours) != 16:
            fail(f"theme {name}: expected 16 colours, found {len(colours)}")
        theme = {"name": name, **colours}
        # the web panel's look beyond colour: typeface, display face, roundness, edge line
        for key in ("font", "display"):
            m = re.search(r"\.%s\s*=\s*\"([^\"]+)\"" % key, block)
            if m:
                theme[key] = m.group(1)
        m = re.search(r"\.round\s*=\s*(\d+)", block)
        if m and int(m.group(1)) != 100:
            theme["round"] = int(m.group(1))
        if re.search(r"\.glow\s*=\s*1", block):
            theme["glow"] = 1
        if edge:
            theme["edge"] = edge
        themes.append(theme)
    if not themes:
        fail("PANEL_THEMES is empty")
    return themes


def main():
    cfg = strip_comments(CONFIG_H.read_text())
    tabs = parse_tabs(cfg)
    parse_areas(cfg, tabs)
    floors, sections = parse_layout(cfg, tabs)
    media = entity_table(cfg, "PANEL_MEDIA_PLAYERS")
    vacuum = parse_vacuum(cfg)
    if vacuum["floor"] not in [f["label"] for f in floors]:
        fail(f"PANEL_VACUUM: no floor labelled {vacuum['floor']!r} in PANEL_FLOORS")
    tuya_vacuums = parse_tuya_vacuums(cfg, floors, {vacuum["floor"]})
    # The robots by floor, with the entities their Apparaten card shows.
    robots = {vacuum["floor"]: {"type": "xiaomi", "entities": {k: vacuum[k] for k in ("vacuum", "status", "battery", "area")}}}
    for r in tuya_vacuums:
        robots[r["floor"]] = {"type": "tuya", "entities": {k: r["entities"][k] for k in ("vacuum", "battery", "area", "time", "problem")}}
    config = {
        "weather": define(cfg, "PANEL_WEATHER_ENTITY", "str"),
        "health": {"zigbee": define(cfg, "PANEL_ZIGBEE_BRIDGE", "str"), "internet": define(cfg, "PANEL_INTERNET", "str"), "rain": define(cfg, "PANEL_RAIN_NOW", "str")},
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
        "vacuum": vacuum,
        "tuyaVacuums": tuya_vacuums,
        "bike": parse_bike(cfg),
        "car": parse_car(cfg),
        "appliances": parse_appliances(cfg, media, robots),
        "sensorCards": parse_device_table(cfg, "PANEL_SENSOR_CARDS", SENSOR_ENTITIES),
        "covers": parse_covers(cfg, tabs),
        "energy": parse_energy(cfg),
        "media": media,
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
