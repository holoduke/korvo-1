"""Thuispaneel: serveert de wandpaneel-webapp met de juiste cache-instellingen.

Home Assistant geeft alles onder /local een cache van 31 dagen mee, ook
index.html. Een app op het beginscherm van een iPad blijft dan wekenlang een
oude versie tonen, hoe vaak er ook een nieuwe wordt neergezet. Deze integratie
serveert dezelfde bestanden (uit /config/www/panel, waar tools/web_deploy.sh ze
neerzet) onder /thuis/:

- zonder versie in het adres (index.html, version.txt, manifest.json, de
  icoontjes): "no-cache", dus de browser vraagt elke keer na of er iets nieuws
  is en krijgt een goedkope 304 als dat niet zo is;
- met een versie in het adres (?v=..., de scripts en stijlen): een jaar, want
  een nieuwe versie heeft een nieuw adres.

Daarnaast de gespreksagent "Thuis" (conversation.py): vragen over het huis,
beantwoord door een taalmodel van xAI met een momentopname van het huis erbij.

Configuratie in configuration.yaml:

  thuispaneel:
    xai_key: !secret xai_key      # zonder sleutel: alleen de webapp
    model: grok-4.20-0309-non-reasoning   # optioneel

De agent hangt aan een config entry die uit deze YAML wordt aangemaakt (en
bijgewerkt), want een conversation-platform bestaat alleen bij een entry.
"""
from __future__ import annotations

from pathlib import Path

from aiohttp import web
import voluptuous as vol

from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import CONF_MODEL, CONF_XAI_KEY, DEFAULT_MODEL, DOMAIN

URL = "/thuis"

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {
                vol.Optional(CONF_XAI_KEY): cv.string,
                vol.Optional(CONF_MODEL, default=DEFAULT_MODEL): cv.string,
            }
        )
    },
    extra=vol.ALLOW_EXTRA,
)

NO_CACHE = "no-cache"
VERSIONED = "public, max-age=31536000, immutable"
PLATFORMS = ["conversation"]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    hass.http.register_view(PanelView(hass, Path(hass.config.path("www", "panel"))))
    conf = config.get(DOMAIN) or {}
    if conf.get(CONF_XAI_KEY):
        hass.async_create_task(
            hass.config_entries.flow.async_init(
                DOMAIN, context={"source": SOURCE_IMPORT}, data={CONF_XAI_KEY: conf[CONF_XAI_KEY], CONF_MODEL: conf.get(CONF_MODEL, DEFAULT_MODEL)}
            )
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_reload))
    return True


async def _reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


class PanelView(HomeAssistantView):
    """De webapp zelf; inloggen gebeurt in de app via de gewone HA-login."""

    url = URL + "/{path:.*}"
    extra_urls = [URL]
    name = "thuispaneel"
    requires_auth = False

    def __init__(self, hass: HomeAssistant, root: Path) -> None:
        self._hass = hass
        self._root = root

    def _bestand(self, path: str) -> Path | None:
        """Draait in een aparte draad: bestandssysteem, niet op de event loop."""
        root = self._root.resolve()
        bestand = (root / (path or "index.html")).resolve()
        if root != bestand and root not in bestand.parents:
            return None  # buiten de map van de app (bijvoorbeeld via "..")
        if bestand.is_dir():
            bestand = bestand / "index.html"
        return bestand if bestand.is_file() else None

    async def get(self, request: web.Request, path: str = "") -> web.StreamResponse:
        if request.path == URL:
            raise web.HTTPFound(URL + "/")  # relatieve adressen in de pagina hebben de slash nodig
        bestand = await self._hass.async_add_executor_job(self._bestand, path)
        if bestand is None:
            raise web.HTTPNotFound()
        cache = VERSIONED if "v" in request.query else NO_CACHE
        return web.FileResponse(bestand, headers={"Cache-Control": cache})
