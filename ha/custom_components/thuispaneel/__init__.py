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

Configuratie: een lege regel "thuispaneel:" in configuration.yaml.
"""
from __future__ import annotations

from pathlib import Path

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

DOMAIN = "thuispaneel"
URL = "/thuis"

CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)

NO_CACHE = "no-cache"
VERSIONED = "public, max-age=31536000, immutable"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    hass.http.register_view(PanelView(hass, Path(hass.config.path("www", "panel"))))
    return True


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
