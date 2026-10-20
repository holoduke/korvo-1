"""Huiskennis: het huis voor een taalmodel van buiten, om uit te lezen en te
bedienen.

Registreert een LLM-API ("Huiskennis"): lezen wat aan Assist is blootgesteld
(nu, geschiedenis, statistiek, logboek, aanwezigheid, weer, problemen,
automatiseringen) en het huisboek (tekstbestanden in /config/huisboek);
bedienen wat blootgesteld is, plus een vaste lijst instellingen, berichten
naar telefoons en omroepen op een speaker (control.py). De Model Context
Protocol Server van Home Assistant (mcp_server) geeft hem door aan ChatGPT of
Claude; wie hem gebruikt, logt in met een eigen Home Assistant-account
(OAuth). Zie api.py."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import llm

from .api import HuiskennisAPI


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    entry.async_on_unload(llm.async_register_api(hass, HuiskennisAPI(hass)))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return True
