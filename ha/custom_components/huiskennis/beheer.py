"""Alles van Home Assistant via Huiskennis: elke entiteit, elke dienst, sjablonen,
de configuratie en het systeem.

- alles: elke entiteit met al haar eigenschappen, ook wat niet blootgesteld is
  (beheerders), of alleen het blootgestelde (anderen).
- diensten: welke diensten (acties) er zijn en hun velden.
- dienst: elke dienst aanroepen, met gegevens en doel (entiteit, apparaat,
  ruimte), en het antwoord van diensten die iets teruggeven (agenda's, weer,
  to-do's). Wie geen beheerder is, mag alleen blootgestelde entiteiten
  bedienen met gewone bediening.
- sjabloon: een Jinja-sjabloon uitrekenen (beheerders).
- configuratie: YAML onder /config lezen en schrijven (beheerders; nooit
  secrets.yaml of opslagmappen). Na het schrijven controleert Home Assistant de
  hele configuratie; meldt die iets nieuws (een fout, of een waarschuwing zoals
  een package dat niet laadt), dan komt het oude bestand terug. Herladen meldt
  nieuwe reparaties (een automatisering die niet klopt).
- systeem: versie, integraties en hun toestand, updates; herladen en
  herstarten (beheerders).

Hardware-adressen (MAC, IEEE) worden uit elk antwoord gehaald.

Alles wat verder gaat dan gewone bediening (sloten, deuren, het systeem,
scripts, knoppen, berichten, de configuratie) gaat in twee stappen: de eerste
aanroep geeft een code en zegt wat er zou gebeuren; het taalmodel vraagt de
gebruiker om ja en roept het gereedschap dan opnieuw aan met dezelfde gegevens
en die code. Een code geldt vijf minuten, voor die ene handeling en die ene
gebruiker."""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
import secrets
import time
from typing import Any

import voluptuous as vol

from homeassistant.components.homeassistant.exposed_entities import async_should_expose
from homeassistant.const import __version__ as HA_VERSION
from homeassistant.core import HomeAssistant, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er, issue_registry as ir, llm
from homeassistant.helpers.check_config import async_check_ha_config_file
from homeassistant.helpers.service import async_get_all_descriptions
from homeassistant.helpers.template import Template
from homeassistant.util.json import JsonObjectType

from .common import ASSISTANT, _local, _Places
from .const import DOMAIN

MAX_ROWS = 300
MAX_ATTR_TEXT = 600  # een eigenschap die langer is, wordt afgekapt
MAX_RESPONSE = 30_000
MAX_FILE = 200_000
CONFIRM_TTL_S = 300

CONFIG_DIR_EXCLUDED = {".storage", "custom_components", "deps", ".cloud", "esphome", "zigbee2mqtt", "tts", "backups", ".git"}
CONFIG_FORBIDDEN = {"secrets.yaml"}
CONFIG_SUFFIXES = (".yaml", ".yml")
# Hardware-adressen (MAC, IEEE) gaan nooit naar buiten, ook niet in een naam of titel.
MAC = re.compile(r"\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5,7}\b|\b0x[0-9a-fA-F]{16}\b")

# Gewone bediening: zonder code, en voor iedereen op wat blootgesteld is.
# None = elke dienst van dat domein. (Geen number/select/input_*: die sturen
# apparaatinstellingen en automatiseringen aan, zoals de richting van de
# garagedeur; geen scene.apply/create: die zetten elk domein, ook deuren.)
PLAIN_SERVICES: dict[str, set[str] | None] = {
    "light": None, "fan": None, "climate": None, "humidifier": None, "todo": None, "water_heater": None,
    "scene": {"turn_on"},
    "media_player": {
        "turn_on", "turn_off", "toggle", "volume_up", "volume_down", "volume_set", "volume_mute",
        "media_play", "media_pause", "media_play_pause", "media_stop", "media_next_track",
        "media_previous_track", "media_seek", "select_source", "shuffle_set", "repeat_set", "join", "unjoin", "play_media",
    },
    "vacuum": {"pause", "stop", "return_to_base", "locate"},
    "weather": {"get_forecasts"},
    "calendar": {"get_events"},
    "switch": {"turn_on", "turn_off", "toggle"},
    "input_boolean": {"turn_on", "turn_off", "toggle"},
}
# Ook bij die domeinen een code: entiteiten waar een verkeerde druk echt iets doet.
SENSITIVE_WORDS = ("garage", "oven", "kookplaat", "hob", "slot", "lock", "alarm", "vlm", "tesla", "pc", "defender", "garage430")


