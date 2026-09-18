"""De gespreksagent "Thuis": vragen over het huis, beantwoord door een
taalmodel (xAI) dat een momentopname van het huis meekrijgt — welke lampen aan
zijn, welke deuren en ramen open, temperaturen, de robots, de apparaten, en
wat er de laatste uren gebeurde. Het kan niets bedienen: het leest alleen.

Het paneel praat ermee via conversation/process (agent_id conversation.thuis);
de Home Assistant-app op een telefoon via Assist, als deze agent daar gekozen
is."""
from __future__ import annotations

from datetime import timedelta
import logging
from typing import Any

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, State
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er, intent
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import CONF_MODEL, CONF_XAI_KEY, DEFAULT_MODEL, DOMAIN, XAI_URL

_LOGGER = logging.getLogger(__name__)

RECENT = timedelta(hours=3)
MAX_RECENT = 30
MAX_HISTORY = 8  # beurten uit het gesprek die meegaan

SYSTEM = """Je bent "Thuis", de stem van een woonhuis in Nederland. Je krijgt hieronder
een momentopname van het huis en wat er de laatste uren gebeurde. Antwoord kort
en concreet, in het Nederlands (of in het Engels als de vraag Engels is), in
hooguit twee zinnen, zonder opsommingstekens. Gebruik alleen wat hieronder staat;
weet je iets niet, zeg dat. Je kunt niets bedienen: wil iemand iets laten doen,
zeg dan vriendelijk dat dat via het paneel gaat. Getallen met een komma, tijden
als 14:05."""


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([ThuisAgent(entry)])


class ThuisAgent(conversation.ConversationEntity):
    """De agent, één per entry."""

    _attr_has_entity_name = True
    _attr_name = "Thuis"
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = entry.entry_id

    @property
    def supported_languages(self) -> list[str]:
        return ["nl", "en"]

    async def _async_handle_message(self, user_input: conversation.ConversationInput, chat_log: conversation.ChatLog) -> conversation.ConversationResult:
        response = intent.IntentResponse(language=user_input.language)
        try:
            text = await self._ask(user_input.text, chat_log)
        except Exception as err:  # noqa: BLE001 - het antwoord is dan de fout
            _LOGGER.warning("Thuis kon niet antwoorden: %s", err)
            response.async_set_error(intent.IntentResponseErrorCode.UNKNOWN, f"Ik kan het nu niet nakijken ({err}).")
            return conversation.ConversationResult(response=response, conversation_id=chat_log.conversation_id)
        chat_log.async_add_assistant_content_without_tools(conversation.AssistantContent(agent_id=self.entity_id, content=text))
        response.async_set_speech(text)
        return conversation.ConversationResult(response=response, conversation_id=chat_log.conversation_id)

    async def _ask(self, question: str, chat_log: conversation.ChatLog) -> str:
        key = self._entry.data.get(CONF_XAI_KEY)
        if not key:
            raise RuntimeError("geen sleutel voor het taalmodel")
        snapshot = await self.hass.async_add_executor_job(snapshot_of, self.hass)
        messages: list[dict[str, str]] = [{"role": "system", "content": SYSTEM + "\n\n" + snapshot}]
        # de laatste beurten van dit gesprek, voor "en in de keuken?"
        turns = [c for c in chat_log.content if getattr(c, "role", "") in ("user", "assistant") and getattr(c, "content", None)]
        for c in turns[-MAX_HISTORY:]:
            if c.role == "user" and c.content == question:
                continue
            messages.append({"role": c.role, "content": c.content})
        messages.append({"role": "user", "content": question})
        session = async_get_clientsession(self.hass)
        async with session.post(
            XAI_URL,
            json={"model": self._entry.data.get(CONF_MODEL) or DEFAULT_MODEL, "messages": messages, "temperature": 0.3, "max_tokens": 300},
            headers={"Authorization": f"Bearer {key}"},
            timeout=40,
        ) as res:
            if res.status != 200:
                raise RuntimeError(f"taalmodel antwoordt {res.status}")
            data = await res.json()
        return (data["choices"][0]["message"]["content"] or "").strip()


# ---- De momentopname ------------------------------------------------------------------------

DOOR_CLASSES = {"door", "window", "garage_door", "opening"}
PRESENCE_CLASSES = {"occupancy", "motion", "presence"}
SENSOR_CLASSES = {"temperature", "humidity", "carbon_dioxide", "pm25", "battery", "power", "illuminance"}
UNITS = {"temperature": "°C", "humidity": "%", "carbon_dioxide": "ppm", "pm25": "µg/m³", "battery": "%", "power": "W", "illuminance": "lx"}


def _fmt(state: State) -> str:
    """Een getal met komma en eenheid, of de toestand zelf."""
    try:
        v = float(state.state)
    except ValueError:
        return state.state
    unit = state.attributes.get("unit_of_measurement") or ""
    text = f"{v:.1f}".rstrip("0").rstrip(".") if abs(v) < 1000 else f"{v:.0f}"
    return f"{text.replace('.', ',')} {unit}".strip()


