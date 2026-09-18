"""De config entry van thuispaneel komt uit configuration.yaml (een import):
de gespreksagent (een conversation-platform) bestaat alleen als er een entry is."""
from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN


class ThuispaneelConfigFlow(ConfigFlow, domain=DOMAIN):
    """Eén entry, aangemaakt (en bijgewerkt) vanuit de YAML-configuratie."""

    VERSION = 1

    async def async_step_import(self, import_data: dict[str, Any]) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured(updates=import_data)
        return self.async_create_entry(title="Thuis", data=import_data)

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return self.async_abort(reason="yaml")