def _plain(domain: str, service: str, entity_ids: list[str]) -> bool:
    allowed = PLAIN_SERVICES.get(domain, False)
    if allowed is False or (allowed is not None and service not in allowed):
        return False
    return not any(w in e.lower() for e in entity_ids for w in SENSITIVE_WORDS)


@dataclass(slots=True)
class _Pending:
    key: str
    user_id: str | None
    until: float


class _Confirm:
    """De codes die op een ja wachten, gedeeld door alle gereedschappen."""

    pending: dict[str, _Pending] = {}

    @classmethod
    def ask(cls, tool: str, args: dict[str, Any], user_id: str | None, what: str) -> JsonObjectType:
        now = time.monotonic()
        for code in [c for c, p in cls.pending.items() if p.until < now]:
            cls.pending.pop(code, None)
        code = secrets.token_hex(3)
        cls.pending[code] = _Pending(cls._key(tool, args), user_id, now + CONFIRM_TTL_S)
        return {
            "bevestiging_nodig": what,
            "code": code,
            "hoe": "vraag de gebruiker of dit mag; zegt die ja, roep dit gereedschap dan opnieuw aan met precies "
            "dezelfde gegevens en bevestiging = deze code (5 minuten geldig)",
        }

    @classmethod
    def ok(cls, tool: str, args: dict[str, Any], user_id: str | None) -> bool:
        code = str(args.get("bevestiging") or "").strip()
        pending = cls.pending.get(code)
        if pending is None or pending.until < time.monotonic() or pending.user_id != user_id or pending.key != cls._key(tool, args):
            return False
        cls.pending.pop(code, None)
        return True

    @staticmethod
    def _key(tool: str, args: dict[str, Any]) -> str:
        return tool + json.dumps({k: v for k, v in args.items() if k != "bevestiging"}, sort_keys=True, default=str)


class _BeheerTool(llm.Tool):
    integration = DOMAIN
    admin_only = False

    async def async_call(self, hass: HomeAssistant, tool_input: llm.ToolInput, llm_context: llm.LLMContext) -> llm.ToolResult:
        user_id = llm_context.context.user_id if llm_context.context else None
        user = await hass.auth.async_get_user(user_id) if user_id else None
        admin = bool(user and user.is_active and user.is_admin)
        if self.admin_only and not admin:
            data: JsonObjectType = {"fout": "alleen voor beheerders van Home Assistant"}
        else:
            try:
                data = await self._call(hass, tool_input.tool_args, llm_context, admin, user_id)
            except (HomeAssistantError, vol.Invalid, ValueError, KeyError, TypeError) as err:
                data = {"fout": str(err) or type(err).__name__}
        text = json.dumps(data, default=str, ensure_ascii=False)
        if MAC.search(text):
            data = json.loads(MAC.sub("[adres]", text))
        return llm.ToolResult(data=data, error="fout" in data)

    async def _call(self, hass: HomeAssistant, args: dict[str, Any], llm_context: llm.LLMContext, admin: bool, user_id: str | None) -> JsonObjectType:
        raise NotImplementedError


def _short(value: Any) -> Any:
    text = value if isinstance(value, str) else json.dumps(value, default=str, ensure_ascii=False)
    if len(text) <= MAX_ATTR_TEXT:
        return value
    return text[:MAX_ATTR_TEXT] + " …"