def snapshot_of(hass: HomeAssistant) -> str:
    """Het huis in tekst, per ruimte, plus wat de laatste uren veranderde."""
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)
    area_reg = ar.async_get(hass)
    now = dt_util.now()

    def area_of(entity_id: str) -> str:
        entry = ent_reg.async_get(entity_id)
        if entry is None:
            return "Overig"
        area_id = entry.area_id
        if not area_id and entry.device_id:
            device = dev_reg.async_get(entry.device_id)
            area_id = device.area_id if device else None
        area = area_reg.async_get_area(area_id) if area_id else None
        return area.name if area else "Overig"

    rooms: dict[str, list[str]] = {}
    recent: list[tuple[Any, str]] = []
    lights_unavailable = 0

    def add(entity_id: str, line: str) -> None:
        rooms.setdefault(area_of(entity_id), []).append(line)

    for state in hass.states.async_all():
        domain = state.domain
        name = state.name
        dc = state.attributes.get("device_class")
        if domain == "light":
            if state.state == "unavailable":
                lights_unavailable += 1
                continue
            if "_group" in state.entity_id or state.attributes.get("entity_id"):
                continue  # groepen niet apart tellen
            add(state.entity_id, f"lamp {name} {'aan' if state.state == 'on' else 'uit'}")
        elif domain == "binary_sensor" and dc in DOOR_CLASSES:
            word = "open" if state.state == "on" else "dicht" if state.state == "off" else state.state
            add(state.entity_id, f"{name}: {word}")
            if now - state.last_changed < RECENT and state.state in ("on", "off"):
                recent.append((state.last_changed, f"{name} {word}"))
        elif domain == "binary_sensor" and dc in PRESENCE_CLASSES:
            add(state.entity_id, f"{name}: {'iemand aanwezig' if state.state == 'on' else 'niemand'}")
        elif domain == "sensor" and dc in SENSOR_CLASSES and state.state not in ("unavailable", "unknown"):
            if dc == "power" or dc == "battery" or dc == "illuminance":
                continue  # te veel ruis voor een gesprek
            add(state.entity_id, f"{name}: {_fmt(state)}")
        elif domain == "vacuum":
            words = {"docked": "op het station", "cleaning": "aan het stofzuigen", "returning": "op weg naar het station", "paused": "gepauzeerd", "idle": "staat stil", "error": "storing"}
            add(state.entity_id, f"robotstofzuiger {name}: {words.get(state.state, state.state)}, accu {state.attributes.get('battery_level', '?')}%")
            if now - state.last_changed < RECENT:
                recent.append((state.last_changed, f"{name} {words.get(state.state, state.state)}"))
        elif domain == "media_player" and state.state == "playing":
            add(state.entity_id, f"{name} speelt {state.attributes.get('media_artist') or ''} {state.attributes.get('media_title') or ''}".strip())
        elif domain == "climate":
            add(state.entity_id, f"thermostaat {name}: {state.state}, doel {state.attributes.get('temperature')}°C, nu {state.attributes.get('current_temperature')}°C")
        elif domain == "lock":
            add(state.entity_id, f"slot {name}: {'op slot' if state.state == 'locked' else state.state}")
        elif domain == "cover":
            add(state.entity_id, f"{name}: {'open' if state.state == 'open' else 'dicht' if state.state == 'closed' else state.state}")
        elif domain == "weather":
            add(state.entity_id, f"weer: {state.state}, {state.attributes.get('temperature')}°C buiten")
        elif domain in ("switch", "select", "sensor") and any(k in state.entity_id for k in ("wasmachine", "droger", "dishwasher", "oven", "hob")):
            if dc is None and state.state not in ("unavailable", "unknown") and ("program" in state.entity_id or "operation" in state.entity_id or "remaining" in state.entity_id or "power" in state.entity_id):
                add(state.entity_id, f"{name}: {state.state}")
                if now - state.last_changed < RECENT:
                    recent.append((state.last_changed, f"{name}: {state.state}"))

    lines = [f"Nu: {now.strftime('%A %d %B %Y, %H:%M')}."]
    if lights_unavailable:
        lines.append(f"{lights_unavailable} lampen zijn niet bereikbaar (Zigbee).")
    for area, items in sorted(rooms.items(), key=lambda kv: (kv[0] == "Overig", kv[0])):
        lines.append(f"\n{area}:")
        lines.extend(f"- {item}" for item in items[:40])
    recent.sort(key=lambda r: r[0], reverse=True)
    if recent:
        lines.append("\nLaatste uren:")
        lines.extend(f"- {t.astimezone(dt_util.DEFAULT_TIME_ZONE).strftime('%H:%M')} {text}" for t, text in recent[:MAX_RECENT])
    return "\n".join(lines)
