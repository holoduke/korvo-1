/* Internet: the home network. The UniFi devices (switches, access points) with
 * their uplinks as a topology, the access points' radios, every connected
 * device with its signal and quality, and the internet itself: the latency
 * the thuispaneel integration measures every minute, the provider's router
 * (the KPN Box over UPnP) and the DNS filter (AdGuard) from their Home
 * Assistant entities.
 *
 * The UniFi data comes from the thuispaneel integration (websocket
 * "thuispaneel/network", see ha/custom_components/thuispaneel/network.py),
 * without MAC addresses: a device has an anonymous id that ties a client to
 * its access point or switch. Until the integration has a UniFi login (its
 * options in Home Assistant) the page says how to set it up and shows what
 * it has without one. Panel.network serves the Netwerk layer of the house.
 */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const N = cfg.network || { entities: {}, aps: [] };
  const E = N.entities || {};
  const esc = Util.esc;
  const fmt = Util.fmt;
  const LATENCY = "thuispaneel.latency"; /* its series, kept in Panel.hist for the chart */
  const REFRESH_MS = 60e3;

  let net = null; /* the last answer: {configured, error, at, internet, devices, clients, health} */
  let loadedAt = 0;
  let busy = false;
  const listeners = new Set();

  async function load() {
    if (busy || !Panel.client || !Panel.client.network) return;
    busy = true;
    try {
      net = await Panel.client.network();
      loadedAt = Date.now();
      const series = ((net && net.internet) || {}).series || [];
      Panel.hist[LATENCY] = series.filter(([, v]) => v != null).map(([t, v]) => ({ t, v }));
    } catch (e) {
      net = { configured: false, error: "integration", at: null };
    } finally {
      busy = false;
    }
    render();
    listeners.forEach((fn) => fn());
  }
  const fresh = () => Date.now() - loadedAt < REFRESH_MS / 2;

  /* ---- Reading it ------------------------------------------------------------------- */
  const devices = () => (net && net.devices) || [];
  const clients = () => (net && net.clients) || [];
  const byId = () => new Map(devices().map((d) => [d.id, d]));
  const clientsOf = (id) => clients().filter((c) => c.device === id);
  const isAp = (d) => d.type === "uap";
  const isSwitch = (d) => d.type === "usw";
  /* Quality (UniFi's "satisfaction", 0-100) as the panel's tones. */
  const toneOf = (q) => (!Number.isFinite(q) ? "" : q >= 80 ? "ok" : q >= 50 ? "warn" : "bad");
  /* Wi-Fi signal (dBm) in four steps, as bars. */
  const barsOf = (dbm) => (!Number.isFinite(dbm) ? 0 : dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -72 ? 2 : 1);
  const signalTone = (dbm) => (!Number.isFinite(dbm) ? "" : dbm >= -65 ? "ok" : dbm >= -72 ? "warn" : "bad");
  const mean = (xs) => {
    const v = xs.filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };
  /* kbit/s -> "866 Mbit/s" or "1,2 Gbit/s". */
  const rate = (kbps) => (!Number.isFinite(kbps) || kbps <= 0 ? "--" : kbps >= 1e6 ? `${fmt(kbps / 1e6, 1)} Gbit/s` : `${fmt(Math.round(kbps / 1000))} Mbit/s`);
  const linkSpeed = (mbps) => (!Number.isFinite(mbps) || mbps <= 0 ? "" : mbps >= 1000 ? `${fmt(mbps / 1000, mbps % 1000 ? 1 : 0)} Gbit` : `${mbps} Mbit`);
  /* seconds -> "3 d 4 u", "5 u 12 m", "7 m". */
  function uptime(s) {
    if (!Number.isFinite(s)) return "--";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d} d ${h} u` : h ? `${h} u ${m} m` : `${m} m`;
  }
  /* A rate sensor (B/s, KiB/s, …) in Mbit/s. */
  const RATE_BYTES = { "B/s": 1, "KiB/s": 1024, "kB/s": 1000, "MiB/s": 1048576, "MB/s": 1e6 };
  function mbitOf(id) {
    const s = id && Panel.st(id);
    if (!s || Panel.unavailable(s)) return NaN;
    const unit = (s.attributes || {}).unit_of_measurement;
    const v = parseFloat(s.state);
    if (!Number.isFinite(v)) return NaN;
    if (/bit\/s$/i.test(unit || "")) return v * ({ "bit/s": 1e-6, "kbit/s": 1e-3, "Mbit/s": 1, "Gbit/s": 1e3 }[unit] ?? 1);
    return (v * (RATE_BYTES[unit] ?? 1) * 8) / 1e6;
  }
  const mbitText = (v) => (Number.isFinite(v) ? (v >= 100 ? fmt(Math.round(v)) : fmt(v, v < 10 ? 2 : 1)) : "--");

  /* ---- Rendering --------------------------------------------------------------------- */
  let root = null;
  const q = (sel) => root.querySelector(sel);
  const ui = { filter: "all", sort: "name" };
  let frame = 0;

  function renderInternet() {
    const wan = E.wan && Panel.st(E.wan);
    const up = wan ? wan.state === "on" : null;
    const inet = (net && net.internet) || {};
    const lat = inet.latency;
    const loss = inet.loss;
    const tone = up === false || lat == null && net && net.at ? "bad" : Number.isFinite(lat) && lat > 80 ? "warn" : "ok";
    q(".nw-internet .nw-status").className = `nw-status ${tone}`;
    q(".nw-internet .nw-status").innerHTML =
      `${icon("globe")}<b>${up === false ? "Geen internet" : lat == null && net && net.at ? "Internet onbereikbaar" : "Online"}</b>` +
      `<span>${Number.isFinite(lat) ? `${fmt(Math.round(lat))} ms` : "--"}</span>`;
    q(".nw-internet .nw-facts").innerHTML =
      `<span>Gemiddeld <b>${Number.isFinite(inet.avg) ? `${fmt(Math.round(inet.avg))} ms` : "--"}</b></span>` +
      `<span>Uitval <b>${Number.isFinite(loss) ? `${fmt(loss * 100, loss && loss < 0.1 ? 1 : 0)}%` : "--"}</b></span>` +
      `<span>${icon("arrow-down")} <b>${mbitText(mbitOf(E.down))}</b> Mbit/s</span>` +
      `<span>${icon("arrow-up")} <b>${mbitText(mbitOf(E.up))}</b> Mbit/s</span>`;
    drawLatency();
  }
  function drawLatency() {
    const canvas = q(".nw-internet canvas");
    const pts = Panel.hist[LATENCY] || [];
    if (!pts.length) {
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      q(".nw-internet .nw-chart-title").textContent = "Vertraging, ms";
      return;
    }
    const { spanH } = Panel.drawChart(canvas, {
      left: { id: LATENCY, colour: Panel.cssVar("--accent"), range: (vals) => [0, Math.max(40, Math.ceil((Util.minMax(vals)[1] * 1.2) / 10) * 10)], fmt: (v) => fmt(Math.round(v)), hold: 3 * 60e3 },
    }, 1);
    q(".nw-internet .nw-chart-title").textContent = `Vertraging in ms, laatste ${spanH} uur`;
  }

  function renderSummary() {
    const wifi = clients().filter((c) => !c.wired);
    const wired = clients().filter((c) => c.wired);
    const aps = devices().filter(isAp);
    const quality = mean(wifi.map((c) => c.satisfaction));
    const dns = Panel.num(E.dnsQueries);
    const blocked = Panel.num(E.dnsBlocked);
    const dnsMs = Panel.num(E.dnsSpeed);
    const stat = (value, label, tone) => `<div class="nw-stat ${tone || ""}"><b>${value}</b><span>${label}</span></div>`;
    q(".nw-summary .nw-stats").innerHTML =
      stat(net && net.devices ? fmt(wifi.length) : "--", "via wifi") +
      stat(net && net.devices ? fmt(wired.length) : "--", "via kabel") +
      stat(aps.length ? `${aps.filter((d) => d.online).length}/${aps.length}` : "--", "access points", aps.some((d) => !d.online) ? "bad" : "") +
      stat(Number.isFinite(quality) ? `${Math.round(quality)}%` : "--", "wifi-kwaliteit", toneOf(quality));
    q(".nw-summary .nw-dns").innerHTML =
      `${icon("shield")}<span>DNS-filter</span>` +
      `<b>${Number.isFinite(dns) ? fmt(dns) : "--"}</b><span>vragen</span>` +
      `<b>${Number.isFinite(blocked) ? `${fmt(blocked, 1)}%` : "--"}</b><span>geblokkeerd</span>` +
      `<b>${Number.isFinite(dnsMs) ? `${fmt(dnsMs, 1)} ms` : "--"}</b><span>per vraag</span>`;
  }

  /* The topology: the internet, the router, then each device under what it
   * hangs from, as columns joined by lines (drawn once the boxes are placed). */
  function renderTopology() {
    const box = q(".nw-topo-body");
    if (!devices().length) {
      box.innerHTML = `<div class="nw-empty">${setupText()}</div>`;
      return;
    }
    const ids = byId();
    const level = new Map();
    const depth = (d, seen = new Set()) => {
      if (level.has(d.id)) return level.get(d.id);
      const to = d.uplink && d.uplink.to;
      const lv = to && to !== "gateway" && ids.has(to) && !seen.has(to) ? depth(ids.get(to), new Set([...seen, d.id])) + 1 : 0;
      level.set(d.id, lv);
      return lv;
    };
    devices().forEach((d) => depth(d));
    const cols = [];
    devices()
      .slice()
      .sort((a, b) => (isSwitch(b) - isSwitch(a)) || String(a.name).localeCompare(String(b.name), "nl"))
      .forEach((d) => (cols[level.get(d.id)] = cols[level.get(d.id)] || []).push(d));
    const node = (key, ic, name, sub, tone, extra = "") =>
      `<div class="nw-node ${tone || ""}" data-node="${esc(key)}">${icon(ic)}<span class="nw-node-text"><b>${esc(name)}</b><span>${sub}</span></span>${extra}</div>`;
    const wan = E.wan && Panel.st(E.wan);
    const gatewayTone = wan && wan.state !== "on" ? "bad" : "";
    const inet = (net && net.internet) || {};
    const devNode = (d) => {
      const n = clientsOf(d.id).length;
      const up = d.uplink || {};
      const link = up.type === "wireless" ? `mesh ${Number.isFinite(up.signal) ? `${up.signal} dBm` : ""}` : linkSpeed(up.speed);
      const sub = [isAp(d) ? `${n} apparaten` : isSwitch(d) && d.ports ? `${d.ports.up}/${d.ports.total} poorten` : d.model, link].filter(Boolean).join(" · ");
      const tone = `${d.online ? toneOf(d.satisfaction) : "bad"}${up.type === "wireless" ? " mesh" : ""}`;
      return node(d.id, isAp(d) ? "ap" : isSwitch(d) ? "switch" : "router", d.name, esc(sub), tone, `<span class="nw-parent" hidden>${esc(up.to || "")}</span>`);
    };
    box.innerHTML =
      `<svg class="nw-lines" aria-hidden="true"></svg>` +
      `<div class="nw-col">${node("internet", "globe", "Internet", Number.isFinite(inet.latency) ? `${fmt(Math.round(inet.latency))} ms` : "--", inet.latency == null && net && net.at ? "bad" : "")}</div>` +
      `<div class="nw-col">${node("gateway", "router", "KPN Box", wan ? (wan.state === "on" ? "verbonden" : "geen verbinding") : "router", gatewayTone, `<span class="nw-parent" hidden>internet</span>`)}</div>` +
      cols.map((col) => `<div class="nw-col">${col.map(devNode).join("")}</div>`).join("");
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(drawLines);
  }
  function drawLines() {
    if (!root) return;
    const box = q(".nw-topo-body");
    const svg = box.querySelector(".nw-lines");
    if (!svg) return;
    const at = box.getBoundingClientRect();
    const place = (el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - at.left + box.scrollLeft, r: r.right - at.left + box.scrollLeft, y: r.top - at.top + r.height / 2 };
    };
    const nodes = new Map([...box.querySelectorAll("[data-node]")].map((el) => [el.dataset.node, el]));
    let paths = "";
    nodes.forEach((el) => {
      const parentKey = (el.querySelector(".nw-parent") || {}).textContent;
      const parent = parentKey && nodes.get(parentKey);
      if (!parent) return;
      const a = place(parent), b = place(el);
      const mid = (a.r + b.l) / 2;
      const wireless = el.classList.contains("mesh");
      paths += `<path class="${wireless ? "mesh" : ""}" d="M${a.r} ${a.y} C${mid} ${a.y} ${mid} ${b.y} ${b.l} ${b.y}"/>`;
    });
    svg.setAttribute("width", box.scrollWidth);
    svg.setAttribute("height", box.scrollHeight);
    svg.innerHTML = paths;
  }

  function renderAps() {
    const aps = devices().filter(isAp).sort((a, b) => String(a.name).localeCompare(String(b.name), "nl"));
    q(".nw-aps").hidden = !aps.length;
    q(".nw-aps .dc-grid").innerHTML = aps
      .map((d) => {
        const n = clientsOf(d.id).length;
        const tone = d.online ? toneOf(d.satisfaction) : "bad";
        /* per radio: its band, channel, how busy the channel is (UniFi's channel utilisation) and its devices */
        const radios = (d.radios || [])
          .map((r) => {
            const load = Number.isFinite(r.load) ? r.load : null;
            const busy = load == null ? "" : load > 60 ? "bad" : load > 40 ? "warn" : "ok";
            return (
              `<li><div class="nw-radio-head"><b>${esc(r.band || "")}</b><span>kanaal <b>${esc(r.channel ?? "--")}</b></span><span><b>${esc(r.clients ?? 0)}</b> app.</span></div>` +
              `<div class="nw-load ${busy}"><i style="width:${load ?? 0}%"></i><span>${load == null ? "belasting onbekend" : `${load}% belast`}</span></div></li>`
            );
          })
          .join("");
        return (
          `<article class="dc-panel nw-ap ${tone}" data-ap="${esc(d.id)}">` +
          `<header>${icon("ap")}<b>${esc(d.name)}</b></header>` +
          `<div class="nw-ap-facts"><span class="nw-q ${tone}">${d.online ? (Number.isFinite(d.satisfaction) ? `${d.satisfaction}%` : "online") : "offline"}</span><span><b>${n}</b> apparaten</span><span>aan <b>${uptime(d.uptime)}</b></span>${Number.isFinite(d.temperature) ? `<span><b>${fmt(d.temperature, 0)}°</b></span>` : ""}</div>` +
          (radios ? `<ul class="nw-radios">${radios}</ul>` : "") +
          `</article>`
        );
      })
      .join("");
  }

  function renderClients() {
    const ids = byId();
    const aps = devices().filter(isAp);
    const chips = [["all", "Alle"], ["wifi", "Wifi"], ["wired", "Kabel"], ...aps.map((d) => [d.id, d.name])];
    if (!chips.some(([k]) => k === ui.filter)) ui.filter = "all";
    const list = clients()
      .filter((c) => (ui.filter === "all" ? true : ui.filter === "wifi" ? !c.wired : ui.filter === "wired" ? c.wired : c.device === ui.filter))
      .sort((a, b) =>
        ui.sort === "quality"
          ? (Number.isFinite(a.satisfaction) ? a.satisfaction : 101) - (Number.isFinite(b.satisfaction) ? b.satisfaction : 101) || a.name.localeCompare(b.name, "nl")
          : a.name.localeCompare(b.name, "nl")
      );
    q(".nw-clients .dc-title").textContent = `Apparaten${clients().length ? ` · ${clients().length}` : ""}`;
    q(".nw-filter").innerHTML =
      chips.map(([k, l]) => `<button class="chip nw-chip${ui.filter === k ? " active" : ""}" data-nw-filter="${esc(k)}">${esc(l)}</button>`).join("") +
      `<button class="chip nw-chip nw-sort" data-nw-sort>${icon("list")}${ui.sort === "quality" ? "Slechtste eerst" : "Op naam"}</button>`;
    q(".nw-list").innerHTML = list.length
      ? list
          .map((c) => {
            const via = ids.get(c.device);
            const where = c.wired
              ? `${via ? esc(via.name) : "Kabel"}${c.port ? ` · poort ${esc(c.port)}` : ""}`
              : `${via ? esc(via.name) : "Wifi"}${c.band ? ` · ${esc(c.band)}` : ""}${c.ssid ? ` · ${esc(c.ssid)}` : ""}`;
            const bars = barsOf(c.signal);
            const signal = c.wired
              ? `<span class="nw-signal">${icon("cable")}</span>`
              : `<span class="nw-signal ${signalTone(c.signal)}" title="${Number.isFinite(c.signal) ? `${c.signal} dBm` : ""}"><i class="${bars >= 1 ? "on" : ""}"></i><i class="${bars >= 2 ? "on" : ""}"></i><i class="${bars >= 3 ? "on" : ""}"></i><i class="${bars >= 4 ? "on" : ""}"></i><em>${Number.isFinite(c.signal) ? `${c.signal}` : "--"}</em></span>`;
            return (
              `<li class="nw-client">` +
              `<span class="nw-c-icon">${icon(c.wired ? "cable" : "wifi")}</span>` +
              `<span class="nw-c-name"><b>${esc(c.name)}</b><span>${esc([c.ip, c.vendor && c.vendor !== c.name ? c.vendor : null].filter(Boolean).join(" · "))}</span></span>` +
              `<span class="nw-c-via">${where}</span>` +
              signal +
              `<span class="nw-q ${toneOf(c.satisfaction)}">${Number.isFinite(c.satisfaction) ? `${c.satisfaction}%` : "--"}</span>` +
              `<span class="nw-c-rate">${c.wired ? "" : `${rate(c.rx)}`}</span>` +
              `</li>`
            );
          })
          .join("")
      : `<li class="nw-empty">${net && net.devices ? "Geen apparaten" : setupText()}</li>`;
  }

  function setupText() {
    if (!net || !net.at) return "Het netwerk wordt opgehaald…";
    if (net.error === "integration") return "De thuispaneel-integratie in Home Assistant geeft geen netwerk door (is ze bijgewerkt en herstart?).";
    if (!net.configured)
      return "UniFi is nog niet gekoppeld. In Home Assistant: Instellingen › Apparaten en diensten › Thuispaneel › Configureren, met het adres van de controller en een (bij voorkeur alleen-lezen) account.";
    if (net.error === "login") return "Inloggen bij UniFi lukt niet: controleer de gebruikersnaam en het wachtwoord bij Thuispaneel › Configureren.";
    if (net.error === "unreachable") return "De UniFi-controller is niet bereikbaar.";
    return "Nog geen gegevens van UniFi.";
  }

  function render() {
    if (!root) return;
    renderInternet();
    renderSummary();
    renderTopology();
    renderAps();
    renderClients();
    const note = q(".nw-note");
    const problem = net && net.at && (!net.configured || net.error);
    note.hidden = !problem;
    if (problem) note.textContent = setupText();
  }

  function build(page) {
    root = page.querySelector(".dc-page");
    root.innerHTML =
      `<div class="nw-note" hidden></div>` +
      `<div class="en-row nw-row">` +
      `<section class="dc-panel nw-internet"><h2 class="dc-title">Internet</h2><div class="nw-status"></div><div class="nw-facts"></div>` +
      `<h3 class="nw-chart-title">Vertraging, ms</h3><div class="en-chart"><canvas></canvas></div></section>` +
      `<section class="dc-panel nw-summary"><h2 class="dc-title">Thuisnetwerk</h2><div class="nw-stats"></div><div class="nw-dns"></div></section>` +
      `</div>` +
      `<section class="dc-panel nw-topo"><h2 class="dc-title">Topologie</h2><div class="nw-topo-body"></div></section>` +
      `<section class="dc-group nw-aps" hidden><h2 class="dc-title">Access points</h2><div class="dc-grid"></div></section>` +
      `<section class="dc-panel nw-clients"><h2 class="dc-title">Apparaten</h2><div class="nw-filter"></div><ul class="nw-list"></ul></section>`;
    root.addEventListener("click", (e) => {
      const f = e.target.closest("[data-nw-filter]");
      if (f) {
        ui.filter = f.dataset.nwFilter;
        renderClients();
      }
      if (e.target.closest("[data-nw-sort]")) {
        ui.sort = ui.sort === "name" ? "quality" : "name";
        renderClients();
      }
    });
    new ResizeObserver(() => {
      drawLatency();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(drawLines);
    }).observe(root);
    Panel.track([E.wan, E.down, E.up, E.dnsQueries, E.dnsBlocked, E.dnsSpeed].filter(Boolean), Panel.whenShown("network", () => (renderInternet(), renderSummary())));
  }

  Panel.definePage("network", { className: "network-page", html: () => `<div id="networkPage" class="dc-page"></div>`, build });

  Panel.on("section", (i) => {
    if (cfg.sections[i].kind !== "network") return;
    render();
    if (Panel.isLoaded() && !fresh()) load();
  });
  Panel.on("loaded", () => load());
  Panel.everyAwake(REFRESH_MS, () => Panel.isLoaded() && (Panel.onScreen("network") || listeners.size) && load());

  /* For the house's Netwerk layer: the access points where they hang, with
   * their devices and quality. */
  Panel.network = {
    load: () => (fresh() ? Promise.resolve() : load()),
    listen: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    /* [{floor, room, name, clients, quality, online, tone}] for the APs placed in PANEL_NETWORK_APS */
    aps() {
      const found = devices().filter(isAp);
      return (N.aps || [])
        .map((place) => {
          const d = found.find((x) => String(x.name).toLowerCase() === place.name.toLowerCase());
          if (!d) return null;
          const wifi = clientsOf(d.id);
          const quality = Number.isFinite(d.satisfaction) ? d.satisfaction : mean(wifi.map((c) => c.satisfaction));
          return { ...place, clients: wifi.length, quality, online: d.online, tone: d.online ? toneOf(quality) || "ok" : "bad" };
        })
        .filter(Boolean);
    },
    configured: () => !!(net && net.configured && !net.error),
  };
})();