class Alles(_BeheerTool):
    name = "alles"
    description = (
        "Elke entiteit van Home Assistant met haar toestand en al haar eigenschappen, ook wat niet aan de "
        "assistent is blootgesteld (alleen beheerders; anderen zien het blootgestelde). Filter op domein, "
        "integratie (bijvoorbeeld myuplink, esphome, hue, zha, mqtt), ruimte, toestand of een stukje van de naam "
        "of entity_id. Met entity_id één entiteit volledig, met apparaat en integratie."
    )
    annotations = llm.ToolAnnotations(read_only=True, destructive=False, idempotent=True, open_world=False)
    parameters = vol.Schema(
        {
            vol.Optional("entity_id"): str,
            vol.Optional("domein"): str,
            vol.Optional("integratie"): str,
            vol.Optional("ruimte"): str,
            vol.Optional("toestand"): str,
            vol.Optional("zoek"): str,
            vol.Optional("eigenschappen", description="true: met alle eigenschappen (standaard alleen bij één entiteit)"): bool,
        }
    )

    async def _call(self, hass, args, llm_context, admin, user_id):
        ents = er.async_get(hass)
        places = _Places(hass)
        visible = (lambda e: True) if admin else (lambda e: async_should_expose(hass, ASSISTANT, e))
        if one := (args.get("entity_id") or "").strip():
            state = hass.states.get(one)
            if state is None or not visible(one):
                return {"fout": f"onbekende entiteit {one}"}
            entry = ents.async_get(one)
            area = places.area(one)
            dev = places.devs.async_get(entry.device_id) if entry and entry.device_id else None
            return {
                "entity_id": one,
                "naam": state.name,
                "toestand": state.state,
                "sinds": _local(state.last_changed),
                "bijgewerkt": _local(state.last_updated),
                "eigenschappen": {k: _short(v) for k, v in state.attributes.items()},
                "integratie": entry.platform if entry else None,
                "apparaat": {"naam": dev.name_by_user or dev.name, "merk": dev.manufacturer, "model": dev.model, "firmware": dev.sw_version} if dev else None,
                "ruimte": area.name if area else None,
                "verdieping": places.floor(area),
                "blootgesteld": async_should_expose(hass, ASSISTANT, one),
                "uitgeschakeld": bool(entry and entry.disabled_by),
            }
        domain = (args.get("domein") or "").strip().lower()
        platform = (args.get("integratie") or "").strip().lower()
        room = (args.get("ruimte") or "").strip().lower()
        want = (args.get("toestand") or "").strip().lower()
        want = {"aan": "on", "uit": "off", "dicht": "closed", "onbereikbaar": "unavailable"}.get(want, want)
        text = (args.get("zoek") or "").strip().lower()
        full = bool(args.get("eigenschappen"))
        rows: list[dict[str, Any]] = []
        for state in hass.states.async_all(domain or None):
            if not visible(state.entity_id) or (want and state.state.lower() != want):
                continue
            if text and text not in (state.name or "").lower() and text not in state.entity_id:
                continue
            entry = ents.async_get(state.entity_id)
            if platform and (entry is None or entry.platform.lower() != platform):
                continue
            area = places.area(state.entity_id)
            floor = places.floor(area)
            if room and not any(room in (n or "").lower() for n in (area.name if area else None, floor)):
                continue
            row: dict[str, Any] = {"entity_id": state.entity_id, "naam": state.name, "toestand": state.state}
            if unit := state.attributes.get("unit_of_measurement"):
                row["eenheid"] = unit
            if area:
                row["ruimte"] = area.name
            if full:
                row["eigenschappen"] = {k: _short(v) for k, v in state.attributes.items()}
            rows.append(row)
        rows.sort(key=lambda r: r["entity_id"])
        return {"aantal": len(rows), "entiteiten": rows[:MAX_ROWS], "afgekapt": len(rows) > MAX_ROWS, **({} if admin else {"let_op": "alleen wat blootgesteld is"})}


