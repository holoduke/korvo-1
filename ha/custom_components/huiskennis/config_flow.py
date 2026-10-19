"""Huiskennis heeft niets in te stellen: één item, zonder vragen."""
from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import API_NAME, DOMAIN


class HuiskennisConfigFlow(ConfigFlow, domain=DOMAIN):
    """Voegt Huiskennis toe."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is None:
            return self.async_show_form(step_id="user")
        return self.async_create_entry(title=API_NAME, data={})
