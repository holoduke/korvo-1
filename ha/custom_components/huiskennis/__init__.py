"""Huiskennis: het huis uitlezen voor een taalmodel van buiten, zonder te bedienen.

Registreert een LLM-API ("Huiskennis") met alleen leesgereedschap: wat er nu
is, de ruimtes, de geschiedenis en de statistiek van de entiteiten die aan
Assist zijn blootgesteld. De Model Context Protocol Server van Home Assistant
(mcp_server) geeft hem door aan ChatGPT of Claude; wie hem gebruikt, logt in
met een eigen Home Assistant-account (OAuth). Zie api.py."""
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