class Diensten(_BeheerTool):
    name = "diensten"
    description = (
        "Welke diensten (acties) Home Assistant heeft: zonder domein de domeinen met hun diensten; met domein "
        "elke dienst met uitleg en velden (welke verplicht, voorbeelden). Gebruik dit voor dienst."
    )
    annotations = llm.ToolAnnotations(read_only=True, destructive=False, idempotent=True, open_world=False)
    parameters = vol.Schema({vol.Optional("domein"): str, vol.Optional("dienst"): str})

    async def _call(self, hass, args, llm_context, admin, user_id):
        services = hass.services.async_services()
        domain = (args.get("domein") or "").strip().lower()
        if not domain:
            return {"domeinen": {d: sorted(s) for d, s in sorted(services.items())}}
        if domain not in services:
            return {"fout": f"geen domein {domain}", "domeinen": sorted(services)}
        descriptions = (await async_get_all_descriptions(hass)).get(domain, {})
        only = (args.get("dienst") or "").strip().lower()
        out = {}
        for name in sorted(services[domain]):
            if only and name != only:
                continue
            d = descriptions.get(name) or {}
            fields = {}
            for key, f in (d.get("fields") or {}).items():
                if "fields" in f:  # een groep velden (advanced)
                    for k2, f2 in f["fields"].items():
                        fields[k2] = {k: f2.get(k) for k in ("description", "required", "example", "selector") if f2.get(k) is not None}
                    continue
                fields[key] = {k: f.get(k) for k in ("description", "required", "example", "selector") if f.get(k) is not None}
            out[name] = {
                "uitleg": d.get("description") or d.get("name"),
                "velden": fields,
                "doel": bool(d.get("target")),
                "geeft_antwoord": hass.services.supports_response(domain, name) != SupportsResponse.NONE,
            }
        return {"domein": domain, "diensten": out}


class Dienst(_BeheerTool):
    name = "dienst"
    description = (
        "Elke dienst (actie) van Home Assistant aanroepen: domein + dienst, met gegevens en een doel (entity_id, "
        "device_id, area_id). Voor alles wat bedien en instelling niet kunnen, zoals een integratie herladen, een "
        "agenda lezen (calendar.get_events), een to-do-lijst, een apparaatinstelling of een script. Zoek de velden "
        "eerst op met diensten. Gewone bediening (lampen, klimaat, muziek, schakelaars, ...) gebeurt meteen; al "
        "het andere vraagt een bevestigingscode (zie het antwoord). Wie geen beheerder is, mag alleen gewone "
        "bediening op blootgestelde entiteiten."
    )
    annotations = llm.ToolAnnotations(read_only=False, destructive=True, idempotent=False, open_world=False)
    parameters = vol.Schema(
        {
            vol.Required("domein"): str,
            vol.Required("dienst"): str,
            vol.Optional("entity_id", description="een id of een lijst ids"): vol.Any(str, [str]),
            vol.Optional("device_id"): vol.Any(str, [str]),
            vol.Optional("area_id"): vol.Any(str, [str]),
            vol.Optional("gegevens", description="de velden van de dienst, als object"): dict,
            vol.Optional("bevestiging", description="de code uit een eerder antwoord, na een ja van de gebruiker"): str,
        }
    )

    async def _call(self, hass, args, llm_context, admin, user_id):
        domain = args["domein"].strip().lower()
        service = args["dienst"].strip().lower()
        if not hass.services.has_service(domain, service):
            return {"fout": f"dienst {domain}.{service} bestaat niet: kijk met diensten"}
        as_list = lambda v: [v] if isinstance(v, str) else list(v or [])  # noqa: E731
        entity_ids = as_list(args.get("entity_id"))
        target = {k: as_list(args.get(k)) for k in ("entity_id", "device_id", "area_id") if args.get(k)}
        data = dict(args.get("gegevens") or {})
        for k in ("entity_id", "device_id", "area_id"):  # een doel in de gegevens telt ook mee
            if k in data:
                target.setdefault(k, []).extend(as_list(data.pop(k)))
        entity_ids = target.get("entity_id", [])
        for e in entity_ids:
            if hass.states.get(e) is None and e != "all":
                return {"fout": f"onbekende entiteit {e}"}
        plain = _plain(domain, service, entity_ids) and entity_ids and not target.get("device_id") and not target.get("area_id")
        if not admin:
            if not plain or not all(async_should_expose(hass, ASSISTANT, e) for e in entity_ids):
                return {"fout": "dat mag alleen een beheerder; gewone bediening kan met bedien"}
        elif not plain and not _Confirm.ok(self.name, args, user_id):
            doel = ", ".join(sum(target.values(), [])) or "geen doel"
            return _Confirm.ask(self.name, args, user_id, f"{domain}.{service} op {doel} met {json.dumps(data, ensure_ascii=False, default=str)}")
        response = hass.services.supports_response(domain, service)
        result = await hass.services.async_call(
            domain, service, data, blocking=True, context=llm_context.context, target=target or None,
            return_response=response != SupportsResponse.NONE,
        )
        out: dict[str, Any] = {"gedaan": f"{domain}.{service}"}
        if result:
            text = json.dumps(result, default=str, ensure_ascii=False)
            out["antwoord"] = result if len(text) <= MAX_RESPONSE else text[:MAX_RESPONSE] + " …"
        for e in entity_ids[:20]:
            if st := hass.states.get(e):
                out.setdefault("nu", {})[e] = st.state
        return out


