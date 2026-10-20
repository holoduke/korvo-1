"""Meer leesgereedschap voor Huiskennis: het weer, het logboek (wat er gebeurde
en wie het deed), wie er thuis is, wat er mis is, en de automatiseringen."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

import voluptuous as vol

from homeassistant.components.homeassistant.exposed_entities import async_should_expose
from homeassistant.components.logbook.helpers import async_determine_event_types
from homeassistant.components.logbook.processor import EventProcessor
from homeassistant.components.recorder import get_instance
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir, llm
from homeassistant.util import dt as dt_util
from homeassistant.util.json import JsonObjectType

from .common import ASSISTANT, _Places, _local, _number, _Tool

MAX_LOG_HOURS = 72
MAX_LOG_ROWS = 150
LOW_BATTERY = 20
# domeinen waarvan het logboek altijd mag: huislogica, geen apparaten
LOGIC_DOMAINS = ("automation", "script", "scene")
# het hele huis: wat er gebeurt, niet wat er gemeten wordt
EVENT_DOMAINS = ("light", "switch", "cover", "lock", "climate", "media_player", "fan", "vacuum", "input_boolean", "person", *LOGIC_DOMAINS)
EVENT_CLASSES = ("door", "window", "garage_door", "opening", "motion", "occupancy", "presence", "moisture", "smoke", "problem")
SETTLE_S = 240  # na het stoppen of starten melden lampen en sensoren zich opnieuw: geen gebeurtenissen


DAYS = ("ma", "di", "wo", "do", "vr", "za", "zo")


def _when(value: str | None, kind: str) -> str | None:
    """Een verwachting per dag als datum met dag, per uur als tijd."""
    t = dt_util.parse_datetime(value) if value else None
    if t is None:
        return value
    if kind == "daily":
        # een dag begint om middernacht UTC of lokaal, naar gelang de dienst: twaalf uur later is het altijd die dag
        day = dt_util.as_local(t + timedelta(hours=12)).date()
        return f"{DAYS[day.weekday()]} {day.isoformat()}"
    return _local(t)


class Weer(_Tool):
    name = "weer"
    description = (
        "Het weer bij het huis: nu (per weerdienst), de verwachting per dag (7 dagen) of per uur (24 uur), en "
        "of het nu regent (radar)."
    )
    parameters = vol.Schema({vol.Optional("per", description="dag of uur; standaard dag"): vol.In(["dag", "uur"])})

    async def _call(self, hass: HomeAssistant, tool_input: llm.ToolInput) -> JsonObjectType:
        kind = "hourly" if tool_input.tool_args.get("per") == "uur" else "daily"
        out: dict[str, Any] = {"tijd": _local(dt_util.utcnow()), "nu": [], "verwachting": []}
        for state in hass.states.async_all("weather"):
            a = state.attributes
            out["nu"].append(
                {
                    "bron": state.name,
                    "weer": state.state,
                    **{nl: a[k] for k, nl in (("temperature", "temperatuur"), ("humidity", "vocht"), ("wind_speed", "wind"),
                                              ("wind_bearing", "windrichting"), ("pressure", "luchtdruk")) if a.get(k) is not None},
                }
            )
        for state in hass.states.async_all("weather"):
            try:
                resp = await hass.services.async_call(
                    "weather", "get_forecasts", {"entity_id": state.entity_id, "type": kind}, blocking=True, return_response=True
                )
            except Exception:  # noqa: BLE001 - deze dienst kan dit soort verwachting niet: de volgende
                continue
            rows = (resp or {}).get(state.entity_id, {}).get("forecast") or []
            if rows:
                out["bron_verwachting"] = state.name
                out["verwachting"] = [
                    {
                        "tijd": _when(r.get("datetime"), kind),
                        "weer": r.get("condition"),
                        **{nl: r[k] for k, nl in (("temperature", "max"), ("templow", "min"), ("precipitation", "neerslag_mm"),
                                                  ("precipitation_probability", "kans_neerslag"), ("wind_speed", "wind")) if r.get(k) is not None},
                    }
                    for r in rows[: 24 if kind == "hourly" else 7]
                ]
                break
        rain = [s for s in hass.states.async_all("sensor") if "precipitation" in s.entity_id and "buienradar" in s.entity_id]
        if rain:
            out["regen_nu"] = {s.name: f"{s.state} {s.attributes.get('unit_of_measurement', '')}".strip() for s in rain}
        return out


class Logboek(_Tool):
    name = "logboek"
    description = (
        "Wat er gebeurde in huis en wie of wat het deed (een persoon, een automatisering, een knop): voor één "
        "entiteit of het hele huis, de laatste uren (standaard 6, hooguit 72). Bijvoorbeeld wanneer de voordeur "
        "openging, wie de verwarming veranderde, welke automatisering de lampen aanzette."
    )
    parameters = vol.Schema(
        {
            vol.Optional("entity_id", description="leeg: het hele huis (gebeurtenissen: lampen, deuren, beweging, automatiseringen, wat iemand deed)"): str,
            vol.Optional("uren", description="standaard 6"): vol.Coerce(float),
            vol.Optional("zoek", description="alleen regels met dit stukje tekst"): str,
        }
    )

    async def _call(self, hass: HomeAssistant, tool_input: llm.ToolInput) -> JsonObjectType:
        args = tool_input.tool_args
        entity_id = (args.get("entity_id") or "").strip()
        if entity_id and entity_id.split(".")[0] not in LOGIC_DOMAINS and not async_should_expose(hass, ASSISTANT, entity_id):
            return {"fout": f"onbekende entiteit {entity_id}: zoek de juiste id met huis_nu"}
        hours = max(0.25, min(float(args.get("uren") or 6), MAX_LOG_HOURS))
        end = dt_util.utcnow()
        start = end - timedelta(hours=hours)
        ids = [entity_id] if entity_id else None
        processor = EventProcessor(hass, async_determine_event_types(hass, ids, None), ids, None, None, timestamp=True, include_entity_name=True)
        rows = await get_instance(hass).async_add_executor_job(processor.get_events, start, end)
        users = {u.id: u.name for u in await hass.auth.async_get_users()}
        text = (args.get("zoek") or "").strip().lower()
        out = []
        started: float | None = None
        for row in rows:
            eid = row.get("entity_id")
            # alleen wat blootgesteld is, en de huislogica
            if eid and eid.split(".")[0] not in LOGIC_DOMAINS and not async_should_expose(hass, ASSISTANT, eid):
                continue
            # Home Assistant stopt of start: de minuten daarna melden apparaten zich opnieuw
            if row.get("domain") == "homeassistant" and any(w in str(row.get("message", "")) for w in ("start", "stop")):
                started = row.get("when")
            # het hele huis: alleen gebeurtenissen (of wat een persoon deed), niet in de minuten na een herstart
            if not entity_id and not users.get(row.get("context_user_id")):
                if eid and not self._event(hass, eid):
                    continue
                if row.get("state") in ("unavailable", "unknown"):
                    continue
                # een automatisering die "aan" meldt, is herladen; wat telt is dat ze liep
                if eid and eid.split(".")[0] in ("automation", "script") and not row.get("message"):
                    continue
                if isinstance(started, (int, float)) and isinstance(row.get("when"), (int, float)) and 0 <= row["when"] - started < SETTLE_S:
                    continue
            line: dict[str, Any] = {
                "tijd": _local(dt_util.utc_from_timestamp(row["when"])) if isinstance(row.get("when"), (int, float)) else row.get("when"),
                "wat": row.get("name") or eid,
            }
            if row.get("state") is not None:
                line["toestand"] = row["state"]
            if row.get("message"):
                line["bericht"] = row["message"]
            who = users.get(row.get("context_user_id")) or row.get("context_name") or row.get("context_entity_id")
            if who:
                line["door"] = who
            if text and text not in str(line).lower():
                continue
            out.append(line)
        return {"uren": hours, "aantal": len(out), "regels": out[-MAX_LOG_ROWS:], "afgekapt": len(out) > MAX_LOG_ROWS}


    @staticmethod
    def _event(hass: HomeAssistant, entity_id: str) -> bool:
        """Iets dat gebeurt (een lamp, een deur, een automatisering), geen meting."""
        domain = entity_id.split(".")[0]
        if domain in EVENT_DOMAINS:
            return True
        state = hass.states.get(entity_id)
        return domain == "binary_sensor" and bool(state) and state.attributes.get("device_class") in EVENT_CLASSES


class Aanwezigheid(_Tool):
    name = "aanwezigheid"
    description = (
        "Wie er thuis is (de personen in Home Assistant: thuis of weg, sinds wanneer) en in welke ruimtes nu "
        "beweging of aanwezigheid is."
    )
    parameters = vol.Schema({})

    async def _call(self, hass: HomeAssistant, tool_input: llm.ToolInput) -> JsonObjectType:
        places = _Places(hass)
        people = [
            {"naam": s.name, "toestand": {"home": "thuis", "not_home": "weg"}.get(s.state, s.state), "sinds": _local(s.last_changed)}
            for s in hass.states.async_all("person")
        ]
        rooms = []
        for s in hass.states.async_all("binary_sensor"):
            if s.attributes.get("device_class") not in ("occupancy", "presence", "motion") or s.state != "on":
                continue
            if not async_should_expose(hass, ASSISTANT, s.entity_id):
                continue
            area = places.area(s.entity_id)
            rooms.append({"sensor": s.name, "ruimte": area.name if area else None, "sinds": _local(s.last_changed)})
        return {"personen": people, "beweging_nu": rooms}


class Problemen(_Tool):
    name = "problemen"
    description = (
        "Wat er mis is in huis: apparaten die niet bereikbaar zijn (per ruimte), lege batterijen, storingen, "
        "meldingen van Home Assistant zelf en beschikbare updates."
    )
    parameters = vol.Schema({})

    async def _call(self, hass: HomeAssistant, tool_input: llm.ToolInput) -> JsonObjectType:
        places = _Places(hass)
        down: dict[str, list[str]] = {}
        for s in hass.states.async_all():
            if s.state != "unavailable" or not async_should_expose(hass, ASSISTANT, s.entity_id):
                continue
            area = places.area(s.entity_id)
            down.setdefault(area.name if area else "zonder ruimte", []).append(s.name)
        batteries = sorted(
            (
                {"naam": s.name, "batterij": v}
                for s in hass.states.async_all("sensor")
                if s.attributes.get("device_class") == "battery" and (v := _number(s.state)) is not None and v <= LOW_BATTERY
            ),
            key=lambda r: r["batterij"],
        )
        faults = [
            {"naam": s.name, "melding": s.state}
            for s in hass.states.async_all("sensor")
            if any(w in s.entity_id for w in ("storing", "error", "fout")) and s.state not in ("Geen", "none", "None", "0", "unknown", "unavailable", "", "ok", "OK")
            and async_should_expose(hass, ASSISTANT, s.entity_id)
        ]
        issues = [
            {"bron": i.domain, "melding": i.translation_key or i.issue_id, "ernst": str(i.severity)}
            for i in ir.async_get(hass).issues.values()
            if i.active and not i.dismissed_version
        ]
        updates = [s.attributes.get("title") or s.name for s in hass.states.async_all("update") if s.state == "on"]
        return {
            "niet_bereikbaar": {room: sorted(names) for room, names in sorted(down.items())},
            "aantal_niet_bereikbaar": sum(len(v) for v in down.values()),
            "batterij_bijna_leeg": batteries,
            "storingen": faults,
            "meldingen_home_assistant": issues,
            "updates": updates,
        }


class Automatiseringen(_Tool):
    name = "automatiseringen"
    description = (
        "De automatiseringen van het huis: naam, aan of uit, wanneer ze voor het laatst liepen en wat ze doen. "
        "Filter met zoek. Aan- of uitzetten of uitvoeren gaat met bedien (domein automation)."
    )
    parameters = vol.Schema({vol.Optional("zoek", description="een stukje van de naam"): str})

    async def _call(self, hass: HomeAssistant, tool_input: llm.ToolInput) -> JsonObjectType:
        text = (tool_input.tool_args.get("zoek") or "").strip().lower()
        rows = []
        for s in hass.states.async_all("automation"):
            if text and text not in s.name.lower() and text not in s.entity_id:
                continue
            last = s.attributes.get("last_triggered")
            rows.append(
                {
                    "entity_id": s.entity_id,
                    "naam": s.name,
                    "toestand": {"on": "aan", "off": "uit"}.get(s.state, s.state),
                    "laatst": _local(last) if hasattr(last, "tzinfo") else last,
                    **({"wat": s.attributes["description"]} if s.attributes.get("description") else {}),
                }
            )
        return {"aantal": len(rows), "automatiseringen": sorted(rows, key=lambda r: r["naam"])}
