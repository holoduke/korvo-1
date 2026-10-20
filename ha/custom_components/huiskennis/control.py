"""Bedienen via Huiskennis: alleen wat hier staat, binnen vaste grenzen.

- schakel: lampen (aan, uit, helderheid), scènes en muziek (afspelen, pauze,
  stop, volume), alleen entiteiten die aan Assist zijn blootgesteld;
- instelling: een vaste lijst instellingen van dit huis (SETTINGS) met hun
  toegestane waarden, de garagedeur inbegrepen; zonder waarde leest hij de
  huidige stand.

Bewust niet: sloten, de auto, de oven of kookplaat aanzetten, de stofzuiger en
alles wat de installateur instelt. Elke handeling draagt de
context van wie hem vroeg, dus het logboek toont haar of zijn naam."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import voluptuous as vol

from homeassistant.components.homeassistant.exposed_entities import async_should_expose
from homeassistant.core import HomeAssistant
from homeassistant.helpers import llm
from homeassistant.util.json import JsonObjectType

from .const import DOMAIN

ASSISTANT = "conversation"
SWITCHABLE = ("light", "scene", "media_player")
UNAVAILABLE = ("unavailable", "unknown")


@dataclass(frozen=True, slots=True)
class Setting:
    """Een instelling: een number binnen grenzen, een select met vertaalde
    keuzes, een script dat alleen iets uitzet, of een cover met een dienst
    per keuze (acties)."""

    entity_id: str
    uitleg: str
    minimum: float | None = None
    maximum: float | None = None
    stap: float = 0.5
    keuzes: dict[str, str] = field(default_factory=dict)  # Nederlands -> optie van de entiteit
    acties: dict[str, tuple[str, str, str]] = field(default_factory=dict)  # keuze -> (domein, dienst, entiteit)


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


class Schakel(_ControlTool):
    name = "schakel"
    description = (
        "Een lamp aan of uit zetten (met helderheid 1-100), een scène aanzetten, of muziek bedienen "
        "(afspelen, pauze, stop, volume 0-100). Zoek de entity_id eerst met huis_nu. Alleen op verzoek "
        "van de gebruiker."
    )
    parameters = vol.Schema(
        {
            vol.Required("entity_id"): str,
            vol.Required("actie", description="aan, uit, afspelen, pauze, stop of volume"): vol.In(
                ["aan", "uit", "afspelen", "pauze", "stop", "volume"]
            ),
            vol.Optional("waarde", description="helderheid of volume in procent"): vol.All(vol.Coerce(int), vol.Range(min=0, max=100)),
        }
    )

    async def _call(self, hass: HomeAssistant, tool_input: llm.ToolInput, llm_context: llm.LLMContext) -> JsonObjectType:
        args = tool_input.tool_args
        entity_id: str = args["entity_id"]
        action: str = args["actie"]
        value: int | None = args.get("waarde")
        domain = entity_id.split(".")[0]
        state = hass.states.get(entity_id)
        if domain not in SWITCHABLE or state is None or not async_should_expose(hass, ASSISTANT, entity_id):
            return {"fout": f"{entity_id} kan niet: alleen blootgestelde lampen, scènes en mediaspelers (zoek met huis_nu)"}
        if state.state == "unavailable":
            return {"fout": f"{state.name} is nu niet bereikbaar"}
        service, data = self._service(domain, action, value)
        if service is None:
            return {"fout": f"{action} kan niet bij een {domain}"}
        await hass.services.async_call(domain, service, {"entity_id": entity_id, **data}, blocking=True, context=llm_context.context)
        return {"gedaan": f"{state.name}: {action}" + (f" {value}%" if value is not None else ""), "entity_id": entity_id}

    @staticmethod
    def _service(domain: str, action: str, value: int | None) -> tuple[str | None, dict[str, Any]]:
        if domain == "light":
            if action == "uit" or (action == "aan" and value == 0):
                return "turn_off", {}
            if action == "aan":
                return "turn_on", ({"brightness_pct": value} if value is not None else {})
        elif domain == "scene" and action == "aan":
            return "turn_on", {}
        elif domain == "media_player":
            if action == "volume" and value is not None:
                return "volume_set", {"volume_level": value / 100}
            if action in ("afspelen", "pauze", "stop"):
                return {"afspelen": "media_play", "pauze": "media_pause", "stop": "media_stop"}[action], {}
        return None, {}


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
            await hass.services.async_call(domain, "set_value", {"entity_id": setting.entity_id, "value": number}, blocking=True, context=llm_context.context)
            return {"gedaan": f"{name} van {now} naar {number:g}", "let_op": "de warmtepomp neemt het binnen een paar minuten over"}

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
        if domain == "script" or value in UNAVAILABLE:
            return value if domain != "script" else "-"
        if setting.keuzes:
            return next((nl for nl, opt in setting.keuzes.items() if opt == _plain(value)), value)
        return value
