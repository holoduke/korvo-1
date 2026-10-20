"""Wat de gereedschappen van Huiskennis delen: tijden, waar een entiteit staat,
wat aan Assist is blootgesteld, en de basis van een gereedschap."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.homeassistant.exposed_entities import async_should_expose
from homeassistant.core import HomeAssistant, State
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er, floor_registry as fr, llm
from homeassistant.util import dt as dt_util
from homeassistant.util.json import JsonObjectType

from .const import DOMAIN

ASSISTANT = "conversation"  # de blootstelling van Assist

# Eigenschappen die iets zeggen; de rest (iconen, kleuren, lijsten) blijft weg.
ATTRIBUTES = {
    "unit_of_measurement", "device_class", "current_temperature", "temperature", "target_temp_low",
    "target_temp_high", "hvac_action", "current_humidity", "humidity", "brightness", "color_temp_kelvin",
    "media_title", "media_artist", "media_album_name", "source", "volume_level", "battery_level",
    "current_position", "preset_mode", "percentage", "fan_mode", "status", "next_dawn", "next_setting",
    "next_rising", "wind_speed", "pressure", "condition",
}


def _local(t: datetime) -> str:
    return dt_util.as_local(t).strftime("%Y-%m-%d %H:%M")


class _Places:
    """Waar een entiteit staat: haar ruimte (of die van haar apparaat) en de verdieping."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.ents = er.async_get(hass)
        self.devs = dr.async_get(hass)
        self.areas = ar.async_get(hass)
        self.floors = fr.async_get(hass)

    def area(self, entity_id: str) -> ar.AreaEntry | None:
        entry = self.ents.async_get(entity_id)
        if entry is None:
            return None
        area_id = entry.area_id
        if area_id is None and entry.device_id and (dev := self.devs.async_get(entry.device_id)):
            area_id = dev.area_id
        return self.areas.async_get_area(area_id) if area_id else None

    def floor(self, area: ar.AreaEntry | None) -> str | None:
        if area is None or not area.floor_id:
            return None
        floor = self.floors.async_get_floor(area.floor_id)
        return floor.name if floor else None

    def name(self, state: State) -> str:
        return state.name or state.entity_id


def _exposed(hass: HomeAssistant) -> list[State]:
    return [s for s in hass.states.async_all() if async_should_expose(hass, ASSISTANT, s.entity_id)]


def _check(hass: HomeAssistant, entity_id: str) -> State:
    state = hass.states.get(entity_id)
    if state is None or not async_should_expose(hass, ASSISTANT, entity_id):
        raise HomeAssistantError(f"onbekende entiteit {entity_id}: zoek de juiste id met huis_nu")
    return state


def _attrs(state: State) -> dict[str, Any]:
    return {k: v for k, v in state.attributes.items() if k in ATTRIBUTES and v is not None}


def _number(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class _Tool(llm.Tool):
    """Gereedschap van Huiskennis: leest alleen, binnen Home Assistant. Een
    antwoord met "fout" is een fout voor het taalmodel."""

    integration = DOMAIN
    annotations = llm.ToolAnnotations(read_only=True, destructive=False, idempotent=True, open_world=False)

    async def async_call(self, hass: HomeAssistant, tool_input: llm.ToolInput, llm_context: llm.LLMContext) -> llm.ToolResult:
        data = await self._call(hass, tool_input)
        return llm.ToolResult(data=data, error="fout" in data)

    async def _call(self, hass: HomeAssistant, tool_input: llm.ToolInput) -> JsonObjectType:
        raise NotImplementedError