class Sjabloon(_BeheerTool):
    name = "sjabloon"
    description = (
        "Een Home Assistant-sjabloon (Jinja) uitrekenen, voor vragen die een berekening over veel entiteiten "
        "vragen, bijvoorbeeld {{ states.light | selectattr('state','eq','on') | list | count }} of "
        "{{ area_entities('Keuken') }}. Alleen lezen; alleen beheerders."
    )
    admin_only = True
    annotations = llm.ToolAnnotations(read_only=True, destructive=False, idempotent=True, open_world=False)
    parameters = vol.Schema({vol.Required("sjabloon"): str})

    async def _call(self, hass, args, llm_context, admin, user_id):
        result = Template(args["sjabloon"], hass).async_render(parse_result=False)
        return {"uitkomst": str(result)[:MAX_RESPONSE]}


def _config_path(hass: HomeAssistant, path: str) -> Path:
    root = Path(hass.config.config_dir).resolve()
    p = (root / path.strip().lstrip("/")).resolve()
    if p != root and root not in p.parents:
        raise ValueError("alleen bestanden onder /config")
    rel = p.relative_to(root)
    if any(part in CONFIG_DIR_EXCLUDED or part.startswith(".") for part in rel.parts):
        raise ValueError("deze map is niet toegankelijk")
    if p.is_dir():
        return p
    if p.name in CONFIG_FORBIDDEN or p.suffix not in CONFIG_SUFFIXES:
        raise ValueError("alleen YAML-bestanden, nooit secrets.yaml")
    return p


def _check_yaml(content: str) -> None:
    """Of het geldige YAML is; Home Assistants eigen labels (!secret, !include, ...) mogen."""
    import yaml  # noqa: PLC0415

    class Loader(yaml.SafeLoader):
        pass

    Loader.add_multi_constructor("!", lambda loader, suffix, node: None)
    try:
        yaml.load(content, Loader=Loader)  # noqa: S506 - SafeLoader met alleen een stille labelvanger
    except yaml.YAMLError as err:
        raise ValueError(f"geen geldige YAML: {err}") from err


async def _problems(hass: HomeAssistant) -> set[str]:
    """Wat de configuratiecontrole nu meldt: fouten én waarschuwingen (een kapot
    package is voor Home Assistant maar een waarschuwing)."""
    res = await async_check_ha_config_file(hass)
    return {f"fout: {e}"[:500] for e in res.errors} | {f"waarschuwing: {w}"[:500] for w in res.warnings}


def _issues(hass: HomeAssistant) -> dict[str, str]:
    """De open meldingen bij Instellingen > Reparaties."""
    return {f"{i.domain}.{i.issue_id}": f"{i.domain}: {i.translation_key} {i.translation_placeholders or ''}"[:300]
            for i in ir.async_get(hass).issues.values() if i.active and not i.dismissed_version}


RELOAD = {
    "automatiseringen": ("automation", "reload"), "scenes": ("scene", "reload"), "scripts": ("script", "reload"),
    "sjablonen": ("template", "reload"), "groepen": ("group", "reload"), "helpers": ("input_boolean", "reload"),
    "alles": ("homeassistant", "reload_all"), "kern": ("homeassistant", "reload_core_config"),
}


