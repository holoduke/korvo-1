"""De gespreksagent "Thuis": vragen over het huis én de bediening ervan, door
een taalmodel (xAI) met gereedschap.

Het model krijgt drie soorten gereedschap:
- de Assist-API van Home Assistant: alles wat aan Assist is blootgesteld
  (lampen, schakelaars, scènes, media, robots, ...) bedienen en uitlezen;
- een algemene service-aanroep (elke domein.service, met data en doel), de
  lijst van services van een domein, en de geschiedenis van een entiteit;
- de configuratie: YAML-bestanden onder /config lezen en schrijven (behalve
  secrets.yaml), onderdelen herladen, Home Assistant herstarten.

Bij het schrijven van bestanden en een herstart vraagt het eerst om
bevestiging (de systeemprompt zegt dat), tenzij de vraag die al inhoudt.

Het paneel praat ermee via conversation/process (agent_id conversation.thuis);
de Home Assistant-app op een telefoon via Assist, als deze agent daar gekozen
is."""
from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import timedelta
import json
import logging
from pathlib import Path
from typing import Any

from homeassistant.components import conversation
from homeassistant.components.recorder import get_instance, history
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent, llm
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util
from homeassistant.util.json import json_loads

from .const import CONF_MODEL, CONF_XAI_KEY, DEFAULT_MODEL, DOMAIN, XAI_URL

_LOGGER = logging.getLogger(__name__)

MAX_ROUNDS = 8  # gereedschap-rondes per vraag
RECENT = timedelta(hours=3)

PROMPT = """Je bent "Thuis", de stem van een woonhuis in Nederland, en je hebt het
huis in handen. Antwoord kort en concreet, in het Nederlands (of in het Engels
als de vraag Engels is), in hooguit twee zinnen, zonder opsommingstekens.
Getallen met een komma, tijden als 14:05.

Bedienen: gebruik het gereedschap; zeg daarna in één zin wat je gedaan hebt.
Weet je een toestand niet zeker, kijk dan eerst (GetLiveContext of de
geschiedenis) in plaats van te gokken. Een service die niet in de Assist-
gereedschappen zit roep je aan met call_service (eerst list_services als je
de naam niet zeker weet).

Configuratie: je mag YAML onder /config lezen en schrijven (automations.yaml,
scenes.yaml, scripts.yaml, packages/...) en onderdelen herladen of Home
Assistant herstarten. Voordat je een bestand schrijft of herstart: vat in één
zin samen wat je gaat doen en vraag om bevestiging — tenzij de vraag zelf al
"ja", "doe het" of "bevestig" bevat, dan doe je het meteen. Na het schrijven
van een automation, scene of script herlaad je dat onderdeel.

Wat er de laatste uren gebeurde:
{recent}"""

CONFIG_DIR = "/config"
WRITABLE_SUFFIXES = (".yaml", ".yml")
FORBIDDEN = ("secrets.yaml",)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([ThuisAgent(entry)])


# ---- Het eigen gereedschap ------------------------------------------------------------------

CUSTOM_TOOLS: list[dict[str, Any]] = [
    {
        "name": "call_service",
        "description": "Roept een Home Assistant-service aan (domein.service), met optionele data en doel-entiteiten. Voor alles wat de Assist-gereedschappen niet kunnen.",
        "parameters": {
            "type": "object",
            "properties": {
                "domain": {"type": "string"},
                "service": {"type": "string"},
                "data": {"type": "object", "description": "service data"},
                "entity_id": {"type": "array", "items": {"type": "string"}, "description": "doel-entiteiten"},
            },
            "required": ["domain", "service"],
        },
    },
    {
        "name": "list_services",
        "description": "De services van een domein, met hun velden.",
        "parameters": {"type": "object", "properties": {"domain": {"type": "string"}}, "required": ["domain"]},
    },
    {
        "name": "entity_history",
        "description": "De toestanden van een entiteit in de laatste uren (tijd en toestand).",
        "parameters": {
            "type": "object",
            "properties": {"entity_id": {"type": "string"}, "hours": {"type": "number", "description": "standaard 24"}},
            "required": ["entity_id"],
        },
    },
    {
        "name": "read_config",
        "description": "Leest een YAML-bestand onder /config (bijvoorbeeld automations.yaml of packages/garage.yaml).",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    },
    {
        "name": "write_config",
        "description": "Schrijft een YAML-bestand onder /config (nooit secrets.yaml). Vraag eerst bevestiging. Herlaad daarna het onderdeel.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]},
    },
    {
        "name": "reload",
        "description": "Herlaadt een onderdeel na een configuratiewijziging: automations, scenes, scripts, templates, of all (alle YAML die herladen kan).",
        "parameters": {"type": "object", "properties": {"what": {"type": "string", "enum": ["automations", "scenes", "scripts", "templates", "all"]}}, "required": ["what"]},
    },
    {
        "name": "restart_home_assistant",
        "description": "Herstart Home Assistant (een minuut zonder automatiseringen). Vraag eerst bevestiging.",
        "parameters": {"type": "object", "properties": {}},
    },
]
CUSTOM_NAMES = {t["name"] for t in CUSTOM_TOOLS}


