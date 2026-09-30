"""Het thuisnetwerk voor de Internet-tab van het paneel.

Leest de UniFi Network Application (de controller naast Home Assistant) met
een eigen, bij voorkeur alleen-lezen account: de apparaten (switches,
access points) met hun uplinks, de verbonden apparaten met hun signaal en
kwaliteit, en de radio's (kanaal, belasting). Meet daarnaast zelf elke
minuut de vertraging naar internet (een TCP-verbinding naar twee publieke
DNS-servers) en houdt daar een dag van bij.

Het paneel vraagt het overzicht op met het websocket-commando
"thuispaneel/network" (alleen beheerders). MAC-adressen verlaten Home
Assistant niet: elk apparaat krijgt een anonieme sleutel (een hash met een
zout per installatie), genoeg om een client aan zijn access point te knopen.

De inloggegevens staan in de opties van de thuispaneel-entry (Instellingen
> Apparaten en diensten > Thuispaneel > Configureren); zonder die opties
meldt het commando alleen dat er niets is ingesteld.
"""
from __future__ import annotations

import asyncio
from collections import deque
import hashlib
import logging
import math
import time
from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_create_clientsession

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

_LOGGER = logging.getLogger(__name__)

POLL_S = 60
LATENCY_TARGETS = (("1.1.1.1", 443), ("9.9.9.9", 443))
LATENCY_TIMEOUT_S = 3
LATENCY_KEPT = 24 * 60  # een dag aan minuten
RADIO_BAND = {"ng": "2,4 GHz", "na": "5 GHz", "6e": "6 GHz"}

DATA = f"{DOMAIN}_network"