class Configuratie(_BeheerTool):
    name = "configuratie"
    description = (
        "De YAML-configuratie van Home Assistant onder /config: lijst (een map, standaard /config en packages), "
        "lees (een bestand) of schrijf (een heel bestand, bijvoorbeeld automations.yaml, scripts.yaml, "
        "scenes.yaml of packages/garage.yaml; nooit secrets.yaml). Schrijven vraagt een bevestigingscode; daarna "
        "controleert Home Assistant de hele configuratie en zet bij een fout het oude bestand terug. Herlaad "
        "daarna met systeem (automatiseringen, scripts, scenes, sjablonen, alles) of herstart. Lees altijd eerst "
        "en schrijf het hele bestand terug, met wat er al in stond. Alleen beheerders."
    )
    admin_only = True
    annotations = llm.ToolAnnotations(read_only=False, destructive=True, idempotent=False, open_world=False)
    parameters = vol.Schema(
        {
            vol.Required("actie"): vol.In(["lijst", "lees", "schrijf"]),
            vol.Optional("pad", description="relatief aan /config, bijvoorbeeld automations.yaml of packages"): str,
            vol.Optional("inhoud", description="bij schrijf: de hele nieuwe inhoud"): str,
            vol.Optional("bevestiging"): str,
        }
    )

    async def _call(self, hass, args, llm_context, admin, user_id):
        action = args["actie"]
        root = Path(hass.config.config_dir).resolve()
        if action == "lijst":
            folder = _config_path(hass, args.get("pad") or "")
            if not folder.is_dir():
                return {"fout": "geen map"}

            def scan() -> list[str]:
                out = []
                for p in sorted(folder.iterdir()):
                    if p.name.startswith(".") or p.name in CONFIG_DIR_EXCLUDED or p.name in CONFIG_FORBIDDEN:
                        continue
                    if p.is_dir():
                        out.append(f"{p.relative_to(root)}/")
                    elif p.suffix in CONFIG_SUFFIXES:
                        out.append(str(p.relative_to(root)))
                return out

            return {"map": str(folder.relative_to(root)) or "/config", "inhoud": await hass.async_add_executor_job(scan)}
        p = _config_path(hass, args.get("pad") or "")
        if p.is_dir():
            return {"fout": "dat is een map: gebruik lijst"}
        rel = str(p.relative_to(root))
        if action == "lees":
            if not p.exists():
                return {"fout": f"{rel} bestaat niet"}
            text = await hass.async_add_executor_job(p.read_text)
            return {"pad": rel, "inhoud": text[:MAX_FILE], "afgekapt": len(text) > MAX_FILE}
        content = args.get("inhoud")
        if content is None:
            return {"fout": "geef de hele nieuwe inhoud"}
        _check_yaml(content)
        if not _Confirm.ok(self.name, args, user_id):
            old = await hass.async_add_executor_job(p.read_text) if p.exists() else ""
            return _Confirm.ask(self.name, args, user_id, f"{rel} schrijven ({len(old)} → {len(content)} tekens)")
        before = await _problems(hass)
        old = await hass.async_add_executor_job(p.read_text) if p.exists() else None
        await hass.async_add_executor_job(lambda: (p.parent.mkdir(parents=True, exist_ok=True), p.write_text(content)))
        if new := sorted((await _problems(hass)) - before):
            if old is None:
                await hass.async_add_executor_job(p.unlink)
            else:
                await hass.async_add_executor_job(p.write_text, old)
            return {"fout": "de configuratie klopte daarna niet; het oude bestand staat terug", "problemen": new[:10]}
        return {
            "gedaan": f"{rel} geschreven",
            "volgende": "herlaad met systeem (of herstart als het een nieuw onderdeel is); het antwoord van herladen "
            "noemt nieuwe problemen, zoals een automatisering die niet klopt",
        }