def _config_path(path: str) -> Path:
    root = Path(CONFIG_DIR).resolve()
    p = (root / path.lstrip("/")).resolve()
    if root != p and root not in p.parents:
        raise ValueError("buiten /config")
    if p.name in FORBIDDEN or p.suffix not in WRITABLE_SUFFIXES:
        raise ValueError("alleen YAML-bestanden, niet secrets.yaml")
    return p


class ThuisAgent(conversation.ConversationEntity):
    """De agent, één per entry."""

    _attr_has_entity_name = True
    _attr_name = "Thuis"
    _attr_should_poll = False
    _attr_supported_features = conversation.ConversationEntityFeature.CONTROL

    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = entry.entry_id

    @property
    def supported_languages(self) -> list[str]:
        return ["nl", "en"]

    async def _async_handle_message(self, user_input: conversation.ConversationInput, chat_log: conversation.ChatLog) -> conversation.ConversationResult:
        response = intent.IntentResponse(language=user_input.language)
        try:
            text = await self._converse(user_input, chat_log)
        except Exception as err:  # noqa: BLE001 - het antwoord is dan de fout
            _LOGGER.warning("Thuis kon niet antwoorden: %s", err, exc_info=True)
            response.async_set_error(intent.IntentResponseErrorCode.UNKNOWN, f"Ik kan het nu niet ({err}).")
            return conversation.ConversationResult(response=response, conversation_id=chat_log.conversation_id)
        response.async_set_speech(text)
        return conversation.ConversationResult(response=response, conversation_id=chat_log.conversation_id, continue_conversation=chat_log.continue_conversation)

    async def _converse(self, user_input: conversation.ConversationInput, chat_log: conversation.ChatLog) -> str:
        key = self._entry.data.get(CONF_XAI_KEY)
        if not key:
            raise RuntimeError("geen sleutel voor het taalmodel")
        recent = await self.hass.async_add_executor_job(recent_events, self.hass)
        await chat_log.async_provide_llm_data(
            user_input.as_llm_context(DOMAIN),
            llm.LLM_API_ASSIST,
            PROMPT.replace("{recent}", recent or "- niets bijzonders"),
            user_input.extra_system_prompt,
        )
        tools: list[dict[str, Any]] = []
        if chat_log.llm_api:
            for tool in chat_log.llm_api.tools:
                schema = llm.to_openapi(tool.parameters, custom_serializer=chat_log.llm_api.custom_serializer)
                tools.append({"type": "function", "function": {"name": tool.name, "description": tool.description or "", "parameters": schema}})
        tools.extend({"type": "function", "function": t} for t in CUSTOM_TOOLS)
        messages = _messages_of(chat_log.content)
        session = async_get_clientsession(self.hass)
        model = self._entry.data.get(CONF_MODEL) or DEFAULT_MODEL
        text = ""
        for _round in range(MAX_ROUNDS):
            async with session.post(
                XAI_URL,
                json={"model": model, "messages": messages, "tools": tools, "tool_choice": "auto", "temperature": 0.2, "max_tokens": 600},
                headers={"Authorization": f"Bearer {key}"},
                timeout=60,
            ) as res:
                if res.status != 200:
                    raise RuntimeError(f"taalmodel antwoordt {res.status}: {(await res.text())[:120]}")
                data = await res.json()
            msg = data["choices"][0]["message"]
            text = (msg.get("content") or "").strip()
            calls = msg.get("tool_calls") or []
            ha_calls = [c for c in calls if c["function"]["name"] not in CUSTOM_NAMES]
            own_calls = [c for c in calls if c["function"]["name"] in CUSTOM_NAMES]

            async def stream() -> AsyncGenerator[Any]:
                yield {"role": "assistant"}
                if text:
                    yield {"content": text}
                inputs = [
                    llm.ToolInput(id=c["id"], tool_name=c["function"]["name"], tool_args=_args(c), external=c["function"]["name"] in CUSTOM_NAMES)
                    for c in calls
                ]
                if inputs:
                    yield {"tool_calls": inputs}

            added = [content async for content in chat_log.async_add_delta_content_stream(self.entity_id, stream())]
            messages.extend(_messages_of(added))
            for c in own_calls:  # het eigen gereedschap voert de agent zelf uit
                result = await self._run_tool(c["function"]["name"], _args(c))
                content = conversation.ToolResultContent(agent_id=self.entity_id, tool_call_id=c["id"], tool_name=c["function"]["name"], tool_result=result)
                chat_log.async_add_assistant_content_without_tools(content)
                messages.extend(_messages_of([content]))
            if not calls:
                break
        return text or "Gedaan."

    async def _run_tool(self, name: str, args: dict[str, Any]) -> Any:
        hass = self.hass
        try:
            if name == "call_service":
                target = {"entity_id": args["entity_id"]} if args.get("entity_id") else None
                await hass.services.async_call(args["domain"], args["service"], args.get("data") or {}, blocking=True, target=target)
                return {"ok": True}
            if name == "list_services":
                services = hass.services.async_services_for_domain(args["domain"])
                return {s: list((v.schema.schema.keys() if v.schema and hasattr(v.schema, "schema") else [])) for s, v in services.items()} if services else {"error": "onbekend domein"}
            if name == "entity_history":
                hours = float(args.get("hours") or 24)
                start = dt_util.utcnow() - timedelta(hours=hours)
                states = await get_instance(hass).async_add_executor_job(
                    history.state_changes_during_period, hass, start, None, args["entity_id"], True, False, 200
                )
                rows = states.get(args["entity_id"], [])
                return [{"t": s.last_changed.astimezone(dt_util.DEFAULT_TIME_ZONE).strftime("%d-%m %H:%M"), "state": s.state} for s in rows][-80:]
            if name == "read_config":
                p = _config_path(args["path"])
                return {"path": str(p.relative_to(CONFIG_DIR)), "content": await hass.async_add_executor_job(p.read_text)} if p.exists() else {"error": "bestaat niet"}
            if name == "write_config":
                p = _config_path(args["path"])
                content = args["content"]
                import yaml  # noqa: PLC0415 - alleen hier nodig

                yaml.safe_load(content)  # geen kapotte YAML in /config
                await hass.async_add_executor_job(p.parent.mkdir, True, True)
                await hass.async_add_executor_job(p.write_text, content)
                return {"ok": True, "path": str(p.relative_to(CONFIG_DIR)), "bytes": len(content)}
            if name == "reload":
                what = args["what"]
                calls = {
                    "automations": ("automation", "reload"),
                    "scenes": ("scene", "reload"),
                    "scripts": ("script", "reload"),
                    "templates": ("template", "reload"),
                    "all": ("homeassistant", "reload_all"),
                }
                domain, service = calls.get(what, calls["all"])
                await hass.services.async_call(domain, service, {}, blocking=True)
                return {"ok": True}
            if name == "restart_home_assistant":
                hass.async_create_task(hass.services.async_call("homeassistant", "restart", {}))
                return {"ok": True, "note": "herstart gestart"}
        except Exception as err:  # noqa: BLE001 - het model krijgt de fout te zien
            return {"error": str(err)}
        return {"error": f"onbekend gereedschap {name}"}


