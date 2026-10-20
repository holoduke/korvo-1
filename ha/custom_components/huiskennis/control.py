"""Bedienen via Huiskennis.

- bedien: alles wat aan Assist is blootgesteld (Instellingen > Spraakassistenten
  > Blootstellen), met per domein de handelingen die erbij horen: lampen
  (helderheid, kleur, wit), schakelaars, scènes, scripts, knoppen, muziek,
  klimaat, stofzuigers, kleppen, getallen en keuzelijsten; per entiteit, of
  per ruimte en domein ("alle lampen in de keuken"). Automatiseringen aan, uit
  of uitvoeren, ook als ze niet blootgesteld zijn.
- instelling: een vaste lijst instellingen van dit huis (SETTINGS) die niet
  blootgesteld zijn, met hun grenzen: de warmtepomp, de ventilatie, de
  garagedeur, de stofzuiger per kamer, de oven en de kookplaat.
- melding: een bericht naar een telefoon met de Home Assistant-app.
- omroep: een zin uitspreken op een (blootgestelde) speaker.

Wat niet blootgesteld is en niet in SETTINGS staat, kan niet. Elke handeling
draagt de context van wie hem vroeg, dus het logboek toont haar of zijn naam."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import voluptuous as vol

from homeassistant.components.homeassistant.exposed_entities import async_should_expose
from homeassistant.core import HomeAssistant, State
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er, floor_registry as fr, llm
from homeassistant.util import color as color_util
from homeassistant.util import slugify
from homeassistant.util.json import JsonObjectType

from .common import ASSISTANT
from .const import DOMAIN

UNAVAILABLE = ("unavailable", "unknown")
KELVIN = (2000, 6500)

# Kleuren in woorden: een kleur als RGB, wit als kleurtemperatuur (kelvin).
COLOURS: dict[str, tuple[int, int, int]] = {
    "rood": (255, 0, 0), "oranje": (255, 120, 0), "geel": (255, 220, 0), "groen": (0, 255, 0),
    "cyaan": (0, 255, 255), "turquoise": (0, 220, 200), "blauw": (0, 0, 255), "paars": (140, 0, 255),
    "lila": (200, 150, 255), "roze": (255, 105, 180), "magenta": (255, 0, 255),
}
WHITES: dict[str, int] = {"warm wit": 2700, "wit": 4000, "neutraal wit": 4000, "koel wit": 5000, "koud wit": 6500, "daglicht": 6500}


@dataclass(frozen=True, slots=True)
class Setting:
    """Een instelling: een number (of een script met een getal, veld) binnen
    grenzen, een select met vertaalde keuzes, een script dat alleen iets
    uitzet, of iets met een dienst per keuze (acties)."""

    entity_id: str
    uitleg: str
    minimum: float | None = None
    maximum: float | None = None
    stap: float = 0.5
    keuzes: dict[str, str] = field(default_factory=dict)  # Nederlands -> optie van de entiteit
    acties: dict[str, tuple[str, str, str]] = field(default_factory=dict)  # keuze -> (domein, dienst, entiteit)
    veld: str | None = None  # een script met een getal: de naam van zijn veld


SETTINGS: dict[str, Setting] = {
    "kamertemperatuur": Setting(
        "number.f1253_6_r_pc_em_room_sensor_set_point_value_heating_climate_system_1",
        "De gewenste kamertemperatuur van de warmtepomp (verwarmen), in °C. Het huis reageert traag: "
        "een halve graad verschil merk je pas na uren.",
        minimum=18,
        maximum=23,
    ),
    "warm_water": Setting(
        "select.f1253_6_r_pc_em_hot_water_demand",
        "Hoeveel warm water de warmtepomp klaarhoudt. Zuinig is de gewone stand; bij veel zon zet een "
        "automatisering hem zelf op normaal en om 17:00 terug op zuinig.",
        keuzes={"zuinig": "Economy", "normaal": "Normal", "luxe": "Lux"},
    ),
    "warm_water_extra": Setting(
        "select.f1253_6_r_pc_em_hot_water_boost",
        "Tijdelijk extra warm water (bijvoorbeeld voor een bad of logees): eenmalig of een aantal uren.",
        keuzes={"uit": "Off", "eenmalig": "One-time increase", "3 uur": "3 hr", "6 uur": "6 hr", "12 uur": "12 hr"},
    ),
    "ventilatie": Setting(
        "select.wtw_stand",
        "De stand van de ventilatie (WTW). Automatisch is de gewone stand; boost loopt na de tijd vanzelf "
        "terug; afwezig ventileert zo weinig mogelijk.",
        keuzes={
            "automatisch": "AUTO",
            "stand 1": "CNT1",
            "stand 2": "CNT2",
            "stand 3": "CNT3",
            "boost 15 minuten": "MAN3",
            "boost 30 minuten": "MAN3x2",
            "boost 45 minuten": "MAN3x3",
            "afwezig": "EMPT",
        },
    ),
    "garagedeur": Setting(
        "cover.garagedeur",
        "De garagedeur (Hörmann roldeur). Open, dicht, stop, of op kier (een stukje open om te ventileren). "
        "Er is geen echte positiemeting: Home Assistant telt de impulsen; bediening met de afstandsbediening "
        "ziet het pas als de deur dicht is. Vraag altijd eerst om bevestiging.",
        keuzes={"open": "open", "dicht": "closed", "stop": "", "kier": ""},
        acties={
            "open": ("cover", "open_cover", "cover.garagedeur"),
            "dicht": ("cover", "close_cover", "cover.garagedeur"),
            "stop": ("cover", "stop_cover", "cover.garagedeur"),
            "kier": ("button", "press", "button.garagedeur_ventilatie"),
        },
    ),
    "ventilatie_bypass": Setting(
        "select.wtw_bypass_stand",
        "De bypass van de ventilatie: automatisch (de gewone stand), dicht (altijd warmte terugwinnen) of "
        "open (nooit: koele buitenlucht rechtstreeks naar binnen, voor zomernachten).",
        keuzes={"automatisch": "Automatisch", "dicht": "Dicht", "open": "Open"},
    ),
    "stofzuigen": Setting(
        "vacuum.stofzuiger",
        "De robotstofzuiger beneden een kamer laten doen, of terug laten gaan naar zijn station. Vraag eerst "
        "om bevestiging: hij gaat meteen rijden.",
        keuzes={"keuken en eetkamer": "", "zitkamer achter": "", "gameroom": "", "gang": "", "garage": "", "terug naar station": ""},
        acties={
            "keuken en eetkamer": ("script", "turn_on", "script.stofzuig_keuken"),
            "zitkamer achter": ("script", "turn_on", "script.stofzuig_zitkamer_achter"),
            "gameroom": ("script", "turn_on", "script.stofzuig_gameroom"),
            "gang": ("script", "turn_on", "script.stofzuig_gang"),
            "garage": ("script", "turn_on", "script.stofzuig_garage"),
            "terug naar station": ("script", "turn_on", "script.stofzuig_naar_station"),
        },
    ),
    "oven_voorverwarmen": Setting(
        "script.oven_voorverwarmen",
        "De oven voorverwarmen met hete lucht tot deze temperatuur (°C). Lukt alleen als Remote Start op de oven "
        "aan staat en de deur dicht is. Vraag altijd eerst om bevestiging.",
        minimum=50,
        maximum=250,
        stap=5,
        veld="temperatuur",
    ),
    "kookplaat": Setting("script.kookplaat_uit", "De kookplaat uitzetten (aanzetten kan niet op afstand).", keuzes={"uit": ""}),
    "oven": Setting("script.oven_uit", "De oven uitzetten (aanzetten kan niet via dit gereedschap).", keuzes={"uit": ""}),
}


def _plain(text: str) -> str:
    """Zonder zachte afbreekstreepjes: myUplink schrijft "One-time in\xadcrease"."""
    return text.replace("\xad", "")


class _ControlTool(llm.Tool):
    integration = DOMAIN
    annotations = llm.ToolAnnotations(read_only=False, destructive=False, idempotent=True, open_world=False)

    async def async_call(self, hass: HomeAssistant, tool_input: llm.ToolInput, llm_context: llm.LLMContext) -> llm.ToolResult:
        data = await self._call(hass, tool_input, llm_context)
        return llm.ToolResult(data=data, error="fout" in data)

    async def _call(self, hass: HomeAssistant, tool_input: llm.ToolInput, llm_context: llm.LLMContext) -> JsonObjectType:
        raise NotImplementedError


# Per domein: handeling -> (dienst, wat "waarde" of "optie" wordt). Een
# handeling met "waarde" of "optie" heeft die nodig; de rest neemt ze niet.
ACTIONS: dict[str, dict[str, tuple[str, str | None]]] = {
    "light": {"aan": ("turn_on", None), "uit": ("turn_off", None), "wissel": ("toggle", None)},
    "switch": {"aan": ("turn_on", None), "uit": ("turn_off", None), "wissel": ("toggle", None)},
    "input_boolean": {"aan": ("turn_on", None), "uit": ("turn_off", None), "wissel": ("toggle", None)},
    "fan": {"aan": ("turn_on", None), "uit": ("turn_off", None), "snelheid": ("set_percentage", "waarde"), "modus": ("set_preset_mode", "optie")},
    "humidifier": {"aan": ("turn_on", None), "uit": ("turn_off", None), "vocht": ("set_humidity", "waarde")},
    "scene": {"aan": ("turn_on", None)},
    "script": {"aan": ("turn_on", None), "uit": ("turn_off", None)},
    "button": {"druk": ("press", None)},
    "input_button": {"druk": ("press", None)},
    "cover": {"open": ("open_cover", None), "dicht": ("close_cover", None), "stop": ("stop_cover", None), "positie": ("set_cover_position", "waarde")},
    "valve": {"open": ("open_valve", None), "dicht": ("close_valve", None)},
    "lock": {"op slot": ("lock", None), "van slot": ("unlock", None)},
    "media_player": {
        "aan": ("turn_on", None), "uit": ("turn_off", None), "afspelen": ("media_play", None), "pauze": ("media_pause", None),
        "stop": ("media_stop", None), "volgende": ("media_next_track", None), "vorige": ("media_previous_track", None),
        "volume": ("volume_set", "waarde"), "dempen": ("volume_mute", None), "ontdempen": ("volume_mute", None), "bron": ("select_source", "optie"),
    },
    "climate": {"aan": ("turn_on", None), "uit": ("turn_off", None), "temperatuur": ("set_temperature", "waarde"), "modus": ("set_hvac_mode", "optie")},
    "water_heater": {"aan": ("turn_on", None), "uit": ("turn_off", None), "temperatuur": ("set_temperature", "waarde")},
    "vacuum": {"start": ("start", None), "stop": ("stop", None), "pauze": ("pause", None), "naar station": ("return_to_base", None), "zoek": ("locate", None)},
    "number": {"zet": ("set_value", "waarde")},
    "input_number": {"zet": ("set_value", "waarde")},
    "select": {"kies": ("select_option", "optie")},
    "input_select": {"kies": ("select_option", "optie")},
    "automation": {"aan": ("turn_on", None), "uit": ("turn_off", None), "uitvoeren": ("trigger", None)},
}
ALL_ACTIONS = sorted({a for acts in ACTIONS.values() for a in acts})
MAX_TARGETS = 60


def _targets(hass: HomeAssistant, entity_ids: list[str], room: str, domain: str) -> tuple[list[str], str | None]:
    """De entiteiten om te bedienen: de gegeven ids, of die van een domein in een
    ruimte of verdieping (zonder ruimte in Home Assistant: met de ruimte in de naam)."""
    if entity_ids:
        return entity_ids, None
    if not room or not domain:
        return [], "geef entity_id, of ruimte en domein"
    ents, devs, areas, floors = er.async_get(hass), dr.async_get(hass), ar.async_get(hass), fr.async_get(hass)
    want = room.strip().lower()
    found = []
    for state in hass.states.async_all(domain):
        if not async_should_expose(hass, ASSISTANT, state.entity_id):
            continue
        entry = ents.async_get(state.entity_id)
        area_id = entry.area_id if entry else None
        if area_id is None and entry and entry.device_id and (dev := devs.async_get(entry.device_id)):
            area_id = dev.area_id
        area = areas.async_get_area(area_id) if area_id else None
        floor = floors.async_get_floor(area.floor_id) if area and area.floor_id else None
        if area and (want in area.name.lower() or (floor and want in floor.name.lower())):
            found.append(state.entity_id)
        # zonder ruimte in Home Assistant: dan op naam ("lamp keuken plafond 1")
        elif area is None and want in (state.name or "").lower():
            found.append(state.entity_id)
    return found, None if found else f"geen blootgestelde {domain} in {room}"


class Bedien(_ControlTool):
    name = "bedien"
    description = (
        "Iets in huis bedienen dat aan de assistent is blootgesteld: een entiteit (entity_id, of een lijst), of "
        "alle entiteiten van een domein in een ruimte of verdieping (ruimte + domein). Handelingen per domein: "
        + "; ".join(f"{d}: {', '.join(a)}" for d, a in ACTIONS.items())
        + ". Lampen bij aan: waarde = helderheid 1-100, kleur (rood, oranje, geel, groen, cyaan, turquoise, blauw, "
        "paars, lila, roze, magenta, een Engelse kleurnaam, #rrggbb of r,g,b, of warm wit, wit, koel wit, koud wit, "
        "daglicht), kelvin 2000-6500, overgang in seconden. Volume en snelheid in procent; temperatuur in °C; "
        "optie = een van de keuzes (bron, modus, een keuzelijst). Zoek ids eerst met huis_nu. Alleen op verzoek "
        "van de gebruiker; vraag eerst bevestiging bij sloten, de stofzuiger en het uitzetten van automatiseringen."
    )
    annotations = llm.ToolAnnotations(read_only=False, destructive=False, idempotent=False, open_world=False)
    parameters = vol.Schema(
        {
            vol.Optional("entity_id", description="een id of een lijst ids"): vol.Any(str, [str]),
            vol.Optional("ruimte", description="in plaats van entity_id: een ruimte of verdieping"): str,
            vol.Optional("domein", description="bij ruimte: bijvoorbeeld light"): str,
            vol.Required("actie"): vol.In(ALL_ACTIONS),
            vol.Optional("waarde", description="helderheid, volume, snelheid of positie in procent; temperatuur; een getal"): vol.Coerce(float),
            vol.Optional("optie", description="een keuze uit de lijst van de entiteit"): str,
            vol.Optional("kleur", description="bij een lamp: een kleur of een wit"): str,
            vol.Optional("kelvin", description="bij een lamp: 2000-6500"): vol.All(vol.Coerce(int), vol.Range(min=KELVIN[0], max=KELVIN[1])),
            vol.Optional("overgang", description="bij een lamp: seconden"): vol.All(vol.Coerce(float), vol.Range(min=0, max=300)),
        }
    )

    async def _call(self, hass: HomeAssistant, tool_input: llm.ToolInput, llm_context: llm.LLMContext) -> JsonObjectType:
        args = tool_input.tool_args
        raw_ids = args.get("entity_id") or []
        ids, problem = _targets(hass, [raw_ids] if isinstance(raw_ids, str) else list(raw_ids), args.get("ruimte") or "", (args.get("domein") or "").strip().lower())
        if problem:
            return {"fout": problem}
        if len(ids) > MAX_TARGETS:
            return {"fout": f"te veel entiteiten tegelijk ({len(ids)}), hooguit {MAX_TARGETS}"}
        done, failed = [], []
        for entity_id in ids:
            result = await self._one(hass, entity_id, args, llm_context)
            (failed if "fout" in result else done).append(result)
        out: dict[str, Any] = {"gedaan": done}
        if failed:
            out["mislukt"] = failed
        if not done:
            out["fout"] = "niets bediend"
        return out

    async def _one(self, hass: HomeAssistant, entity_id: str, args: dict[str, Any], llm_context: llm.LLMContext) -> dict[str, Any]:
        domain = entity_id.split(".")[0]
        state = hass.states.get(entity_id)
        action: str = args["actie"]
        # automatiseringen zijn huislogica: bedienbaar zonder blootstelling
        if state is None or (domain != "automation" and not async_should_expose(hass, ASSISTANT, entity_id)):
            return {"entity_id": entity_id, "fout": "onbekend of niet blootgesteld (zoek met huis_nu)"}
        if state.state == "unavailable":
            return {"entity_id": entity_id, "fout": f"{state.name} is nu niet bereikbaar"}
        acts = ACTIONS.get(domain, {})
        if action not in acts:
            return {"entity_id": entity_id, "fout": f"{action} kan niet bij {domain}; wel: {', '.join(acts) or 'niets'}"}
        service, needs = acts[action]
        data: dict[str, Any] = {"entity_id": entity_id}
        value = args.get("waarde")
        option = (args.get("optie") or "").strip()
        if needs == "waarde" and value is None:
            return {"entity_id": entity_id, "fout": f"{action} heeft een waarde nodig"}
        if needs == "optie" and not option:
            return {"entity_id": entity_id, "fout": f"{action} heeft een optie nodig", "opties": self._options(state)}

        if domain == "light" and service == "turn_on":
            if value is not None:
                if value <= 0:
                    service = "turn_off"
                else:
                    data["brightness_pct"] = max(1, min(100, round(value)))
            if service == "turn_on" and (args.get("kleur") or args.get("kelvin")):
                colour = _colour(args.get("kleur"), args.get("kelvin"))
                if isinstance(colour, str):
                    return {"entity_id": entity_id, "fout": colour}
                modes = set(state.attributes.get("supported_color_modes") or [])
                if "rgb_color" in colour and not modes & {"hs", "rgb", "rgbw", "rgbww", "xy"}:
                    return {"entity_id": entity_id, "fout": f"{state.name} kan geen kleur, alleen wit of helderheid"}
                if "color_temp_kelvin" in colour and not modes & {"color_temp", "hs", "rgb", "rgbw", "rgbww", "xy"}:
                    return {"entity_id": entity_id, "fout": f"{state.name} kan geen kleurtemperatuur"}
                data.update(colour)
            if args.get("overgang") is not None:
                data["transition"] = args["overgang"]
        elif needs == "waarde":
            limited = self._value(domain, service, state, value)
            if isinstance(limited, str):
                return {"entity_id": entity_id, "fout": limited}
            data.update(limited)
        elif needs == "optie":
            options = self._options(state)
            match = next((o for o in options if _plain(str(o)).lower() == option.lower()), None)
            if match is None:
                return {"entity_id": entity_id, "fout": f"{option} is geen keuze", "opties": options}
            data[{"select_source": "source", "set_preset_mode": "preset_mode", "set_hvac_mode": "hvac_mode"}.get(service, "option")] = match
        elif service == "volume_mute":
            data["is_volume_muted"] = action == "dempen"

        await hass.services.async_call(domain, service, data, blocking=True, context=llm_context.context)
        after = hass.states.get(entity_id)
        return {"entity_id": entity_id, "naam": state.name, "actie": action, "was": state.state, "nu": after.state if after else None}

    @staticmethod
    def _options(state: State) -> list[Any]:
        a = state.attributes
        return list(a.get("options") or a.get("source_list") or a.get("preset_modes") or a.get("hvac_modes") or [])

    @staticmethod
    def _value(domain: str, service: str, state: State, value: float) -> dict[str, Any] | str:
        """De waarde voor de dienst, binnen de grenzen van de entiteit."""
        a = state.attributes
        if service in ("volume_set",):
            return {"volume_level": max(0, min(100, value)) / 100}
        if service in ("set_percentage", "set_cover_position"):
            key = "percentage" if service == "set_percentage" else "position"
            return {key: max(0, min(100, round(value)))}
        if service == "set_humidity":
            return {"humidity": round(value)}
        if service == "set_temperature":
            low, high = a.get("min_temp"), a.get("max_temp")
            if low is not None and high is not None and not low <= value <= high:
                return f"{value:g} valt buiten {low:g}-{high:g}"
            return {"temperature": value}
        if service == "set_value":
            low, high = a.get("min"), a.get("max")
            if low is not None and high is not None and not low <= value <= high:
                return f"{value:g} valt buiten {low:g}-{high:g}"
            return {"value": value}
        return {}


def _colour(text: str | None, kelvin: int | None) -> dict[str, Any] | str:
    """De kleur voor light.turn_on, of wat er mis is."""
    if kelvin:
        return {"color_temp_kelvin": kelvin}
    word = (text or "").strip().lower()
    if word in WHITES:
        return {"color_temp_kelvin": WHITES[word]}
    if word in COLOURS:
        return {"rgb_color": list(COLOURS[word])}
    hexa = word.lstrip("#")
    if len(hexa) == 6 and all(c in "0123456789abcdef" for c in hexa):
        return {"rgb_color": [int(hexa[i : i + 2], 16) for i in (0, 2, 4)]}
    parts = [p.strip() for p in word.replace(";", ",").split(",")]
    if len(parts) == 3 and all(p.isdigit() and int(p) <= 255 for p in parts):
        return {"rgb_color": [int(p) for p in parts]}
    try:
        return {"rgb_color": list(color_util.color_name_to_rgb(word.replace(" ", "")))}
    except ValueError:
        return f"onbekende kleur {text}: gebruik een kleurnaam, #rrggbb, r,g,b of een wit"


def _phones(hass: HomeAssistant) -> dict[str, str]:
    """De telefoons met de Home Assistant-app: naam -> notify-dienst."""
    devs = dr.async_get(hass)
    names = {}
    for service in hass.services.async_services().get("notify", {}):
        if not service.startswith("mobile_app_"):
            continue
        slug = service.removeprefix("mobile_app_")
        dev = next((d for d in devs.devices if d.name and slugify(d.name) == slug), None)
        names[(dev.name_by_user or dev.name) if dev else slug] = service
    return names


class Melding(_ControlTool):
    name = "melding"
    description = (
        "Een bericht sturen naar een telefoon met de Home Assistant-app (een melding op het scherm), of naar "
        "allemaal. Zonder tekst: de lijst telefoons. Alleen op verzoek van de gebruiker."
    )
    annotations = llm.ToolAnnotations(read_only=False, destructive=False, idempotent=False, open_world=True)
    parameters = vol.Schema(
        {
            vol.Optional("aan", description="de naam van een telefoon, of alle"): str,
            vol.Optional("titel"): str,
            vol.Optional("tekst"): str,
        }
    )

    async def _call(self, hass: HomeAssistant, tool_input: llm.ToolInput, llm_context: llm.LLMContext) -> JsonObjectType:
        args = tool_input.tool_args
        phones = _phones(hass)
        text = (args.get("tekst") or "").strip()
        if not text:
            return {"telefoons": list(phones)}
        to = (args.get("aan") or "").strip().lower()
        chosen = list(phones.values()) if to in ("", "alle", "allemaal", "iedereen") else [s for n, s in phones.items() if to in n.lower()]
        if not chosen:
            return {"fout": f"geen telefoon {args.get('aan')}", "telefoons": list(phones)}
        data = {"message": text[:1000], **({"title": args["titel"][:120]} if args.get("titel") else {})}
        for service in chosen:
            await hass.services.async_call("notify", service, data, blocking=True, context=llm_context.context)
        return {"gedaan": f"verstuurd naar {', '.join(n for n, s in phones.items() if s in chosen)}"}


class Omroep(_ControlTool):
    name = "omroep"
    description = (
        "Een zin hardop laten uitspreken op een speaker in huis (een blootgestelde mediaspeler, zoek met huis_nu "
        "domein media_player). Alleen op verzoek van de gebruiker."
    )
    annotations = llm.ToolAnnotations(read_only=False, destructive=False, idempotent=False, open_world=False)
    parameters = vol.Schema({vol.Required("entity_id"): str, vol.Required("tekst"): str})

    async def _call(self, hass: HomeAssistant, tool_input: llm.ToolInput, llm_context: llm.LLMContext) -> JsonObjectType:
        args = tool_input.tool_args
        player = args["entity_id"]
        state = hass.states.get(player)
        if state is None or player.split(".")[0] != "media_player" or not async_should_expose(hass, ASSISTANT, player):
            return {"fout": f"{player} is geen blootgestelde speaker"}
        if state.state == "unavailable":
            return {"fout": f"{state.name} is nu niet bereikbaar"}
        engines = [s.entity_id for s in hass.states.async_all("tts")]
        if not engines:
            return {"fout": "er is geen spraakdienst in Home Assistant"}
        await hass.services.async_call(
            "tts", "speak",
            {"entity_id": engines[0], "media_player_entity_id": player, "message": args["tekst"][:500], "language": "nl-NL"},
            blocking=True, context=llm_context.context,
        )
        return {"gedaan": f"uitgesproken op {state.name}"}


class Instelling(_ControlTool):
    name = "instelling"
    description = (
        "Een instelling van het huis lezen of veranderen. Zonder waarde: de huidige stand en wat mag. "
        "Instellingen: "
        + "; ".join(
            f"{name} ({f'{s.minimum:g}-{s.maximum:g}' if s.minimum is not None else ', '.join(s.keuzes)})"
            for name, s in SETTINGS.items()
        )
        + ". Verander alleen wat de gebruiker vraagt."
    )
    parameters = vol.Schema(
        {
            vol.Required("naam"): vol.In(list(SETTINGS)),
            vol.Optional("waarde", description="een getal of een van de keuzes"): vol.Any(str, int, float),
        }
    )

    async def _call(self, hass: HomeAssistant, tool_input: llm.ToolInput, llm_context: llm.LLMContext) -> JsonObjectType:
        args = tool_input.tool_args
        name: str = args["naam"]
        setting = SETTINGS[name]
        state = hass.states.get(setting.entity_id)
        if state is None or state.state == "unavailable":
            return {"fout": f"{name} is nu niet bereikbaar"}
        domain = setting.entity_id.split(".")[0]
        now = self._now(setting, domain, state.state)
        allowed = f"{setting.minimum:g} tot {setting.maximum:g}" if setting.minimum is not None else list(setting.keuzes)
        if "waarde" not in args or args["waarde"] in ("", None):
            return {"instelling": name, "uitleg": setting.uitleg, "nu": now, "mag": allowed}
        raw = args["waarde"]

        if setting.minimum is not None:
            try:
                number = float(str(raw).replace(",", ".").replace("°C", "").strip())
            except ValueError:
                return {"fout": f"{raw} is geen getal", "mag": allowed}
            if not setting.minimum <= number <= setting.maximum:
                return {"fout": f"{number:g} valt buiten {allowed}", "mag": allowed}
            number = round(number / setting.stap) * setting.stap
            if setting.veld:
                await hass.services.async_call(
                    "script", "turn_on", {"entity_id": setting.entity_id, "variables": {setting.veld: number}}, blocking=True, context=llm_context.context
                )
                return {"gedaan": f"{name}: {number:g}"}
            await hass.services.async_call(domain, "set_value", {"entity_id": setting.entity_id, "value": number}, blocking=True, context=llm_context.context)
            return {"gedaan": f"{name} van {now} naar {number:g}", "let_op": "het apparaat neemt het binnen een paar minuten over"}

        choice = str(raw).strip().lower()
        if choice not in setting.keuzes:
            return {"fout": f"{raw} kan niet", "mag": allowed}
        if choice in setting.acties:
            act_domain, service, target = setting.acties[choice]
            await hass.services.async_call(act_domain, service, {"entity_id": target}, blocking=True, context=llm_context.context)
            return {"gedaan": f"{name}: {choice} (was {now})"}
        if domain == "script":
            await hass.services.async_call("script", "turn_on", {"entity_id": setting.entity_id}, blocking=True, context=llm_context.context)
            return {"gedaan": f"{name}: {choice}"}
        option = next((o for o in state.attributes.get("options", []) if _plain(o) == setting.keuzes[choice]), None)
        if option is None:
            return {"fout": f"{name} kent {choice} niet (meer)"}
        await hass.services.async_call("select", "select_option", {"entity_id": setting.entity_id, "option": option}, blocking=True, context=llm_context.context)
        return {"gedaan": f"{name} van {now} naar {choice}"}

    @staticmethod
    def _now(setting: Setting, domain: str, value: str) -> str:
        if domain == "cover":
            return {"open": "open", "closed": "dicht", "opening": "gaat open", "closing": "gaat dicht"}.get(value, value)
        if domain == "vacuum":
            return {"docked": "in het station", "cleaning": "aan het zuigen", "returning": "op weg naar het station", "idle": "stil", "paused": "gepauzeerd", "error": "storing"}.get(value, value)
        if domain == "script" or value in UNAVAILABLE:
            return value if domain != "script" else "-"
        if setting.keuzes:
            return next((nl for nl, opt in setting.keuzes.items() if opt == _plain(value)), value)
        return value