class Systeem(_BeheerTool):
    name = "systeem"
    description = (
        "Home Assistant zelf: overzicht (versie, integraties met hun toestand, wat niet laadt, updates), "
        "controleer (de configuratie nakijken), herlaad (automatiseringen, scenes, scripts, sjablonen, groepen, "
        "helpers, kern of alles), integratie_herladen (een integratie op naam, bijvoorbeeld myuplink) of "
        "herstart. Herladen en herstarten vragen een bevestigingscode. Alleen beheerders."
    )
    admin_only = True
    annotations = llm.ToolAnnotations(read_only=False, destructive=False, idempotent=False, open_world=False)
    parameters = vol.Schema(
        {
            vol.Required("actie"): vol.In(["overzicht", "controleer", "herlaad", "integratie_herladen", "herstart"]),
            vol.Optional("wat", description="bij herlaad: " + ", ".join(RELOAD) + "; bij integratie_herladen: de naam of het domein"): str,
            vol.Optional("bevestiging"): str,
        }
    )

    async def _call(self, hass, args, llm_context, admin, user_id):
        action = args["actie"]
        if action == "overzicht":
            entries = hass.config_entries.async_entries()
            updates = [
                {"entity_id": s.entity_id, "naam": s.name, "nu": s.attributes.get("installed_version"), "nieuw": s.attributes.get("latest_version")}
                for s in hass.states.async_all("update") if s.state == "on"
            ]
            return {
                "versie": HA_VERSION,
                "integraties": sorted({f"{e.domain}: {e.title} ({e.state.value})" for e in entries}),
                "niet_geladen": [f"{e.domain}: {e.title} ({e.state.value}{', ' + e.reason if e.reason else ''})" for e in entries if e.state.value not in ("loaded", "not_loaded") or (e.state.value == "not_loaded" and not e.disabled_by)],
                "updates": updates,
            }
        if action == "controleer":
            res = await async_check_ha_config_file(hass)
            return {"in_orde": not res.errors, "fouten": [str(e)[:500] for e in res.errors][:10], "waarschuwingen": [str(w)[:300] for w in res.warnings][:10]}
        what = (args.get("wat") or "").strip().lower()
        if action == "integratie_herladen":
            entries = [e for e in hass.config_entries.async_entries() if what and (what == e.domain or what in e.title.lower())]
            if not entries:
                return {"fout": f"geen integratie {what}"}
            if not _Confirm.ok(self.name, args, user_id):
                return _Confirm.ask(self.name, args, user_id, "herladen: " + ", ".join(f"{e.domain} ({e.title})" for e in entries))
            for e in entries:
                await hass.config_entries.async_reload(e.entry_id)
            return {"gedaan": [f"{e.domain} ({e.title}): {e.state.value}" for e in entries]}
        if action == "herlaad":
            if what not in RELOAD:
                return {"fout": "wat? " + ", ".join(RELOAD)}
            if not _Confirm.ok(self.name, args, user_id):
                return _Confirm.ask(self.name, args, user_id, f"{what} herladen")
            res = await async_check_ha_config_file(hass)
            if res.errors:
                return {"fout": "de configuratie heeft fouten; niet herladen", "fouten": [str(e)[:500] for e in res.errors][:10]}
            issues = _issues(hass)
            domain, service = RELOAD[what]
            await hass.services.async_call(domain, service, {}, blocking=True, context=llm_context.context)
            out: dict[str, Any] = {"gedaan": f"{what} herladen"}
            if new := [v for k, v in _issues(hass).items() if k not in issues]:
                out["nieuwe_problemen"] = new[:10]
            if res.warnings:
                out["waarschuwingen"] = [str(w)[:300] for w in res.warnings][:10]
            return out
        # herstart
        res = await async_check_ha_config_file(hass)
        if res.errors:
            return {"fout": "de configuratie heeft fouten; niet herstarten", "fouten": [str(e)[:500] for e in res.errors][:10]}
        if not _Confirm.ok(self.name, args, user_id):
            return _Confirm.ask(self.name, args, user_id, "Home Assistant herstarten (een minuut zonder automatiseringen en zonder deze verbinding)")
        hass.async_create_task(hass.services.async_call("homeassistant", "restart", {}, context=llm_context.context))
        return {"gedaan": "herstart gestart; over een minuut is alles terug"}