def _args(call: dict[str, Any]) -> dict[str, Any]:
    raw = call["function"].get("arguments") or "{}"
    try:
        parsed = json_loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        parsed = {}
    return parsed if isinstance(parsed, dict) else {}


def _messages_of(content_list: Any) -> list[dict[str, Any]]:
    """De inhoud van het gesprekslog als OpenAI-berichten."""
    out: list[dict[str, Any]] = []
    for c in content_list:
        if isinstance(c, conversation.ToolResultContent):
            out.append({"role": "tool", "tool_call_id": c.tool_call_id, "content": json.dumps(c.tool_result, ensure_ascii=False, default=str)})
            continue
        if isinstance(c, conversation.AssistantContent):
            msg: dict[str, Any] = {"role": "assistant", "content": c.content or ""}
            if c.tool_calls:
                msg["tool_calls"] = [
                    {"id": t.id, "type": "function", "function": {"name": t.tool_name, "arguments": json.dumps(t.tool_args, ensure_ascii=False)}} for t in c.tool_calls
                ]
            out.append(msg)
            continue
        role = getattr(c, "role", "user")
        if getattr(c, "content", None):
            out.append({"role": role, "content": c.content})
    return out


def recent_events(hass: HomeAssistant) -> str:
    """Deuren, ramen en robots die de laatste uren veranderden, één regel elk."""
    now = dt_util.now()
    rows: list[tuple[Any, str]] = []
    for state in hass.states.async_all():
        if now - state.last_changed > RECENT:
            continue
        dc = state.attributes.get("device_class")
        if state.domain == "binary_sensor" and dc in ("door", "window", "garage_door", "opening") and state.state in ("on", "off"):
            rows.append((state.last_changed, f"{state.name} {'open' if state.state == 'on' else 'dicht'}"))
        elif state.domain == "vacuum":
            rows.append((state.last_changed, f"{state.name}: {state.state}"))
    rows.sort(key=lambda r: r[0], reverse=True)
    return "\n".join(f"- {t.astimezone(dt_util.DEFAULT_TIME_ZONE).strftime('%H:%M')} {text}" for t, text in rows[:25])