class Network:
    """De controller, uitgelezen en omgezet naar een overzicht zonder MAC-adressen."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self._hass = hass
        opts = entry.options
        self._host = opts.get(CONF_UNIFI_HOST)
        self._port = opts.get(CONF_UNIFI_PORT, DEFAULT_UNIFI_PORT)
        self._site = opts.get(CONF_UNIFI_SITE) or DEFAULT_UNIFI_SITE
        self._user = opts.get(CONF_UNIFI_USERNAME)
        self._password = opts.get(CONF_UNIFI_PASSWORD)
        self._salt = entry.entry_id.encode()
        # een eigen sessie: het koekje van de controller hoort bij een IP-adres
        self._session = async_create_clientsession(
            hass, verify_ssl=False, cookie_jar=aiohttp.CookieJar(unsafe=True)
        )
        self._logged_in = False
        self._snapshot: dict[str, Any] = {"configured": self.configured, "at": None}
        self._latency: deque[tuple[float, float | None]] = deque(maxlen=LATENCY_KEPT)
        self._task: asyncio.Task | None = None

    @property
    def configured(self) -> bool:
        return bool(self._host and self._user and self._password)

    def start(self) -> None:
        self._task = self._hass.async_create_background_task(self._loop(), f"{DOMAIN} network")

    async def stop(self) -> None:
        # de sessie ruimt Home Assistant zelf op bij het ontladen van de entry
        if self._task:
            self._task.cancel()

    async def _loop(self) -> None:
        while True:
            try:
                await self._poll()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - het paneel krijgt de fout te zien, de lus loopt door
                _LOGGER.exception("Thuispaneel: netwerk uitlezen mislukt")
            await asyncio.sleep(POLL_S)

    # ---- Internet ---------------------------------------------------------------
    async def _latency_once(self) -> float | None:
        """De snelste TCP-verbinding naar een van de doelen, in ms; None als geen lukt."""
        best = None
        for host, port in LATENCY_TARGETS:
            t0 = time.perf_counter()
            try:
                _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), LATENCY_TIMEOUT_S)
            except (OSError, asyncio.TimeoutError):
                continue
            ms = (time.perf_counter() - t0) * 1000
            writer.close()
            best = ms if best is None else min(best, ms)
        return best

    # ---- UniFi ------------------------------------------------------------------
    def _url(self, path: str) -> str:
        return f"https://{self._host}:{self._port}{path}"

    async def _login(self) -> None:
        async with self._session.post(
            self._url("/api/login"),
            json={"username": self._user, "password": self._password, "remember": True},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            if resp.status in (400, 401, 403):
                raise PermissionError("login")
            resp.raise_for_status()
        self._logged_in = True

    async def _get(self, path: str) -> list[dict[str, Any]]:
        for attempt in (1, 2):
            if not self._logged_in:
                await self._login()
            async with self._session.get(
                self._url(f"/api/s/{self._site}{path}"), timeout=aiohttp.ClientTimeout(total=20)
            ) as resp:
                if resp.status == 401 and attempt == 1:
                    self._logged_in = False  # het koekje verlopen: opnieuw inloggen
                    continue
                resp.raise_for_status()
                body = await resp.json(content_type=None)
                return body.get("data") or []
        raise PermissionError("login")

    def _anon(self, mac: str | None) -> str | None:
        if not mac:
            return None
        return hashlib.sha256(self._salt + mac.lower().encode()).hexdigest()[:12]

    async def _poll(self) -> None:
        latency = await self._latency_once()
        self._latency.append((time.time(), latency))
        snap: dict[str, Any] = {"configured": self.configured, "at": time.time()}
        if self.configured:
            try:
                devices, clients, health = await asyncio.gather(
                    self._get("/stat/device"), self._get("/stat/sta"), self._get("/stat/health")
                )
                snap.update(self._build(devices, clients, health))
            except PermissionError:
                snap["error"] = "login"
            except (aiohttp.ClientError, asyncio.TimeoutError) as err:
                snap["error"] = "unreachable"
                _LOGGER.debug("Thuispaneel: UniFi niet bereikbaar: %s", err)
        snap["internet"] = self._internet()
        self._snapshot = snap

    def _internet(self) -> dict[str, Any]:
        pts = list(self._latency)
        ok = [ms for _, ms in pts if ms is not None]
        return {
            "latency": pts[-1][1] if pts else None,
            "avg": sum(ok) / len(ok) if ok else None,
            "loss": (len(pts) - len(ok)) / len(pts) if pts else None,
            "series": [[round(t * 1000), None if ms is None else round(ms, 1)] for t, ms in pts],
        }

    def _build(self, devices: list[dict], clients: list[dict], health: list[dict]) -> dict[str, Any]:
        known = {d.get("mac") for d in devices}
        out_devices = []
        for d in devices:
            uplink = d.get("uplink") or {}
            up_mac = uplink.get("uplink_mac")
            stats = d.get("system-stats") or {}
            radios = []
            for r in d.get("radio_table_stats") or []:
                radios.append(
                    {
                        "band": RADIO_BAND.get(r.get("radio"), r.get("radio")),
                        "channel": _int(r.get("channel")),
                        "load": r.get("cu_total"),
                        "clients": _int(r.get("num_sta") or r.get("user-num_sta")),
                        "satisfaction": r.get("satisfaction"),
                    }
                )
            ports = d.get("port_table") or []
            out_devices.append(
                {
                    "id": self._anon(d.get("mac")),
                    "name": d.get("name") or d.get("model_name") or d.get("model"),
                    "model": d.get("model_name") or d.get("model"),
                    "type": d.get("type"),
                    "ip": d.get("ip"),
                    "online": d.get("state") == 1,
                    "uptime": d.get("uptime"),
                    "clients": d.get("user-num_sta", d.get("num_sta")),
                    "satisfaction": d.get("satisfaction"),
                    "cpu": _num(stats.get("cpu")),
                    "mem": _num(stats.get("mem")),
                    "temperature": d.get("general_temperature"),
                    "uplink": {
                        # een uplink naar iets anders dan UniFi: de router (de KPN Box)
                        "to": self._anon(up_mac) if up_mac in known else "gateway",
                        "type": uplink.get("type"),
                        "speed": uplink.get("speed"),
                        "port": uplink.get("uplink_remote_port"),
                        "signal": uplink.get("signal"),
                    },
                    "radios": radios,
                    "ports": {
                        "up": sum(1 for p in ports if p.get("up")),
                        "total": len(ports),
                        "poe": round(sum(_num(p.get("poe_power")) or 0 for p in ports), 1),
                    }
                    if ports
                    else None,
                }
            )
        out_clients = []
        for c in clients:
            wired = bool(c.get("is_wired"))
            out_clients.append(
                {
                    "id": self._anon(c.get("mac")),
                    "name": c.get("name") or c.get("hostname") or c.get("oui") or "Onbekend",
                    "vendor": c.get("oui"),
                    "ip": c.get("ip"),
                    "wired": wired,
                    "device": self._anon(c.get("sw_mac") if wired else c.get("ap_mac")),
                    "port": _int(c.get("sw_port")) if wired else None,
                    "ssid": None if wired else c.get("essid"),
                    "band": None if wired else RADIO_BAND.get(c.get("radio"), c.get("radio")),
                    "channel": None if wired else _int(c.get("channel")),
                    "signal": None if wired else c.get("signal"),
                    "satisfaction": c.get("satisfaction"),
                    "rx": c.get("rx_rate"),
                    "tx": c.get("tx_rate"),
                    "uptime": c.get("uptime"),
                }
            )
        sub = {h.get("subsystem"): h for h in health}
        wlan, lan = sub.get("wlan") or {}, sub.get("lan") or {}
        return {
            "devices": out_devices,
            "clients": out_clients,
            "health": {
                "wifi_clients": wlan.get("num_user"),
                "wired_clients": lan.get("num_user"),
                "aps": wlan.get("num_ap"),
                "switches": lan.get("num_sw"),
            },
        }

    @property
    def snapshot(self) -> dict[str, Any]:
        return self._snapshot


def _int(v: Any) -> int | None:
    """Een geheel getal van de controller, of None: wat het paneel toont is nooit tekst van buiten."""
    n = _num(v)
    return int(n) if n is not None and math.isfinite(n) else None


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    net = Network(hass, entry)
    hass.data[DATA] = net
    net.start()


async def async_unload_entry(hass: HomeAssistant) -> None:
    net = hass.data.pop(DATA, None)
    if net:
        await net.stop()


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_network)


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "thuispaneel/network"})
@callback
def ws_network(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    net: Network | None = hass.data.get(DATA)
    connection.send_result(msg["id"], net.snapshot if net else {"configured": False, "at": None})
