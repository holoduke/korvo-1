"""De config entry van thuispaneel komt uit configuration.yaml (een import):
de gespreksagent (een conversation-platform) bestaat alleen als er een entry is.

Zijn opties (Configureren) houden de toegang tot de UniFi-controller voor de
Internet-tab: die vult de gebruiker zelf in, het wachtwoord komt zo nooit in
een bestand of in de repository."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers.selector import TextSelector, TextSelectorConfig, TextSelectorType

from .const import (
    CONF_UNIFI_HOST,
    CONF_UNIFI_PASSWORD,
    CONF_UNIFI_PORT,
    CONF_UNIFI_SITE,
    CONF_UNIFI_USERNAME,
    DEFAULT_UNIFI_PORT,
    DEFAULT_UNIFI_SITE,
    DOMAIN,
)


class ThuispaneelConfigFlow(ConfigFlow, domain=DOMAIN):
    """Eén entry, aangemaakt (en bijgewerkt) vanuit de YAML-configuratie."""

    VERSION = 1

    async def async_step_import(self, import_data: dict[str, Any]) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured(updates=import_data)
        return self.async_create_entry(title="Thuis", data=import_data)

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return self.async_abort(reason="yaml")

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return ThuispaneelOptionsFlow()


class ThuispaneelOptionsFlow(OptionsFlow):
    """De UniFi-controller voor de Internet-tab. Een leeg wachtwoord laat het
    bewaarde staan, zodat de rest te wijzigen is zonder het opnieuw te typen."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        opts = self.config_entry.options
        if user_input is not None:
            if not user_input.get(CONF_UNIFI_PASSWORD):
                user_input[CONF_UNIFI_PASSWORD] = opts.get(CONF_UNIFI_PASSWORD, "")
            return self.async_create_entry(data=user_input)
        schema = vol.Schema(
            {
                vol.Optional(CONF_UNIFI_HOST, default=opts.get(CONF_UNIFI_HOST, "")): str,
                vol.Optional(CONF_UNIFI_PORT, default=opts.get(CONF_UNIFI_PORT, DEFAULT_UNIFI_PORT)): int,
                vol.Optional(CONF_UNIFI_SITE, default=opts.get(CONF_UNIFI_SITE, DEFAULT_UNIFI_SITE)): str,
                vol.Optional(CONF_UNIFI_USERNAME, default=opts.get(CONF_UNIFI_USERNAME, "")): str,
                vol.Optional(CONF_UNIFI_PASSWORD): TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD)),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
